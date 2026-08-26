/**
 * Bbox-sharded storage: rows are bucketed into a fixed lat/lon grid at
 * fetch time and written one small blob per non-empty cell to R2, so a
 * GetFeature with a bbox (which is what CalTopo always sends) only reads
 * the handful of tiles the view overlaps instead of the whole dataset.
 */
import type { FeatureRecord } from "./types";

// Measured against the real ~171k-row SOTA dataset (scripts/measure-tiling.ts):
// 1deg = 3649 non-empty tiles (blows the 1,000 R2-ops-per-invocation budget
// once publish + prune are counted together); 5deg = 404 tiles, comfortable
// margin, max ~4k rows/tile (a few MB) which is still a single cheap R2 get.
export const TILE_DEGREES = 5;

/** Above this many overlapping tiles, read the untiled full blob instead —
 * a defensive fallback for unusually large bboxes, never hit by CalTopo's
 * normal pan/zoom traffic. */
const MAX_TILES_PER_QUERY = 64;

export function tileKey(tx: number, ty: number): string {
  return `${tx}_${ty}`;
}

function tileIndex(coord: number, tileDegrees: number): number {
  return Math.floor(coord / tileDegrees);
}

export function tileForPoint(lon: number, lat: number, tileDegrees: number): string {
  return tileKey(tileIndex(lon, tileDegrees), tileIndex(lat, tileDegrees));
}

export function bucketRecords(
  records: FeatureRecord[],
  tileDegrees: number,
): Map<string, FeatureRecord[]> {
  const tiles = new Map<string, FeatureRecord[]>();
  for (const rec of records) {
    const key = tileForPoint(rec.lon, rec.lat, tileDegrees);
    const bucket = tiles.get(key);
    if (bucket) bucket.push(rec);
    else tiles.set(key, [rec]);
  }
  return tiles;
}

/** Tile keys overlapping [minx, miny, maxx, maxy], or null when the bbox is
 * wide enough that reading the full dataset is cheaper (see MAX_TILES_PER_QUERY). */
export function tileKeysForBbox(
  bbox: readonly [number, number, number, number],
  tileDegrees: number,
): string[] | null {
  const [minx, miny, maxx, maxy] = bbox;
  const txMin = tileIndex(minx, tileDegrees);
  const txMax = tileIndex(maxx, tileDegrees);
  const tyMin = tileIndex(miny, tileDegrees);
  const tyMax = tileIndex(maxy, tileDegrees);
  const count = (txMax - txMin + 1) * (tyMax - tyMin + 1);
  if (count > MAX_TILES_PER_QUERY) return null;
  const keys: string[] = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      keys.push(tileKey(tx, ty));
    }
  }
  return keys;
}
