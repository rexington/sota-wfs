/**
 * Cron-triggered data refresh — port of fetch/fetch_sota.py and
 * fetch/fetch_superchargers.py. Each job validates before publishing (see
 * data/sota.ts and data/superchargers.ts), so a bad fetch never replaces
 * good data — the same guarantee the old atomic file-rename gave.
 */
import type { Env } from "./env";
import { fetchSotaCsv, parseSotaRows, todayUtcDay, SOTA_COLUMNS } from "./data/sota";
import { fetchSuperchargersGeojson, parseSuperchargers } from "./data/superchargers";
import { publishLayerVersion, publishLayerVersionInPasses } from "./data/manifest";
import { LAYERS } from "./data/types";

export const SOTA_CRON = "0 8 * * *";
export const SUPERCHARGERS_CRON = "0 9 * * 1";

// The real ~171k-row SOTA dataset lives as ~100+ MB of FeatureRecords once
// fully materialized — too close to a Workers isolate's fixed 128 MB
// ceiling to hold as one array (see data/manifest.ts's
// publishLayerVersionInPasses doc). 12 re-parses keeps each pass's share
// of live records to roughly a tenth of that, comfortably clear of the
// ceiling; the cost is CPU (configurable up to 5 minutes), which this path
// has plenty of.
const SOTA_PUBLISH_PASSES = 12;

async function refreshSota(env: Env): Promise<void> {
  const layer = LAYERS.sota_summits!;
  const text = await fetchSotaCsv();
  const today = todayUtcDay();
  const manifest = await publishLayerVersionInPasses(
    env.DATA,
    layer.prefix,
    SOTA_COLUMNS,
    layer.keyProp,
    SOTA_PUBLISH_PASSES,
    (onRow) => parseSotaRows(text, today, onRow),
  );
  console.log(`fetch_sota: published ${manifest.version} (${manifest.featureCount} summits)`);
}

async function refreshSuperchargers(env: Env): Promise<void> {
  const layer = LAYERS.tesla_superchargers!;
  const data = await fetchSuperchargersGeojson(env.NREL_API_KEY ?? "DEMO_KEY");
  const { records, columns } = parseSuperchargers(data);
  const manifest = await publishLayerVersion(env.DATA, layer.prefix, records, columns, {
    keyProp: layer.keyProp,
    tryFullBlob: layer.tryFullBlob,
  });
  console.log(`fetch_superchargers: published ${manifest.version} (${manifest.featureCount} stations)`);
}

export default async function scheduled(
  controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  if (controller.cron === SOTA_CRON) {
    await refreshSota(env);
  } else if (controller.cron === SUPERCHARGERS_CRON) {
    await refreshSuperchargers(env);
  } else {
    console.log(`scheduled: unrecognized cron ${controller.cron}`);
  }
}
