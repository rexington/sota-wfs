import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseSota } from "../src/data/sota";
import { publishLayerVersion } from "../src/data/manifest";
import { LAYERS } from "../src/data/types";

const FIXTURE_CSV = `SOTA Summits List (Date=01/08/2026)
SummitCode,AssociationName,RegionName,SummitName,AltM,AltFt,GridRef1,GridRef2,Longitude,Latitude,Points,BonusPoints,ValidFrom,ValidTo,ActivationCount,ActivationDate,ActivationCall
4O/IC-001,Montenegro,Istok Crne Gore,Maja Rosit,2524,8280,19.8505,42.4795,19.85050,42.47950,10,3,01/03/2019,31/12/2099,1,27/07/2022,4O/SQ9MDF/P
W6/NC-001,USA,California Nevada County,Mount Lola,2774,9101,-120.5217,39.4337,-120.52170,39.43370,10,3,01/07/2010,31/12/2099,42,01/01/2024,N0CALL
W6/NC-002,USA,California Nevada County,Castle Peak,2775,9103,-120.3517,39.3657,-120.35170,39.36570,10,3,01/07/2010,31/12/2099,0,,
3Y/BV-001,Bouvet Island,Bouvetoya,Olavtoppen,780,2559,3.3565,-54.4104,3.35650,-54.41040,10,3,01/03/2018,31/12/2099,0,,
W6/CC-067,USA - California,Coastal Ranges,Oyster Point,642,2106,-121.8777,37.8305,-121.87770,37.83050,1,0,01/07/2009,31/07/2012,0,,
W6/XX-999,USA - California,Nowhere Yet,Future Peak,1000,3281,-120.0000,38.0000,-120.00000,38.00000,1,0,01/01/2099,31/12/2099,0,,
`;

const SOTA_POINT_COLORS: Record<number, string> = {
  1: "#4D7A20",
  2: "#6DA536",
  4: "#AEA727",
  6: "#EFA818",
  8: "#DC5D04",
  10: "#C8101E",
};

const CALTOPO_TEMPLATE =
  "http://localhost/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature" +
  "&BBOX={bbox}&OUTPUTFORMAT=application/json&TYPENAMES=sota:SOTA_Summits";

function caltopoUrl(bbox: string, extra = ""): string {
  return CALTOPO_TEMPLATE.replace("{bbox}", bbox) + extra;
}

async function getJson(url: string): Promise<any> {
  const resp = await exports.default.fetch(url);
  expect(resp.status, await resp.clone().text()).toBe(200);
  return resp.json();
}

beforeEach(async () => {
  const layer = LAYERS.sota_summits!;
  const { records, columns } = parseSota(FIXTURE_CSV, { minRows: 0 });
  await publishLayerVersion(env.DATA, layer.prefix, records, columns, {
    keyProp: layer.keyProp,
    tryFullBlob: true, // small fixture: exercise the full-blob/no-BBOX path
  });
});

it("shapes GetFeature the way CalTopo's saved layer expects", async () => {
  const fc = await getJson(
    caltopoUrl(
      "42.47,19.84,42.50,19.86",
      "&PROPERTYNAME=SummitCode,SummitName,Points,BonusPoints,Activations,SOTLAS,the_geom",
    ),
  );
  expect(fc.totalFeatures).toBe(1);
  const feat = fc.features[0];
  expect(feat.geometry_name).toBe("the_geom");
  expect(feat.geometry.coordinates).toEqual([19.8505, 42.4795]);
  expect(feat.properties).toEqual({
    SummitCode: "4O/IC-001",
    SummitName: "Maja Rosit",
    Points: 10,
    BonusPoints: 3,
    Activations: "1",
    SOTLAS: "https://sotl.as/summits/4O/IC-001",
    title: "Maja Rosit", // served even when not in PROPERTYNAME
    "marker-color": SOTA_POINT_COLORS[10], // served even when not in PROPERTYNAME
    "marker-symbol": "circle-10",
    GeoJSON: "http://localhost/summit/4O_IC-001.geojson",
  });
});

it("serves all properties with the right JSON types", async () => {
  const fc = await getJson(caltopoUrl("42.47,19.84,42.50,19.86"));
  const props = fc.features[0].properties;
  // 17 CSV + title, SOTLAS, Activations, marker-color, marker-symbol, GeoJSON
  expect(Object.keys(props)).toHaveLength(23);
  expect(props.AltM).toBe(2524); // int
  expect(props.GridRef1).toBe(19.8505); // float
  expect(props.Activations).toBe("1"); // string (the CAST parity)
  expect(props.ActivationCount).toBe(1); // int
});

it("accepts lat-first, CRS84 lon-first, and the out-of-range fallback", async () => {
  const latFirst = await getJson(caltopoUrl("39.0,-121.0,40.0,-120.0"));
  expect(latFirst.totalFeatures).toBe(2);
  const crs84 = await getJson(caltopoUrl("-121.0,39.0,-120.0,40.0,urn:ogc:def:crs:OGC:1.3:CRS84"));
  expect(crs84.totalFeatures).toBe(2);
  // heuristic: |lat| > 90 in lat-first slots -> reinterpret as lon-first
  const fallback = await getJson(caltopoUrl("-121.0,39.0,-120.0,40.0"));
  expect(fallback.totalFeatures).toBe(2);
});

it("returns an empty collection for a non-matching bbox", async () => {
  const fc = await getJson(caltopoUrl("0.0,0.0,1.0,1.0"));
  expect(fc.features).toEqual([]);
  expect(fc.totalFeatures).toBe(0);
});

it("returns everything with no BBOX, and honors count limits", async () => {
  let fc = await getJson("http://localhost/geoserver/wfs?service=wfs&request=getfeature&typename=sota:SOTA_Summits");
  expect(fc.totalFeatures).toBe(4);
  fc = await getJson(
    "http://localhost/geoserver/wfs?service=wfs&request=getfeature&typename=sota:SOTA_Summits&maxFeatures=2",
  );
  expect(fc.numberReturned).toBe(2);
  expect(fc.numberMatched).toBe(4);
});

it("omits summits outside their ValidFrom/ValidTo window", async () => {
  const fc = await getJson(
    "http://localhost/geoserver/wfs?service=wfs&request=getfeature&typename=sota:SOTA_Summits",
  );
  const codes = new Set(fc.features.map((f: any) => f.properties.SummitCode));
  expect(codes.has("W6/CC-067")).toBe(false); // retired 31/07/2012
  expect(codes.has("W6/XX-999")).toBe(false); // not valid until 2099
});

describe("activation zone polygons", () => {
  const ring = [
    [19.849, 42.478],
    [19.852, 42.478],
    [19.852, 42.481],
    [19.849, 42.478],
  ];

  it("rides along with the summit only when the view is zoomed in", async () => {
    await env.AZ_CACHE.put("az:4O/IC-001", JSON.stringify({ ok: true, ring }));

    const zoomedIn = await getJson(caltopoUrl("42.47,19.84,42.50,19.86"));
    expect(zoomedIn.totalFeatures).toBe(2);
    const byId = Object.fromEntries(zoomedIn.features.map((f: any) => [f.id, f]));
    const poly = byId["SOTA_Summits.az-4O_IC-001"];
    expect(poly.geometry.type).toBe("Polygon");
    expect(poly.properties.SummitName).toBe("Maja Rosit AZ");
    expect(poly.properties.fill).toBe("#FFAA00");
    expect(poly.properties.GeoJSON).toBe("http://localhost/az/4O_IC-001.geojson");

    const zoomedOut = await getJson(caltopoUrl("42.0,19.0,43.0,20.0"));
    expect(zoomedOut.features.map((f: any) => f.geometry.type)).toEqual(["Point"]);

    await env.AZ_CACHE.put("az:4O/IC-001", JSON.stringify({ ok: false, error: "x" }));
    const afterFailure = await getJson(caltopoUrl("42.47,19.84,42.50,19.86"));
    expect(afterFailure.totalFeatures).toBe(1);
  });

  it("downloads a cached AZ ring as a standalone FeatureCollection", async () => {
    await env.AZ_CACHE.put("az:4O/IC-001", JSON.stringify({ ok: true, ring }));

    const resp = await exports.default.fetch("http://localhost/az/4O_IC-001.geojson");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/geo+json");
    expect(resp.headers.get("Content-Disposition")).toContain('filename="4O_IC-001_az.geojson"');
    const fc = await resp.json<any>();
    expect(fc.name).toBe("Maja Rosit - AZ");
    const feat = fc.features[0];
    expect(feat.geometry.coordinates).toEqual([ring]);
    expect(feat.properties.title).toBe("Maja Rosit - AZ");
    expect(feat.properties.name).toBe("Maja Rosit - AZ");
    expect(feat.properties.SummitName).toBe("Maja Rosit AZ");

    // unknown summit and uncached AZ both 404
    expect((await exports.default.fetch("http://localhost/az/ZZ_XX-000.geojson")).status).toBe(404);
    expect((await exports.default.fetch("http://localhost/az/W6_NC-001.geojson")).status).toBe(404);
  });

  // Mount Lola (W6/NC-001) and Castle Peak (W6/NC-002) both fall inside
  // this bbox, so a single request has to resolve two AZ cache entries in
  // one go — exercising the KV array-form get(keys[], "json") bulk read
  // (untested by every other case here, which only ever seeds one ref).
  const twoSummitBbox = "39.30,-120.60,39.50,-120.30";

  it("resolves multiple cached AZ rings from one bulk KV read", async () => {
    const ring2 = [
      [-120.53, 39.43],
      [-120.51, 39.43],
      [-120.51, 39.44],
      [-120.53, 39.43],
    ];
    const ring3 = [
      [-120.36, 39.36],
      [-120.34, 39.36],
      [-120.34, 39.37],
      [-120.36, 39.36],
    ];
    await env.AZ_CACHE.put("az:W6/NC-001", JSON.stringify({ ok: true, ring: ring2 }));
    await env.AZ_CACHE.put("az:W6/NC-002", JSON.stringify({ ok: true, ring: ring3 }));

    const fc = await getJson(caltopoUrl(twoSummitBbox));
    expect(fc.totalFeatures).toBe(4); // 2 summit points + 2 AZ polygons
    const polyIds = fc.features
      .filter((f: any) => f.geometry.type === "Polygon")
      .map((f: any) => f.id)
      .sort();
    expect(polyIds).toEqual(["SOTA_Summits.az-W6_NC-001", "SOTA_Summits.az-W6_NC-002"]);
  });

  it("batches multiple cache misses into a single enqueue call", async () => {
    // Not relying on cross-test storage isolation here: guarantee both
    // refs are genuinely uncached, regardless of what an earlier test wrote.
    await env.AZ_CACHE.delete("az:W6/NC-001");
    await env.AZ_CACHE.delete("az:W6/NC-002");

    const fc = await getJson(caltopoUrl(twoSummitBbox));
    expect(fc.features.every((f: any) => f.geometry.type === "Point")).toBe(true);

    const id = env.AZ_QUEUE.idFromName("global");
    const stub = env.AZ_QUEUE.get(id);
    const pendingRefs = await runInDurableObject(stub, async (_instance, state) => {
      const pending = (await state.storage.get<{ ref: string }[]>("pending")) ?? [];
      return pending.map((p) => p.ref).sort();
    });
    expect(pendingRefs).toEqual(["W6/NC-001", "W6/NC-002"]);
  });
});

it("downloads a summit as a standalone FeatureCollection", async () => {
  const resp = await exports.default.fetch("http://localhost/summit/4O_IC-001.geojson");
  expect(resp.status).toBe(200);
  expect(resp.headers.get("Content-Type")).toBe("application/geo+json");
  expect(resp.headers.get("Content-Disposition")).toContain('filename="4O_IC-001_summit.geojson"');
  const fc = await resp.json<any>();
  expect(fc.name).toBe("Maja Rosit");
  const feat = fc.features[0];
  expect(feat.geometry.coordinates).toEqual([19.8505, 42.4795]);
  expect(feat.properties.title).toBe("Maja Rosit");
  expect(feat.properties.name).toBe("Maja Rosit");
  expect(feat.properties.SummitCode).toBe("4O/IC-001");
  expect(feat.properties["marker-symbol"]).toBe("circle-10");
  expect(feat.properties.GeoJSON).toBe("http://localhost/summit/4O_IC-001.geojson");

  expect((await exports.default.fetch("http://localhost/summit/ZZ_XX-000.geojson")).status).toBe(404);
});

it("is case-insensitive on params and works on all three route shapes", async () => {
  for (const url of [
    "http://localhost/geoserver/wfs?SeRvIcE=WFS&ReQuEsT=GetFeature&TyPeNaMe=SOTA_Summits",
    "http://localhost/geoserver/sota/wfs?service=WFS&request=GetFeature&typenames=foo:sota_summits",
    "http://localhost/wfs?service=WFS&request=GetFeature&typename=sota:SOTA_Summits",
  ]) {
    const fc = await getJson(url);
    expect(fc.totalFeatures).toBe(4);
  }
});

it("serves both capabilities versions with https-correct hrefs", async () => {
  for (const [url, marker] of [
    ["http://localhost/geoserver/sota/wfs?service=WFS&version=2.0.0&request=GetCapabilities", 'version="2.0.0"'],
    ["http://localhost/geoserver/wfs?service=WFS&version=1.1.0&request=GetCapabilities", 'version="1.1.0"'],
  ] as const) {
    const resp = await exports.default.fetch(url);
    expect(resp.status).toBe(200);
    const body = await resp.text();
    expect(body).toContain(marker);
    expect(body).toContain("sota:SOTA_Summits");
    expect(body).toContain("application/json");
    // hrefs must be built from the request host, not hardcoded
    expect(body).toContain("http://localhost/geoserver/wfs");
  }
});

it("reports an exception for an unknown type name", async () => {
  const resp = await exports.default.fetch("http://localhost/geoserver/wfs?service=WFS&request=GetFeature&typename=sota:Nope");
  expect(resp.status).toBe(400);
  const body = await resp.text();
  expect(body).toContain("ExceptionReport");
  expect(body).toContain("InvalidParameterValue");
});

it("reports an exception for an unsupported request", async () => {
  const resp = await exports.default.fetch("http://localhost/geoserver/wfs?service=WFS&request=Transaction");
  expect(resp.status).toBe(400);
  expect(await resp.text()).toContain("OperationNotSupported");
});

it("describes the feature type schema", async () => {
  const resp = await exports.default.fetch(
    "http://localhost/geoserver/wfs?service=WFS&request=DescribeFeatureType&typename=sota:SOTA_Summits",
  );
  expect(resp.status).toBe(200);
  const body = await resp.text();
  expect(body).toContain("SummitCode");
  expect(body).toContain("gml:PointPropertyType");
});

it("reports a WFS error (not a crash) for a layer that hasn't been fetched yet", async () => {
  const resp = await exports.default.fetch(
    "http://localhost/geoserver/wfs?service=WFS&request=GetFeature&typename=sota:Tesla_Superchargers",
  );
  expect(resp.status).toBe(400);
  expect(await resp.text()).toContain("not yet fetched");
});

// Note: the old Flask server trusted X-Forwarded-Proto/Host from ngrok to
// build capabilities hrefs (see the removed test_capabilities_forwarded_proto).
// On Workers behind a real custom domain, request.url already carries the
// true client-facing proto/host, so there is no forwarded-header trust
// dance left to test — see src/index.ts's baseUrlOf().
