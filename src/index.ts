/**
 * Hono app: /geoserver WFS routes, param normalization, request dispatch.
 * Port of sota_wfs/app.py.
 */
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { LAYERS, qname, resolveTypename } from "./data/types";
import { getManifest } from "./data/manifest";
import { tileKeysForBbox } from "./data/tiling";
import { getFullDataset, getRecordsFromTiles } from "./data/reader";
import { getByKey } from "./data/full-cache";
import {
  WfsError,
  parseBbox,
  filterByBbox,
  resolveProperties,
  select,
  summitGeojson,
  type GeoJsonFeature,
} from "./wfs/getfeature";
import { capabilitiesXml, describeFeatureTypeXml, exceptionXml, type LayerInfo } from "./wfs/capabilities";
import { featuresForBbox, downloadGeojson } from "./az/serving";
import { AzQueueDO } from "./az/queue-do";
import scheduled from "./scheduled";

export { AzQueueDO };

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors({ origin: "*" }));

function xml(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/xml" } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function json(body: unknown, status = 200, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": contentType } });
}

function errorResponse(exc: WfsError): Response {
  return xml(exceptionXml(exc.code, exc.message, exc.locator), 400);
}

function baseUrlOf(req: Request): string {
  return new URL(req.url).origin;
}

function lowerParams(query: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(query)) out.set(k.toLowerCase(), v);
  return out;
}

async function handleGetCapabilities(env: Env, params: Map<string, string>, baseUrl: string): Promise<Response> {
  const version =
    params.get("version") ?? params.get("acceptversions")?.split(",")[0] ?? "2.0.0";
  const layerInfos: LayerInfo[] = [];
  for (const layer of Object.values(LAYERS)) {
    const entry = await getManifest(env.DATA, layer.prefix);
    if (entry) layerInfos.push({ layer, bbox: entry.manifest.bbox });
  }
  return xml(capabilitiesXml(version.trim(), layerInfos, baseUrl));
}

function typenameParam(params: Map<string, string>): string {
  const raw = params.get("typenames") ?? params.get("typename");
  if (!raw) throw new WfsError("MissingParameterValue", "typeNames parameter is required", "typeNames");
  return raw;
}

function resolveLayer(raw: string) {
  const layer = resolveTypename(raw);
  if (!layer) throw new WfsError("InvalidParameterValue", `Unknown type name: ${raw}`, "typeNames");
  return layer;
}

async function handleGetFeature(
  env: Env,
  params: Map<string, string>,
  baseUrl: string,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  const layer = resolveLayer(typenameParam(params));
  const outFmt = params.get("outputformat") ?? "application/json";
  if (!outFmt.toLowerCase().includes("json")) {
    throw new WfsError(
      "InvalidParameterValue",
      `Only GeoJSON output is supported, got ${JSON.stringify(outFmt)}`,
      "outputFormat",
    );
  }

  const manifestEntry = await getManifest(env.DATA, layer.prefix);
  if (!manifestEntry) {
    throw new WfsError("NoApplicableCode", `Data for ${qname(layer)} not yet fetched`);
  }
  const { version, manifest } = manifestEntry;

  const bboxRaw = params.get("bbox");
  const bbox = bboxRaw ? parseBbox(bboxRaw) : null;
  const tileKeys = bbox ? tileKeysForBbox(bbox, manifest.tileDegrees) : null;

  let tileRecords;
  if (bbox && tileKeys) {
    tileRecords = await getRecordsFromTiles(env.DATA, layer.prefix, version, tileKeys);
  } else if (manifest.hasFullBlob) {
    // No BBOX, or one wide enough that reading every overlapping tile would
    // cost more than the whole dataset — real CalTopo traffic always sends
    // a tight BBOX (see README), so this only serves tests/manual queries
    // against layers small enough to have a full blob.
    tileRecords = await getFullDataset(env.DATA, layer.prefix, version);
  } else {
    throw new WfsError(
      "InvalidParameterValue",
      bbox ? "BBOX spans too many tiles for this layer; narrow your view" : "BBOX is required for this layer",
      "bbox",
    );
  }
  const matched = bbox ? filterByBbox(tileRecords, bbox) : tileRecords;

  const propNames = resolveProperties(
    manifest.columns,
    params.get("propertyname") ?? params.get("propertynames"),
  );

  const countRaw = params.get("count") ?? params.get("maxfeatures");
  let count: number | null = null;
  if (countRaw) {
    const n = Number(countRaw);
    if (!Number.isInteger(n)) {
      throw new WfsError("InvalidParameterValue", `Malformed count: ${JSON.stringify(countRaw)}`, "count");
    }
    count = n;
  }

  let azFeatures: GeoJsonFeature[] = [];
  if (layer.name === "SOTA_Summits" && bbox) {
    azFeatures = await featuresForBbox(env.AZ_CACHE, matched, bbox, baseUrl, (items) => {
      const stub = env.AZ_QUEUE.get(env.AZ_QUEUE.idFromName("global"));
      waitUntil(stub.enqueue(items));
    });
  }

  const fc = select(layer, matched, propNames, count, baseUrl, azFeatures);
  return json(fc);
}

async function handleDescribeFeatureType(
  env: Env,
  params: Map<string, string>,
): Promise<Response> {
  const raw = params.get("typenames") ?? params.get("typename");
  const layer = raw ? resolveLayer(raw) : Object.values(LAYERS)[0]!;
  const manifestEntry = await getManifest(env.DATA, layer.prefix);
  const columns = manifestEntry ? manifestEntry.manifest.columns : [];
  return xml(describeFeatureTypeXml(layer, columns));
}

async function wfsHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
  const params = lowerParams(c.req.query());
  const req = (params.get("request") ?? "").toLowerCase();
  const baseUrl = baseUrlOf(c.req.raw);
  try {
    if (req === "getcapabilities") return await handleGetCapabilities(c.env, params, baseUrl);
    if (req === "getfeature") {
      return await handleGetFeature(c.env, params, baseUrl, (p) => c.executionCtx.waitUntil(p));
    }
    if (req === "describefeaturetype") return await handleDescribeFeatureType(c.env, params);
    throw new WfsError(
      req ? "OperationNotSupported" : "MissingParameterValue",
      `Unsupported request: ${params.get("request") ?? "(missing)"}`,
      "request",
    );
  } catch (err) {
    if (err instanceof WfsError) return errorResponse(err);
    throw err;
  }
}

app.get("/wfs", wfsHandler);
app.get("/geoserver/wfs", wfsHandler);
app.get("/geoserver/:ns/wfs", wfsHandler);

app.get("/az/:refExt", async (c) => {
  const refExt = c.req.param("refExt");
  if (!refExt.endsWith(".geojson")) return c.notFound();
  const ref = refExt.slice(0, -".geojson".length);
  const code = ref.replace(/_/g, "/"); // SOTA refs hold exactly one slash, no underscores
  const layer = LAYERS.sota_summits!;
  const manifestEntry = await getManifest(c.env.DATA, layer.prefix);
  if (!manifestEntry) return text("Summit data not yet fetched", 503);
  const record = await getByKey(c.env.DATA, layer.prefix, manifestEntry.version, code);
  const fc = record
    ? await downloadGeojson(c.env.AZ_CACHE, code, record, baseUrlOf(c.req.raw))
    : null;
  if (!fc) return text(`No cached activation zone for ${ref}`, 404);
  return new Response(JSON.stringify(fc), {
    status: 200,
    headers: {
      "Content-Type": "application/geo+json",
      "Content-Disposition": `attachment; filename="${ref}_az.geojson"`,
    },
  });
});

app.get("/summit/:refExt", async (c) => {
  const refExt = c.req.param("refExt");
  if (!refExt.endsWith(".geojson")) return c.notFound();
  const ref = refExt.slice(0, -".geojson".length);
  const code = ref.replace(/_/g, "/");
  const layer = LAYERS.sota_summits!;
  const manifestEntry = await getManifest(c.env.DATA, layer.prefix);
  if (!manifestEntry) return text("Summit data not yet fetched", 503);
  const record = await getByKey(c.env.DATA, layer.prefix, manifestEntry.version, code);
  if (!record) return text(`No summit ${code}`, 404);
  const fc = summitGeojson(record, baseUrlOf(c.req.raw));
  return new Response(JSON.stringify(fc), {
    status: 200,
    headers: {
      "Content-Type": "application/geo+json",
      "Content-Disposition": `attachment; filename="${ref}_summit.geojson"`,
    },
  });
});

export default {
  fetch: app.fetch,
  scheduled,
};
