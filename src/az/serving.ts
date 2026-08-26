/**
 * Activation-zone polygons: cached-ring serving, bbox-gated. Port of the
 * serving half of sota_wfs/az.py.
 *
 * The elevation API is slow and rate-limited, so rings are never computed
 * during a request. GetFeature serves whatever is cached in KV and enqueues
 * the rest to the AzQueueDO for a later pan/refresh; polygons are only
 * served when the request bbox is small (zoomed well in).
 */
import type { FeatureRecord } from "../data/types";
import type { Bbox, GeoJsonFeature } from "../wfs/getfeature";

export const AZ_COLOR = "#FFAA00";
const MAX_SPAN_DEG = 0.4; // serve AZs only when bbox lat span is below this (~Z13+)
const RETRY_FAILED_MS = 7 * 86_400_000;
const KV_BULK_GET_LIMIT = 100; // KVNamespace.get(keys[]) accepts at most 100 keys per call

export interface AzCacheEntry {
  ok: boolean;
  ring?: number[][];
  error?: string;
  ts?: number;
}

export interface AzEnqueueItem {
  ref: string;
  lat: number;
  lon: number;
  alt: number;
}

export type Enqueue = (items: AzEnqueueItem[]) => void;

function azKey(ref: string): string {
  return `az:${ref}`;
}

function liveOrNull(entry: AzCacheEntry | null): AzCacheEntry | null {
  if (!entry) return null;
  if (!entry.ok && entry.ts !== undefined && Date.now() - entry.ts > RETRY_FAILED_MS) {
    return null; // stale failure: recompute
  }
  return entry;
}

async function bulkGet(kv: KVNamespace, refs: string[]): Promise<Map<string, AzCacheEntry | null>> {
  const out = new Map<string, AzCacheEntry | null>();
  for (let i = 0; i < refs.length; i += KV_BULK_GET_LIMIT) {
    const chunk = refs.slice(i, i + KV_BULK_GET_LIMIT);
    const got = await kv.get<AzCacheEntry>(
      chunk.map(azKey),
      "json",
    );
    for (const ref of chunk) out.set(ref, got.get(azKey(ref)) ?? null);
  }
  return out;
}

export async function writeCache(kv: KVNamespace, ref: string, entry: AzCacheEntry): Promise<void> {
  await kv.put(azKey(ref), JSON.stringify({ ...entry, ts: entry.ts ?? Date.now() }));
}

function feature(ref: string, record: FeatureRecord, ring: number[][], baseUrl: string): GeoJsonFeature {
  const lons = ring.map((p) => p[0]!);
  const lats = ring.map((p) => p[1]!);
  const name = record.props.SummitName;
  return {
    type: "Feature",
    id: `SOTA_Summits.az-${ref.replace(/\//g, "_")}`,
    geometry: { type: "Polygon", coordinates: [ring] },
    geometry_name: "the_geom",
    properties: {
      // CalTopo's default label when the layer's Label Name is unset
      title: `${name} - AZ`,
      SummitCode: ref,
      SummitName: `${name} AZ`,
      GeoJSON: `${baseUrl}/az/${ref.replace(/\//g, "_")}.geojson`,
      stroke: AZ_COLOR,
      "stroke-width": 1,
      "stroke-opacity": 1,
      fill: AZ_COLOR,
      "fill-opacity": 0.1,
    },
    bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
  };
}

/** Styled AZ Polygon features for the given (already bbox-matched) SOTA
 * summit records, when the view is zoomed in enough. Queues computation
 * for cache misses via one batched `enqueue` call (fire-and-forget). */
export async function featuresForBbox(
  kv: KVNamespace,
  records: FeatureRecord[],
  bbox: Bbox,
  baseUrl: string,
  enqueue: Enqueue,
): Promise<GeoJsonFeature[]> {
  const [, miny, , maxy] = bbox;
  if (maxy - miny > MAX_SPAN_DEG || records.length === 0) return [];

  const refs = records.map((r) => String(r.props.SummitCode));
  const cachedByRef = await bulkGet(kv, refs);

  const feats: GeoJsonFeature[] = [];
  const misses: AzEnqueueItem[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]!;
    const ref = refs[i]!;
    const entry = liveOrNull(cachedByRef.get(ref) ?? null);
    if (entry === null) {
      const alt = rec.props.AltM;
      if (typeof alt === "number") misses.push({ ref, lat: rec.lat, lon: rec.lon, alt });
    } else if (entry.ok && entry.ring) {
      feats.push(feature(ref, rec, entry.ring, baseUrl));
    }
  }
  if (misses.length > 0) enqueue(misses);
  return feats;
}

/** Standalone FeatureCollection for one summit's cached AZ ring, or null
 * when no successful ring is cached. */
export async function downloadGeojson(
  kv: KVNamespace,
  ref: string,
  record: FeatureRecord,
  baseUrl: string,
): Promise<{ type: "FeatureCollection"; name: string; features: GeoJsonFeature[] } | null> {
  const entry = liveOrNull(await kv.get<AzCacheEntry>(azKey(ref), "json"));
  if (!entry?.ok || !entry.ring) return null;
  const feat = feature(ref, record, entry.ring, baseUrl);
  const name = `${record.props.SummitName} - AZ`;
  feat.properties = { title: name, name, ...feat.properties };
  return { type: "FeatureCollection", name, features: [feat] };
}
