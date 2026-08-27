/**
 * Bulk-precompute activation-zone rings for whole SOTA associations from
 * local USGS 3DEP elevation data (via HTTP range requests — see
 * scripts/lib/dem.ts), instead of trickling through opentopodata's
 * rate-limited/budgeted public API one summit at a time. Results are
 * written straight into the real AZ_CACHE KV namespace, so the live
 * Worker serves them immediately with no further computation needed —
 * matching how the old Python version's bulk_az.py filled the same cache
 * ahead of time from the same public elevation data.
 *
 * Usage: npx tsx scripts/bulk-az.ts W6 W7 [--limit N] [--concurrency N]
 *
 * Prefixes match the association part of SummitCode, so "W7" covers
 * W7A..W7Y. Already-cached summits (success OR failure) are skipped —
 * rerun is cheap and safe. Set CLOUDFLARE_KV_NAMESPACE_ID to override the
 * namespace id if it's not the one currently in wrangler.jsonc.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchSotaCsv, parseSota } from "../src/data/sota";
import { Dem } from "./lib/dem";
import { computeOneLocal } from "./lib/bulk-compute";

const execFileAsync = promisify(execFile);

const NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? "4fbcffa59de945968a5f58f93e8cd496";
const FLUSH_BATCH = 250;
const DEFAULT_CONCURRENCY = 8;
// Node's execFile defaults to a 1 MB stdout buffer — comfortably exceeded by
// `wrangler kv key list`'s pretty-printed JSON once a broad prefix (e.g.
// "W", covering every already-cached W-association) lists tens of
// thousands of entries. Even every SOTA summit worldwide (~171k) listed
// this way is only a few MB, so this ceiling has generous headroom.
const WRANGLER_MAX_BUFFER = 64 * 1024 * 1024;

interface Args {
  prefixes: string[];
  limit?: number;
  concurrency: number;
}

function parseArgs(argv: string[]): Args {
  const prefixes: string[] = [];
  let limit: number | undefined;
  let concurrency = DEFAULT_CONCURRENCY;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--limit") limit = Number(argv[++i]);
    else if (a === "--concurrency") concurrency = Number(argv[++i]);
    else prefixes.push(a);
  }
  if (prefixes.length === 0) {
    throw new Error("usage: bulk-az.ts <prefix> [<prefix>...] [--limit N] [--concurrency N]");
  }
  return { prefixes, limit, concurrency };
}

async function listCachedRefs(prefixes: string[]): Promise<Set<string>> {
  const refs = new Set<string>();
  for (const prefix of prefixes) {
    const { stdout } = await execFileAsync("npx", [
      "wrangler",
      "kv",
      "key",
      "list",
      "--namespace-id",
      NAMESPACE_ID,
      "--remote",
      "--prefix",
      `az:${prefix}`,
    ], { maxBuffer: WRANGLER_MAX_BUFFER });
    const keys = JSON.parse(stdout) as { name: string }[];
    for (const { name } of keys) refs.add(name.slice("az:".length));
  }
  return refs;
}

async function flushToKv(entries: { key: string; value: string }[]): Promise<void> {
  if (entries.length === 0) return;
  const dir = await mkdtemp(path.join(tmpdir(), "bulk-az-"));
  const file = path.join(dir, "batch.json");
  try {
    await writeFile(file, JSON.stringify(entries));
    await execFileAsync(
      "npx",
      ["wrangler", "kv", "bulk", "put", file, "--namespace-id", NAMESPACE_ID, "--remote"],
      { maxBuffer: WRANGLER_MAX_BUFFER },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const COVERAGE_PROBE_SIZE = 20;

/** True when this scope looks like it has real USGS 3DEP coverage. Checks
 * a small sample before doing any real work — a run against a non-US
 * prefix (e.g. the England incident: bulk-az.ts G wrote 1620 permanent
 * "no DEM coverage" failures into the shared AZ_CACHE before anyone
 * noticed, blocking the live on-demand queue's opentopodata path — which
 * *does* have real coverage there — for 7 days each) writes nothing to
 * the cache instead of silently poisoning it. A single US summit hitting
 * this exact failure is effectively unheard of (see git history — every
 * real US bulk run so far has failed on other summits for other reasons,
 * never this one), so requiring the *whole* sample to fail this way
 * before aborting leaves no realistic false-positive risk.
 */
async function probeCoverage(
  dem: Dem,
  sample: { lat: number; lon: number; alt: number }[],
): Promise<boolean> {
  if (sample.length === 0) return true;
  let noCoverage = 0;
  for (const item of sample) {
    const result = await computeOneLocal(dem, item.lat, item.lon, item.alt);
    if (!result.ok && result.error?.includes("no DEM coverage")) noCoverage++;
  }
  return noCoverage < sample.length;
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  async function runner(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
}

async function main(): Promise<void> {
  const { prefixes, limit, concurrency } = parseArgs(process.argv.slice(2));

  console.log(`bulk_az: fetching SOTA summit list...`);
  const { records } = parseSota(await fetchSotaCsv());
  const inScope = records.filter((r) => {
    const assoc = String(r.props.SummitCode).split("/")[0]!;
    return prefixes.some((p) => assoc.startsWith(p));
  });

  console.log(`bulk_az: checking already-cached summits...`);
  const cached = await listCachedRefs(prefixes);

  let todo = inScope
    .filter((r) => !cached.has(String(r.props.SummitCode)))
    .map((r) => ({
      ref: String(r.props.SummitCode),
      lat: r.lat,
      lon: r.lon,
      alt: typeof r.props.AltM === "number" ? r.props.AltM : null,
    }))
    .filter((r): r is { ref: string; lat: number; lon: number; alt: number } => r.alt !== null);

  // Neighbors share DEM tiles: keep tile reads clustered for cache locality.
  todo.sort((a, b) => {
    const ta = Dem.tileName(a.lat, a.lon);
    const tb = Dem.tileName(b.lat, b.lon);
    return ta < tb ? -1 : ta > tb ? 1 : a.lon - b.lon || a.lat - b.lat;
  });
  if (limit) todo = todo.slice(0, limit);

  const total = todo.length;
  console.log(
    `bulk_az: ${total} summits to compute (${cached.size} already cached, ${concurrency} concurrent)`,
  );
  if (total === 0) return;

  const dem = new Dem();

  console.log(`bulk_az: probing DEM coverage (${Math.min(COVERAGE_PROBE_SIZE, total)} summits)...`);
  const covered = await probeCoverage(dem, todo.slice(0, COVERAGE_PROBE_SIZE));
  if (!covered) {
    console.error(
      `bulk_az: no USGS 3DEP coverage detected for this scope — every probed summit failed with ` +
        `"no DEM coverage". This tool only works for the US (3DEP's extent); aborting without ` +
        `writing anything to the cache. If this scope genuinely includes US territory, rerun with ` +
        `--limit to isolate which prefix is out of coverage.`,
    );
    process.exitCode = 1;
    return;
  }

  let pending: { key: string; value: string }[] = [];
  let done = 0;
  let failed = 0;
  const t0 = Date.now();

  async function maybeFlush(force = false): Promise<void> {
    if (!force && pending.length < FLUSH_BATCH) return;
    const batch = pending;
    pending = [];
    if (batch.length > 0) await flushToKv(batch);
  }

  await runPool(todo, concurrency, async (item) => {
    const result = await computeOneLocal(dem, item.lat, item.lon, item.alt);
    pending.push({ key: `az:${item.ref}`, value: JSON.stringify({ ...result, ts: Date.now() }) });
    done++;
    if (!result.ok) {
      failed++;
      console.log(`bulk_az: ${item.ref} FAILED: ${result.error}`);
    }
    if (done % 50 === 0 || done === total) {
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = rate > 0 ? (total - done) / rate : 0;
      console.log(`bulk_az: ${done}/${total} (${failed} failed) ${rate.toFixed(1)}/s eta ${(eta / 60).toFixed(0)}m`);
    }
    await maybeFlush();
  });
  await maybeFlush(true);

  console.log(`bulk_az: finished ${done} (${failed} failed) in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
