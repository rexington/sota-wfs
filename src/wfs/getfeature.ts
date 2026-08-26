/**
 * GetFeature: bbox parsing, filtering, GeoServer-shaped GeoJSON output.
 * Port of sota_wfs/getfeature.py.
 */
import type { FeatureRecord, LayerDef, PropValue } from "../data/types";

export const COORD_DECIMALS = 6;

export class WfsError extends Error {
  code: string;
  locator: string | null;
  constructor(code: string, text: string, locator: string | null = null) {
    super(text);
    this.code = code;
    this.locator = locator;
  }
}

export type Bbox = readonly [number, number, number, number]; // minx, miny, maxx, maxy

/**
 * CalTopo sends {bottom},{left},{top},{right} with VERSION=1.1.0 and no CRS
 * token, i.e. lat-first (EPSG:4326 axis order) — matching GeoServer's
 * interpretation. A trailing CRS84 token means lon-first.
 */
export function parseBbox(raw: string): Bbox {
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4 && parts.length !== 5) {
    throw new WfsError("InvalidParameterValue", `BBOX must have 4 values, got ${parts.length}`, "bbox");
  }
  const nums = parts.slice(0, 4).map(Number);
  if (nums.some((n) => Number.isNaN(n))) {
    throw new WfsError("InvalidParameterValue", `Malformed BBOX: ${JSON.stringify(raw)}`, "bbox");
  }
  const [a, b, c, d] = nums as [number, number, number, number];
  let latFirst = true;
  if (parts.length === 5 && parts[4]!.toUpperCase().includes("CRS84")) latFirst = false;
  if (latFirst && (Math.abs(a) > 90 || Math.abs(c) > 90)) latFirst = false; // caller sent lon-first
  return latFirst ? [b, a, d, c] : [a, b, c, d];
}

export function filterByBbox(records: FeatureRecord[], bbox: Bbox): FeatureRecord[] {
  const [minx, miny, maxx, maxy] = bbox;
  return records.filter((r) => r.lon >= minx && r.lon <= maxx && r.lat >= miny && r.lat <= maxy);
}

// Columns served even when PROPERTYNAME omits them, so CalTopo's saved
// layer templates don't have to change to pick them up: style hints, and
// "title" (CalTopo's default feature label when Label Name is unset).
const ALWAYS_SERVED = ["title", "marker-color", "marker-symbol"];

export function resolveProperties(columns: string[], raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return columns;
  const byLower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  const out: string[] = [];
  for (const rawName of raw.split(",")) {
    const name = rawName.trim();
    if (!name || name.toLowerCase() === "the_geom") continue;
    const col = byLower.get(name.toLowerCase());
    if (col !== undefined) out.push(col);
  }
  for (const col of ALWAYS_SERVED) {
    if (columns.includes(col) && !out.includes(col)) out.push(col);
  }
  return out;
}

export function summitUrl(code: string, baseUrl: string): string {
  return `${baseUrl}/summit/${code.replace(/\//g, "_")}.geojson`;
}

export interface GeoJsonFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point" | "Polygon"; coordinates: unknown };
  geometry_name: "the_geom";
  properties: Record<string, PropValue>;
  bbox: [number, number, number, number];
}

export interface FeatureCollection {
  type: "FeatureCollection";
  name?: string;
  features: GeoJsonFeature[];
  totalFeatures?: number;
  numberMatched?: number;
  numberReturned?: number;
  timeStamp?: string;
  crs?: { type: "name"; properties: { name: string } };
  bbox?: [number, number, number, number];
}

/** Standalone FeatureCollection for one summit's marker point, or null when unknown. */
export function summitGeojson(record: FeatureRecord, baseUrl: string): FeatureCollection {
  const lon = round6(record.lon);
  const lat = round6(record.lat);
  const code = String(record.props.SummitCode);
  const name = record.props.SummitName;
  const props: Record<string, PropValue> = { title: name ?? null, name: name ?? null };
  Object.assign(props, record.props);
  props.GeoJSON = summitUrl(code, baseUrl);
  return {
    type: "FeatureCollection",
    name: typeof name === "string" ? name : undefined,
    features: [
      {
        type: "Feature",
        id: `SOTA_Summits.${record.id}`,
        geometry: { type: "Point", coordinates: [lon, lat] },
        geometry_name: "the_geom",
        properties: props,
        bbox: [lon, lat, lon, lat],
      },
    ],
  };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function select(
  layer: LayerDef,
  matched: FeatureRecord[],
  propNames: string[],
  count: number | null,
  baseUrl: string,
  azFeatures: GeoJsonFeature[],
): FeatureCollection {
  const limited = count !== null ? matched.slice(0, count) : matched;

  const features: GeoJsonFeature[] = limited.map((rec) => {
    const lon = round6(rec.lon);
    const lat = round6(rec.lat);
    const props: Record<string, PropValue> = {};
    for (const k of propNames) props[k] = rec.props[k] ?? null;
    if (layer.name === "SOTA_Summits") {
      props.GeoJSON = summitUrl(String(rec.props.SummitCode), baseUrl);
    }
    return {
      type: "Feature",
      id: `${layer.name}.${rec.id}`,
      geometry: { type: "Point", coordinates: [lon, lat] },
      geometry_name: "the_geom",
      properties: props,
      bbox: [lon, lat, lon, lat],
    };
  });

  // The result-level bbox is derived from the (count-limited) point
  // features only, matching the original's use of the points-only lons/lats
  // arrays — AZ polygon geometry never contributes to it. Snapshot before
  // the push below, which mutates `features` in place.
  const bboxSource = features.length > 0 ? [...features] : azFeatures;

  features.push(...azFeatures);
  const total = matched.length + azFeatures.length;

  const fc: FeatureCollection = {
    type: "FeatureCollection",
    features,
    totalFeatures: total,
    numberMatched: total,
    numberReturned: features.length,
    timeStamp: new Date().toISOString(),
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:EPSG::4326" } },
  };

  if (bboxSource.length > 0) {
    const xs = bboxSource.map((f) => f.bbox[0]).concat(bboxSource.map((f) => f.bbox[2]));
    const ys = bboxSource.map((f) => f.bbox[1]).concat(bboxSource.map((f) => f.bbox[3]));
    fc.bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return fc;
}
