/**
 * One-off local measurement: how big is the real SOTA dataset once tiled?
 * Answers the questions that decide TILE_DEGREES and whether full.json is
 * safe to fully parse on the summit/AZ download paths. Not part of the
 * deployed Worker — run with `npx tsx scripts/measure-tiling.ts`.
 */
import { parseSota } from "../src/data/sota";
import { bucketRecords, TILE_DEGREES } from "../src/data/tiling";

async function main() {
  const res = await fetch("https://storage.sota.org.uk/summitslist.csv");
  const text = await res.text();
  console.log(`raw CSV text: ${(text.length / 1e6).toFixed(1)} MB (length, not bytes)`);

  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const { records, columns } = parseSota(text);
  if (global.gc) global.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(
    `records array: ${((after - before) / 1e6).toFixed(1)} MB heap` +
      (global.gc ? "" : " (approximate — rerun with --expose-gc for a cleaner number)"),
  );
  console.log(`records: ${records.length}, columns: ${columns.length}`);

  for (const deg of [1, 2, 4, 5]) {
    const tiles = bucketRecords(records, deg);
    const sizes = [...tiles.values()].map((r) => r.length);
    const maxRows = Math.max(...sizes);
    console.log(
      `tileDegrees=${deg}: ${tiles.size} non-empty tiles, max ${maxRows} rows/tile, ` +
        `avg ${(records.length / tiles.size).toFixed(1)} rows/tile`,
    );
  }

  const fullJson = JSON.stringify(records);
  console.log(`full.json size: ${(fullJson.length / 1e6).toFixed(2)} MB (${records.length} records)`);

  const tiles = bucketRecords(records, TILE_DEGREES);
  const index: [string, string, number][] = [];
  for (const [tx, recs] of tiles) {
    for (const r of recs) index.push([String(r.props.SummitCode), tx, r.id]);
  }
  console.log(`code index size (as actually published): ${(JSON.stringify(index).length / 1e6).toFixed(2)} MB`);

  console.log(`\n(default TILE_DEGREES in tiling.ts is currently ${TILE_DEGREES})`);

  checkContract(records);
}

/**
 * Contract checks the 6-row test fixture is too small to ever exercise:
 * real SOTA data has 171k chances to produce a Points value or a summit
 * with zero activations that the fixture never covers.
 */
function checkContract(records: ReturnType<typeof parseSota>["records"]): void {
  const problems: string[] = [];

  const zeroActivations = records.filter((r) => r.props.ActivationCount === 0);
  if (zeroActivations.length === 0) {
    problems.push("expected at least one summit with ActivationCount === 0");
  } else if (!zeroActivations.some((r) => r.props.Activations === "0")) {
    problems.push('expected Activations === "0" (not "" or "0.0") for an unactivated summit');
  }

  const validSymbols = /^(point|circle-(1|2|4|6|8|10))$/;
  const badSymbols = new Set(
    records
      .map((r) => r.props["marker-symbol"])
      .filter((v): v is string => typeof v === "string" && !validSymbols.test(v)),
  );
  if (badSymbols.size > 0) {
    problems.push(`unexpected marker-symbol values (Points outside {1,2,4,6,8,10}?): ${[...badSymbols].join(", ")}`);
  }

  let coordMismatches = 0;
  for (const r of records) {
    if (typeof r.props.Longitude === "number" && Math.round(r.props.Longitude * 1e6) / 1e6 !== r.lon) {
      coordMismatches++;
    }
  }
  if (coordMismatches > 0) {
    problems.push(`${coordMismatches} record(s) where props.Longitude disagrees with the geometry lon`);
  }

  console.log(problems.length === 0 ? "\ncontract checks: OK" : `\ncontract checks FAILED:\n  ${problems.join("\n  ")}`);
  if (problems.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
