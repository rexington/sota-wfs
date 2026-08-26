export type PropValue = string | number | null;

/** One feature: a stable id (assigned once at fetch time), geometry lon/lat
 * at full precision, and exactly the layer's declared columns as properties
 * (which for SOTA happens to include Longitude/Latitude; for Superchargers
 * it does not — geometry and properties are independent). */
export interface FeatureRecord {
  id: number;
  lon: number;
  lat: number;
  props: Record<string, PropValue>;
}

export interface LayerManifest {
  version: string;
  bbox: [number, number, number, number]; // minx, miny, maxx, maxy
  columns: string[];
  featureCount: number;
  tileDegrees: number;
  /** Whether a full.json blob was written for this version — false for
   * datasets too large to usefully parse whole (see FULL_BLOB_MAX_BYTES in
   * manifest.ts). When false, BBOX-less or too-wide-BBOX requests must be
   * rejected rather than attempting a full scan. */
  hasFullBlob: boolean;
}

export interface LayerDef {
  /** Local layer name, e.g. "SOTA_Summits". */
  name: string;
  /** Namespace prefix, e.g. "sota". */
  ns: string;
  title: string;
  abstract: string;
  /** R2 key prefix, e.g. "sota" or "superchargers". */
  prefix: string;
  /** Property that uniquely identifies a record, if any — enables the
   * compact code->{tileKey,id} index used for single-record lookups
   * (/summit/, /az/) without parsing the full dataset. */
  keyProp?: string;
  /** Whether it's worth attempting a full.json blob for this layer. Only
   * safe for datasets small enough that JSON.stringify(records) won't push
   * a 128 MB Workers isolate over its (non-configurable) memory ceiling —
   * the real ~171k-row SOTA dataset measures ~95 MB serialized, so it must
   * never take this path; superchargers (~3k features) comfortably can. */
  tryFullBlob?: boolean;
}

export const LAYERS: Record<string, LayerDef> = {
  sota_summits: {
    name: "SOTA_Summits",
    ns: "sota",
    title: "SOTA Summits",
    abstract: "Summits on the Air (SOTA) summit locations",
    prefix: "sota",
    keyProp: "SummitCode",
  },
  tesla_superchargers: {
    name: "Tesla_Superchargers",
    ns: "sota",
    title: "Tesla Superchargers",
    abstract: "Tesla Supercharger locations, from the alternative fuel stations API",
    prefix: "superchargers",
    tryFullBlob: true,
  },
};

export function qname(layer: LayerDef): string {
  return `${layer.ns}:${layer.name}`;
}

export function resolveTypename(raw: string): LayerDef | undefined {
  const local = raw.split(":").pop()?.trim().toLowerCase();
  if (!local) return undefined;
  return Object.values(LAYERS).find((l) => l.name.toLowerCase() === local);
}
