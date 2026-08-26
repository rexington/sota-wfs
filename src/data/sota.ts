/**
 * Fetch, validate, and normalize the SOTA summits list — port of
 * fetch/fetch_sota.py (download + validate) and
 * sota_wfs/loaders.py:sota_csv_loader (typing, derived columns, date-window
 * filtering).
 *
 * `parseSotaRows` streams rows one at a time via Papa's `step` callback
 * instead of materializing Papa's own full parsed-array — the live
 * FeatureRecord array for the real ~171k-row dataset already measures
 * ~100 MB of heap, uncomfortably close to a Workers isolate's 128 MB
 * ceiling, so nothing else in this path should hold a second full copy.
 * `parseSota` (the single-pass convenience wrapper used by tests and the
 * much smaller superchargers-scale case) simply collects every row into an
 * array; the real production SOTA fetch instead uses `parseSotaRows`
 * directly across several passes (see manifest.ts's
 * `publishLayerVersionInPasses`) so only a fraction of the dataset is ever
 * resident at once.
 */
import Papa from "papaparse";
import type { FeatureRecord, PropValue } from "./types";
import { TILE_DEGREES, tileForPoint } from "./tiling";

export const SOTA_URL = "https://storage.sota.org.uk/summitslist.csv";

const EXPECTED_HEADER = [
  "SummitCode",
  "AssociationName",
  "RegionName",
  "SummitName",
  "AltM",
  "AltFt",
  "GridRef1",
  "GridRef2",
  "Longitude",
  "Latitude",
  "Points",
  "BonusPoints",
  "ValidFrom",
  "ValidTo",
  "ActivationCount",
  "ActivationDate",
  "ActivationCall",
];

const MIN_ROWS = 100_000;

// Marker styling: summits are numbered circles keyed by their point value;
// colors follow SOTL.as' green-to-red points scale.
const SOTA_POINT_COLORS: Record<number, string> = {
  1: "#4D7A20",
  2: "#6DA536",
  4: "#AEA727",
  6: "#EFA818",
  8: "#DC5D04",
  10: "#C8101E",
};
const SOTA_MARKER_COLOR = "#FF0000"; // fallback for missing/unexpected point values

export const SOTA_COLUMNS = [
  ...EXPECTED_HEADER,
  "title",
  "SOTLAS",
  "Activations",
  "marker-color",
  "marker-symbol",
];

function splitTitleAndBody(text: string): { title: string; body: string } {
  const idx = text.indexOf("\n");
  if (idx === -1) return { title: text, body: "" };
  return { title: text.slice(0, idx).replace(/\r$/, ""), body: text.slice(idx + 1) };
}

function toFloat(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

function toInt(raw: string | undefined): number | null {
  const v = toFloat(raw);
  return v === null ? null : Math.trunc(v);
}

/** DD/MM/YYYY -> a comparable day number, or null when unparseable
 * (treated as an unbounded validity edge, matching pandas' errors="coerce"). */
function parseDmy(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d));
}

export function todayUtcDay(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

export async function fetchSotaCsv(): Promise<string> {
  const res = await fetch(SOTA_URL);
  if (!res.ok) throw new Error(`fetch_sota: HTTP ${res.status} from ${SOTA_URL}`);
  return res.text();
}

/** Streams every surviving row (valid coordinates, currently in its
 * ValidFrom/ValidTo window) to `onRow` as a fully-built FeatureRecord plus
 * its tile key, without ever holding more than one row's transient state —
 * the caller decides what to keep. `today` is threaded through rather than
 * computed internally so repeated passes over the same fetch agree on
 * "now" even if the process happens to cross a UTC-day boundary mid-run.
 *
 * minRows defaults to the production floor (fetch_sota.py's MIN_ROWS gate,
 * guarding against a truncated/corrupt download); tests pass 0 to exercise
 * small fixtures without the row-count check having any bearing on
 * correctness. */
export function parseSotaRows(
  text: string,
  today: number,
  onRow: (rec: FeatureRecord, tileKey: string) => void,
  { minRows = MIN_ROWS }: { minRows?: number } = {},
): void {
  const { title, body } = splitTitleAndBody(text);
  if (!title.startsWith("SOTA Summits List")) {
    throw new Error(`fetch_sota: unexpected first line: ${JSON.stringify(title.slice(0, 80))}`);
  }

  let rowCount = 0;
  let nextId = 1;
  let headerError: string | null = null;

  Papa.parse<Record<string, string>>(body, {
    header: true,
    skipEmptyLines: true,
    step: (results, parser) => {
      if (rowCount === 0) {
        const fields = results.meta.fields ?? [];
        if (fields.join(",") !== EXPECTED_HEADER.join(",")) {
          headerError = `fetch_sota: unexpected header: ${JSON.stringify(fields.join(",").slice(0, 120))}`;
          parser.abort();
          return;
        }
      }
      rowCount++;

      const row = results.data;
      const lon = toFloat(row.Longitude);
      const lat = toFloat(row.Latitude);
      if (lon === null || lat === null) return; // dropna(subset=["Longitude", "Latitude"])

      const validFrom = parseDmy(row.ValidFrom);
      const validTo = parseDmy(row.ValidTo);
      if (validFrom !== null && validFrom > today) return;
      if (validTo !== null && validTo < today) return;

      const points = toInt(row.Points);
      const activationCount = toInt(row.ActivationCount);

      const props: Record<string, PropValue> = {
        SummitCode: row.SummitCode ?? "",
        AssociationName: row.AssociationName ?? "",
        RegionName: row.RegionName ?? "",
        SummitName: row.SummitName ?? "",
        AltM: toInt(row.AltM),
        AltFt: toInt(row.AltFt),
        GridRef1: toFloat(row.GridRef1),
        GridRef2: toFloat(row.GridRef2),
        Longitude: lon,
        Latitude: lat,
        Points: points,
        BonusPoints: toInt(row.BonusPoints),
        ValidFrom: row.ValidFrom ?? "",
        ValidTo: row.ValidTo ?? "",
        ActivationCount: activationCount,
        ActivationDate: row.ActivationDate ?? "",
        ActivationCall: row.ActivationCall ?? "",
        title: row.SummitName ?? "",
        SOTLAS: `https://sotl.as/summits/${row.SummitCode}`,
        Activations: activationCount === null ? "" : String(activationCount),
        "marker-color":
          points === null ? SOTA_MARKER_COLOR : (SOTA_POINT_COLORS[points] ?? SOTA_MARKER_COLOR),
        "marker-symbol": points === null ? "point" : `circle-${points}`,
      };

      const rec: FeatureRecord = { id: nextId++, lon, lat, props };
      onRow(rec, tileForPoint(lon, lat, TILE_DEGREES));
    },
  });

  if (headerError) throw new Error(headerError);
  if (rowCount < minRows) {
    throw new Error(`fetch_sota: only ${rowCount} data rows (expected > ${minRows})`);
  }
}

/** Single-pass convenience wrapper: collects every row into one array.
 * Fine for tests (tiny fixtures); the real fetch uses parseSotaRows
 * directly so it never holds the whole ~171k-row dataset at once. */
export function parseSota(
  text: string,
  opts: { minRows?: number } = {},
): { records: FeatureRecord[]; columns: string[] } {
  const records: FeatureRecord[] = [];
  parseSotaRows(text, todayUtcDay(), (rec) => records.push(rec), opts);
  return { records, columns: SOTA_COLUMNS };
}
