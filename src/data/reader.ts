import type { FeatureRecord } from "./types";
import { fullKey, tileObjectKey } from "./manifest";

async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  return obj ? obj.json<T>() : null;
}

/** Records from exactly the given (already bbox-overlap-computed) tiles. */
export async function getRecordsFromTiles(
  bucket: R2Bucket,
  prefix: string,
  version: string,
  tileKeys: string[],
): Promise<FeatureRecord[]> {
  const tiles = await Promise.all(
    tileKeys.map((k) => getJson<FeatureRecord[]>(bucket, tileObjectKey(prefix, version, k))),
  );
  const out: FeatureRecord[] = [];
  for (const t of tiles) if (t) out.push(...t);
  return out;
}

export async function getFullDataset(
  bucket: R2Bucket,
  prefix: string,
  version: string,
): Promise<FeatureRecord[]> {
  return (await getJson<FeatureRecord[]>(bucket, fullKey(prefix, version))) ?? [];
}
