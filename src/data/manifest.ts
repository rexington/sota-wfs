/**
 * Per-layer manifest + "current version" pointer in R2, and the atomic
 * cutover a fetch performs when publishing a new generation.
 *
 * Layout under the layer's R2 prefix (e.g. "sota/"):
 *   current.json             { version }             — written last
 *   previous.json            { version }              — the version superseded *before* the current one; pruned on the *next* publish
 *   <version>/manifest.json  { version, bbox, columns, featureCount, tileDegrees, hasFullBlob }
 *   <version>/index.json     [[key, tileKey, id], ...] — only when the layer declares a keyProp
 *   <version>/full.json      FeatureRecord[]            — only when small enough to be worth it (see FULL_BLOB_MAX_BYTES)
 *   <version>/tiles/<tx_ty>.json  FeatureRecord[]        — one file per non-empty grid cell
 *
 * GetFeature/GetCapabilities re-check current.json at most every
 * RELOAD_CHECK_MS, mirroring the old registry.py mtime-check cache.
 *
 * Pruning deletes the version from *two* publishes ago, not the one just
 * superseded: an isolate can hold a cached manifest pointing at the
 * just-superseded version for up to RELOAD_CHECK_MS after the flip, and
 * deleting it immediately would make GetFeature silently serve zero
 * features for that window. Keeping N-2 around gives a full fetch cycle
 * of grace instead of 15 seconds.
 */
import type { FeatureRecord, LayerManifest } from "./types";
import { TILE_DEGREES, bucketRecords, tileKey } from "./tiling";

const RELOAD_CHECK_MS = 15_000;

/** Above this, full.json isn't worth writing or parsing — the no-BBOX /
 * bbox-too-wide paths require an explicit BBOX instead. Comfortably covers
 * small layers (superchargers, test fixtures); the real ~171k-row SOTA
 * dataset (measured ~95 MB) deliberately does not get one. */
const FULL_BLOB_MAX_BYTES = 8_000_000;

interface CachedManifest {
  version: string;
  manifest: LayerManifest;
  checkedAt: number;
}

const manifestCache = new Map<string, CachedManifest>();

const jsonHeaders = { httpMetadata: { contentType: "application/json" } };

export function currentKey(prefix: string): string {
  return `${prefix}/current.json`;
}

function previousKey(prefix: string): string {
  return `${prefix}/previous.json`;
}

export function manifestKey(prefix: string, version: string): string {
  return `${prefix}/${version}/manifest.json`;
}

export function fullKey(prefix: string, version: string): string {
  return `${prefix}/${version}/full.json`;
}

export function indexKey(prefix: string, version: string): string {
  return `${prefix}/${version}/index.json`;
}

export function tileObjectKey(prefix: string, version: string, tx: string): string {
  return `${prefix}/${version}/tiles/${tx}.json`;
}

async function getJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const obj = await bucket.get(key);
  return obj ? obj.json<T>() : null;
}

export async function getManifest(
  bucket: R2Bucket,
  prefix: string,
): Promise<CachedManifest | null> {
  const cached = manifestCache.get(prefix);
  const now = Date.now();
  if (cached && now - cached.checkedAt < RELOAD_CHECK_MS) {
    return cached;
  }
  const current = await getJson<{ version: string }>(bucket, currentKey(prefix));
  if (!current) return cached ?? null; // keep serving stale data if the pointer vanishes mid-swap
  if (cached && cached.version === current.version) {
    cached.checkedAt = now;
    return cached;
  }
  const manifest = await getJson<LayerManifest>(bucket, manifestKey(prefix, current.version));
  if (!manifest) return cached ?? null;
  const entry: CachedManifest = { version: current.version, manifest, checkedAt: now };
  manifestCache.set(prefix, entry);
  return entry;
}

export function clearManifestCache(): void {
  manifestCache.clear();
}

/** [key, tileKey, id] rows for a layer version's compact lookup index, or
 * null when the layer has no keyProp (no single-record lookup endpoint). */
export async function getIndex(
  bucket: R2Bucket,
  prefix: string,
  version: string,
): Promise<[string, string, number][] | null> {
  return getJson<[string, string, number][]>(bucket, indexKey(prefix, version));
}

/** At most this many tile writes in flight at once: Workers caps a Worker
 * invocation to 6 subrequests simultaneously waiting on headers, and — more
 * importantly here — `.map()`-then-`Promise.all()` stringifies every tile
 * up front, holding all of them in memory until their turn on the wire.
 * Batching keeps only one batch's worth of serialized tiles resident at a
 * time so the rest are collectable. */
const TILE_WRITE_BATCH_SIZE = 6;

export interface PublishOptions {
  /** Property that uniquely identifies a record; builds the compact
   * code->{tileKey,id} lookup index when given. */
  keyProp?: string;
  /** Whether to also write an untiled full.json. Only pass this for
   * datasets known to be small — see LayerDef.tryFullBlob's doc. */
  tryFullBlob?: boolean;
}

function newVersion(): string {
  // A random suffix guards against two publishes landing in the same
  // millisecond (timestamp collisions would make current/previous version
  // tracking ambiguous) — cheap insurance, since a real cron fetch only
  // ever runs once per interval anyway.
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
}

async function writeTilesBatched(
  bucket: R2Bucket,
  prefix: string,
  version: string,
  tiles: Map<string, FeatureRecord[]>,
): Promise<void> {
  const entries = [...tiles.entries()];
  for (let i = 0; i < entries.length; i += TILE_WRITE_BATCH_SIZE) {
    const batch = entries.slice(i, i + TILE_WRITE_BATCH_SIZE);
    await Promise.all(
      batch.map(([tx, recs]) => bucket.put(tileObjectKey(prefix, version, tx), JSON.stringify(recs), jsonHeaders)),
    );
  }
}

/** Writes manifest.json, flips current.json, records the outgoing version
 * as the new previous.json, and prunes whatever previous.json named before
 * this call (the generation from two publishes ago). Shared tail for both
 * publish paths below — the atomicity/pruning contract lives in exactly
 * one place. */
async function finalizePublish(
  bucket: R2Bucket,
  prefix: string,
  manifest: LayerManifest,
): Promise<void> {
  const { version } = manifest;
  await bucket.put(manifestKey(prefix, version), JSON.stringify(manifest), jsonHeaders);

  const outgoing = await getJson<{ version: string }>(bucket, currentKey(prefix));
  const toPrune = await getJson<{ version: string }>(bucket, previousKey(prefix));

  await bucket.put(currentKey(prefix), JSON.stringify({ version }), jsonHeaders);
  if (outgoing) await bucket.put(previousKey(prefix), JSON.stringify(outgoing), jsonHeaders);

  manifestCache.set(prefix, { version, manifest, checkedAt: Date.now() });

  if (toPrune && toPrune.version !== version && toPrune.version !== outgoing?.version) {
    await pruneVersion(bucket, prefix, toPrune.version);
  }
}

/** Publish a new generation from a dataset already fully in memory: write
 * tiles + index + (maybe) full blob + manifest under a fresh version, then
 * flip current.json last so readers never observe a half-written
 * generation. Fine for datasets small enough to hold as one array —
 * superchargers (~3k features) and test fixtures. The real ~171k-row SOTA
 * dataset must use `publishLayerVersionInPasses` instead (see its doc). */
export async function publishLayerVersion(
  bucket: R2Bucket,
  prefix: string,
  records: FeatureRecord[],
  columns: string[],
  { keyProp, tryFullBlob }: PublishOptions = {},
): Promise<LayerManifest> {
  const version = newVersion();
  const tiles = bucketRecords(records, TILE_DEGREES);
  await writeTilesBatched(bucket, prefix, version, tiles);

  if (keyProp) {
    const index: [string, string, number][] = [];
    for (const [tx, recs] of tiles) {
      for (const rec of recs) {
        const k = rec.props[keyProp];
        if (typeof k === "string") index.push([k, tx, rec.id]);
      }
    }
    await bucket.put(indexKey(prefix, version), JSON.stringify(index), jsonHeaders);
  }

  // Only serialize the whole dataset when the caller already knows it's a
  // candidate — for a large layer, JSON.stringify(records) alone can be a
  // sizeable fraction of the 128 MB isolate ceiling, so it must never run
  // just to *measure* whether the blob would be small enough.
  let hasFullBlob = false;
  if (tryFullBlob) {
    const fullJson = JSON.stringify(records);
    hasFullBlob = fullJson.length <= FULL_BLOB_MAX_BYTES;
    if (hasFullBlob) {
      await bucket.put(fullKey(prefix, version), fullJson, jsonHeaders);
    }
  }

  const manifest: LayerManifest = {
    version,
    bbox: boundingBox(records),
    columns,
    featureCount: records.length,
    tileDegrees: TILE_DEGREES,
    hasFullBlob,
  };
  await finalizePublish(bucket, prefix, manifest);
  return manifest;
}

/** Deterministic string hash mod n, used to assign each tile to one of the
 * N passes below — good enough distribution for load-balancing a few
 * hundred tiles across a handful of passes, not for anything
 * security-sensitive. */
function hashMod(key: string, n: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return ((h % n) + n) % n;
}

/** Publish a new generation from a dataset too large to hold in memory all
 * at once (the real SOTA dataset: ~171k rows, ~100+ MB as live
 * FeatureRecords — uncomfortably close to a Workers isolate's 128 MB
 * ceiling on its own, before accounting for the source text and runtime
 * overhead already resident).
 *
 * `eachPass(onRow)` must, each time it's called, regenerate and hand every
 * surviving row to `onRow` again from scratch (e.g. by re-running a
 * streaming CSV parse over an already-fetched source string) — the cost is
 * re-parsing N times, which is CPU (configurable up to 5 minutes) rather
 * than memory (fixed at 128 MB). Each tile is deterministically assigned to
 * exactly one pass via `hashMod`, so nothing is ever split across passes
 * and the on-disk layout — and everything that reads it — is identical to
 * `publishLayerVersion`'s.
 *
 * Bookkeeping that needs a global view (the compact index, the bbox, the
 * feature count) is accumulated only on the first pass, since every pass
 * sees the identical full set of surviving rows in the identical order. */
export async function publishLayerVersionInPasses(
  bucket: R2Bucket,
  prefix: string,
  columns: string[],
  keyProp: string | undefined,
  passes: number,
  eachPass: (onRow: (rec: FeatureRecord, tileKey: string) => void) => void,
): Promise<LayerManifest> {
  const version = newVersion();
  const index: [string, string, number][] = [];
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  let featureCount = 0;

  for (let pass = 0; pass < passes; pass++) {
    const tiles = new Map<string, FeatureRecord[]>();
    eachPass((rec, tileKey) => {
      if (pass === 0) {
        featureCount++;
        if (rec.lon < minx) minx = rec.lon;
        if (rec.lon > maxx) maxx = rec.lon;
        if (rec.lat < miny) miny = rec.lat;
        if (rec.lat > maxy) maxy = rec.lat;
        if (keyProp) {
          const k = rec.props[keyProp];
          if (typeof k === "string") index.push([k, tileKey, rec.id]);
        }
      }
      if (hashMod(tileKey, passes) !== pass) return;
      const arr = tiles.get(tileKey);
      if (arr) arr.push(rec);
      else tiles.set(tileKey, [rec]);
    });
    await writeTilesBatched(bucket, prefix, version, tiles);
  }

  if (keyProp) {
    await bucket.put(indexKey(prefix, version), JSON.stringify(index), jsonHeaders);
  }

  const manifest: LayerManifest = {
    version,
    bbox: featureCount === 0 ? [-180, -90, 180, 90] : [minx, miny, maxx, maxy],
    columns,
    featureCount,
    tileDegrees: TILE_DEGREES,
    hasFullBlob: false, // by construction: this path exists because full.json isn't safe to build
  };
  await finalizePublish(bucket, prefix, manifest);
  return manifest;
}

function boundingBox(records: FeatureRecord[]): [number, number, number, number] {
  if (records.length === 0) return [-180, -90, 180, 90];
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const r of records) {
    if (r.lon < minx) minx = r.lon;
    if (r.lon > maxx) maxx = r.lon;
    if (r.lat < miny) miny = r.lat;
    if (r.lat > maxy) maxy = r.lat;
  }
  return [minx, miny, maxx, maxy];
}

/** Delete every object belonging to one generation. Best-effort: failures
 * here don't affect serving. */
async function pruneVersion(bucket: R2Bucket, prefix: string, version: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const list = await bucket.list({ prefix: `${prefix}/${version}/`, cursor });
    if (list.objects.length > 0) {
      await bucket.delete(list.objects.map((o) => o.key));
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
}

export { tileKey };
