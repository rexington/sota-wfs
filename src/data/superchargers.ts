/**
 * Fetch, validate, and normalize Tesla Supercharger locations from the
 * alt-fuel-stations API — port of fetch/fetch_superchargers.py (download +
 * validate) and sota_wfs/loaders.py:nrel_geojson_loader.
 */
import type { FeatureRecord, PropValue } from "./types";

const MIN_FEATURES = 50;

const NREL_MARKER_COLOR = "#ffaa00";
const NREL_MARKER_SYMBOL = "electric-charging";

export const SUPERCHARGER_COLUMNS = [
  "title",
  "address",
  "street",
  "city",
  "state",
  "zip",
  "stalls",
  "power_kw",
  "connectors",
  "pricing",
  "access",
  "phone",
  "marker-color",
  "marker-symbol",
];

export function superchargersUrl(apiKey: string): string {
  const params = new URLSearchParams({
    api_key: apiKey,
    fuel_type: "ELEC",
    ev_network: "Tesla",
    status: "E",
    limit: "all",
  });
  return `https://developer.nlr.gov/api/alt-fuel-stations/v1.geojson?${params}`;
}

export async function fetchSuperchargersGeojson(apiKey: string): Promise<unknown> {
  const res = await fetch(superchargersUrl(apiKey));
  if (!res.ok) throw new Error(`fetch_superchargers: HTTP ${res.status}`);
  return res.json();
}

interface NrelChargingUnit {
  connectors?: Record<string, { power_kw?: number | null }>;
}

interface NrelProperties {
  [key: string]: unknown;
  ev_charging_units?: NrelChargingUnit[];
}

interface NrelFeature {
  type?: string;
  geometry?: { type?: string; coordinates?: [number, number, ...number[]] };
  properties?: NrelProperties;
}

interface NrelFeatureCollection {
  type?: string;
  features?: NrelFeature[];
}

function maxPowerKw(props: NrelProperties): number | null {
  let best: number | null = null;
  for (const unit of props.ev_charging_units ?? []) {
    for (const conn of Object.values(unit.connectors ?? {})) {
      const kw = conn.power_kw;
      if (kw !== null && kw !== undefined && (best === null || kw > best)) best = kw;
    }
  }
  return best === null ? null : Math.trunc(best);
}

function coerce(v: unknown): PropValue {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(String).join(" ");
  if (typeof v === "number" || typeof v === "string") return v;
  return String(v);
}

export function parseSuperchargers(data: unknown): { records: FeatureRecord[]; columns: string[] } {
  const fc = data as NrelFeatureCollection;
  if (fc?.type !== "FeatureCollection") {
    throw new Error(`fetch_superchargers: not a FeatureCollection: type=${JSON.stringify(fc?.type)}`);
  }
  const features = fc.features ?? [];
  if (features.length < MIN_FEATURES) {
    throw new Error(`fetch_superchargers: only ${features.length} features (expected > ${MIN_FEATURES})`);
  }

  const records: FeatureRecord[] = [];
  let nextId = 1;

  for (const feat of features) {
    const geom = feat.geometry;
    if (geom?.type !== "Point") continue;
    const [lon, lat] = geom.coordinates ?? [];
    if (lon === null || lon === undefined || lat === null || lat === undefined) continue;

    const p = feat.properties ?? {};
    const address = ["street_address", "city", "state"]
      .map((k) => p[k])
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(", ");

    const props: Record<string, PropValue> = {
      title: coerce(p.station_name),
      address,
      street: coerce(p.street_address),
      city: coerce(p.city),
      state: coerce(p.state),
      zip: coerce(p.zip),
      stalls: coerce(p.ev_dc_fast_num),
      power_kw: coerce(maxPowerKw(p)),
      connectors: coerce(p.ev_connector_types),
      pricing: coerce(p.ev_pricing),
      access: coerce(p.access_days_time),
      phone: coerce(p.station_phone),
      "marker-color": NREL_MARKER_COLOR,
      "marker-symbol": NREL_MARKER_SYMBOL,
    };

    records.push({ id: nextId++, lon: Number(lon), lat: Number(lat), props });
  }

  return { records, columns: SUPERCHARGER_COLUMNS };
}
