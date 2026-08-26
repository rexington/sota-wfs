/**
 * Per-isolate, in-memory index over one layer's compact code->{tileKey,id}
 * index, for the single-record lookups (/summit/<ref>.geojson,
 * /az/<ref>.geojson) that aren't bbox-shaped. A lookup costs one cached
 * index parse (a few MB even for the full ~171k-row SOTA dataset) plus one
 * small tile read — never the ~95 MB full dataset, which is exactly the
 * per-request cost this module exists to avoid. Rebuilt only when the
 * manifest version changes, mirroring registry.py's old mtime check.
 */
import type { FeatureRecord } from "./types";
import { getIndex, tileObjectKey } from "./manifest";

interface CachedIndex {
  version: string;
  byKey: Map<string, { tileKey: string; id: number }>;
}

const indexCache = new Map<string, CachedIndex>();

async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  return obj ? obj.json<T>() : null;
}

export async function getByKey(
  bucket: R2Bucket,
  prefix: string,
  version: string,
  key: string,
): Promise<FeatureRecord | undefined> {
  let cached = indexCache.get(prefix);
  if (!cached || cached.version !== version) {
    const rows = await getIndex(bucket, prefix, version);
    const byKey = new Map<string, { tileKey: string; id: number }>();
    for (const [k, tileKey, id] of rows ?? []) byKey.set(k, { tileKey, id });
    cached = { version, byKey };
    indexCache.set(prefix, cached);
  }
  const hit = cached.byKey.get(key);
  if (!hit) return undefined;
  const tile = await getJson<FeatureRecord[]>(bucket, tileObjectKey(prefix, version, hit.tileKey));
  return tile?.find((r) => r.id === hit.id);
}
