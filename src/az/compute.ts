/**
 * AZ ring computation — port of the compute half of sota_wfs/az.py
 * (ported originally from sota-template/build_caltopo.py): a coarse SRTM
 * AZ from api.activation.zone bounds a ~10 m DEM grid fetched from
 * opentopodata, and marching squares 25 m below the DEM local max near the
 * summit yields the ring containing it.
 *
 * Pure arithmetic/loops — no native deps, translates closely line-for-line.
 */

const AZAPI = "https://api.activation.zone/";
const OPENTOPO = "https://api.opentopodata.org/v1/";

export const AZ_THRES_M = 25; // SOTA activation-zone vertical drop
const SUMMIT_SEARCH_M = 20.0; // DEM local-max search radius around official coords

type Point = readonly [number, number]; // [lon, lat]
type Grid = number[][]; // rows follow nodeLat, cols follow nodeLon

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": "sota-wfs/1.0", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

/** Cheap 30 m SRTM AZ from activation.zone, used only to bound the fine
 * grid. Falls back to a fixed ~400 m box if the service is unavailable. */
export async function coarseBbox(
  ref: string,
  lat: number,
  lon: number,
  alt: number,
): Promise<[number, number, number, number]> {
  try {
    const { ok, status, data } = await postJson(AZAPI, {
      summit_ref: ref,
      summit_lat: lat,
      summit_long: lon,
      summit_alt: Math.round(alt),
      deg_delta: 0.04,
      sota_summit_alt_thres: AZ_THRES_M,
    });
    if (!ok) throw new Error(`activation.zone HTTP ${status}`);
    const wkt: string = data.az;
    const ringStr = wkt.slice(wkt.indexOf("((") + 2, wkt.lastIndexOf("))"));
    const pts = ringStr.split(",").map((p) => p.trim().split(/\s+/).map(Number) as [number, number]);
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  } catch (exc) {
    console.log(`az: ${ref} coarse bbox failed (${exc}); using fixed box`);
    const d = 0.0045;
    return [lon - d, lat - d, lon + d, lat + d];
  }
}

export function buildGrid(
  lat: number,
  bbox: readonly [number, number, number, number],
  marginM = 120.0,
  stepM = 10.0,
): { nodeLat: number[]; nodeLon: number[] } {
  let [lonmin, latmin, lonmax, latmax] = bbox;
  const mlat = marginM / 111320.0;
  const mlon = marginM / (111320.0 * Math.cos((lat * Math.PI) / 180));
  lonmin -= mlon;
  lonmax += mlon;
  latmin -= mlat;
  latmax += mlat;
  const latStep = stepM / 111320.0;
  const lonStep = stepM / (111320.0 * Math.cos((lat * Math.PI) / 180));
  const nlat = Math.ceil((latmax - latmin) / latStep) + 1;
  const nlon = Math.ceil((lonmax - lonmin) / lonStep) + 1;
  const nodeLat = Array.from({ length: nlat }, (_, i) => latmax - i * latStep);
  const nodeLon = Array.from({ length: nlon }, (_, j) => lonmin + j * lonStep);
  return { nodeLat, nodeLon };
}

/** Best opentopodata dataset for a location: 10 m NED over the US, 30 m
 * SRTM where available, ASTER for high latitudes. */
export function datasetFor(lat: number, lon: number): string {
  if (lat >= 17.0 && lat <= 72.0 && lon >= -180.0 && lon <= -64.0) return "ned10m";
  if (lat >= -56.0 && lat <= 60.0) return "srtm30m";
  return "aster30m";
}

export async function fetchElevations(
  url: string,
  nodeLat: number[],
  nodeLon: number[],
  spend: (calls: number) => Promise<void> | void,
): Promise<Grid> {
  const locs: [number, number][] = [];
  for (const la of nodeLat) for (const lo of nodeLon) locs.push([la, lo]);
  const elev: (number | null)[] = [];

  for (let k = 0; k < locs.length; k += 100) {
    const chunk = locs.slice(k, k + 100);
    const q = chunk.map(([la, lo]) => `${la.toFixed(6)},${lo.toFixed(6)}`).join("|");
    let succeeded = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const res = await fetch(`${url}?${new URLSearchParams({ locations: q })}`, {
          headers: { "User-Agent": "sota-wfs/1.0" },
        });
        if (res.ok) {
          await spend(1);
          const d = (await res.json()) as { status?: string; results?: { elevation: number | null }[] };
          if (d.status === "OK") {
            for (const r of d.results ?? []) elev.push(r.elevation);
            succeeded = true;
            break;
          }
        } else {
          await spend(1);
          if (![429, 500, 502, 503].includes(res.status)) {
            throw new Error(`opentopodata HTTP ${res.status}`);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("opentopodata HTTP")) throw err;
        // network-level failure / bad JSON: swallow and retry
      }
      await sleep((2 + attempt) * 1000);
    }
    if (!succeeded) throw new Error(`opentopodata failed at chunk ${k}`);
    await sleep(1100); // public rate limit ~1 req/s
  }

  const nlon = nodeLon.length;
  const V: Grid = [];
  for (let i = 0; i < nodeLat.length; i++) {
    const row: number[] = [];
    for (let j = 0; j < nlon; j++) {
      const v = elev[i * nlon + j];
      row.push(v === null || v === undefined ? -1e9 : v);
    }
    V.push(row);
  }
  return V;
}

function interp(pa: Point, va: number, pb: Point, vb: number, level: number): Point {
  const t = va === vb ? 0.0 : (level - va) / (vb - va);
  return [pa[0] + t * (pb[0] - pa[0]), pa[1] + t * (pb[1] - pa[1])];
}

export function marchingSquares(
  nodeLat: number[],
  nodeLon: number[],
  V: Grid,
  level: number,
): Point[][] {
  const segs: [Point, Point][] = [];
  const ni = nodeLat.length;
  const nj = nodeLon.length;
  for (let i = 0; i < ni - 1; i++) {
    for (let j = 0; j < nj - 1; j++) {
      const TL: Point = [nodeLon[j]!, nodeLat[i]!];
      const vTL = V[i]![j]!;
      const TR: Point = [nodeLon[j + 1]!, nodeLat[i]!];
      const vTR = V[i]![j + 1]!;
      const BR: Point = [nodeLon[j + 1]!, nodeLat[i + 1]!];
      const vBR = V[i + 1]![j + 1]!;
      const BL: Point = [nodeLon[j]!, nodeLat[i + 1]!];
      const vBL = V[i + 1]![j]!;
      const idx =
        (vTL > level ? 1 : 0) | (vTR > level ? 2 : 0) | (vBR > level ? 4 : 0) | (vBL > level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = () => interp(TL, vTL, TR, vTR, level);
      const right = () => interp(TR, vTR, BR, vBR, level);
      const bottom = () => interp(BL, vBL, BR, vBR, level);
      const left = () => interp(TL, vTL, BL, vBL, level);
      if (idx === 1 || idx === 14) segs.push([left(), top()]);
      else if (idx === 2 || idx === 13) segs.push([top(), right()]);
      else if (idx === 3 || idx === 12) segs.push([left(), right()]);
      else if (idx === 4 || idx === 11) segs.push([right(), bottom()]);
      else if (idx === 6 || idx === 9) segs.push([top(), bottom()]);
      else if (idx === 7 || idx === 8) segs.push([left(), bottom()]);
      else if (idx === 5) {
        segs.push([left(), top()]);
        segs.push([right(), bottom()]);
      } else if (idx === 10) {
        segs.push([top(), right()]);
        segs.push([left(), bottom()]);
      }
    }
  }

  const key = (p: Point) => `${Math.round(p[0] * 1e9) / 1e9},${Math.round(p[1] * 1e9) / 1e9}`;
  const adj = new Map<string, [Point, string][]>();
  const add = (k: string, entry: [Point, string]) => {
    const list = adj.get(k);
    if (list) list.push(entry);
    else adj.set(k, [entry]);
  };
  for (const [a, b] of segs) {
    add(key(a), [b, key(b)]);
    add(key(b), [a, key(a)]);
  }

  const rings: Point[][] = [];
  const used = new Set<string>();
  for (const [a] of segs) {
    const ka = key(a);
    if (used.has(ka)) continue;
    const ring: Point[] = [a];
    let ck = ka;
    used.add(ck);
    while (true) {
      const nxts = (adj.get(ck) ?? []).filter(([, pk]) => !used.has(pk));
      if (nxts.length === 0) break;
      const [p, pk] = nxts[0]!;
      ring.push(p);
      used.add(pk);
      ck = pk;
      if (pk === ka) break;
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

export function pointInRing(pt: Point, ring: Point[]): boolean {
  const [x, y] = pt;
  let inside = false;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[(i + 1) % n]!;
    if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1 + 1e-30) + x1) {
      inside = !inside;
    }
  }
  return inside;
}

/** DEM node the AZ cutoff references: the highest valid node within
 * SUMMIT_SEARCH_M of the official coordinates, then a monotone uphill walk
 * from there to the local max. Returns [i, j] or null when everything
 * nearby is nodata.
 *
 * The nearby search absorbs small coordinate/altitude error; the walk
 * absorbs official coordinates that miss the summit by hundreds of meters
 * (mid-slope points read 25+ m low, so the cutoff swept whole valleys).
 * Being monotone, the walk cannot cross a saddle onto a neighboring higher
 * mountain — it stops at the summit's own top. */
export function demReference(
  lat: number,
  lon: number,
  nodeLat: number[],
  nodeLon: number[],
  V: Grid,
): [number, number] | null {
  const mlat = 111320.0;
  const mlon = 111320.0 * Math.cos((lat * Math.PI) / 180);
  let ci = 0;
  for (let i = 1; i < nodeLat.length; i++) {
    if (Math.abs(nodeLat[i]! - lat) < Math.abs(nodeLat[ci]! - lat)) ci = i;
  }
  let cj = 0;
  for (let j = 1; j < nodeLon.length; j++) {
    if (Math.abs(nodeLon[j]! - lon) < Math.abs(nodeLon[cj]! - lon)) cj = j;
  }
  const ri = Math.max(1, Math.ceil(SUMMIT_SEARCH_M / ((nodeLat[0]! - nodeLat[1]!) * mlat)));
  const rj = Math.max(1, Math.ceil(SUMMIT_SEARCH_M / ((nodeLon[1]! - nodeLon[0]!) * mlon)));
  let best: [number, number] | null = null;
  for (let i = Math.max(0, ci - ri); i < Math.min(nodeLat.length, ci + ri + 1); i++) {
    const dy = (nodeLat[i]! - lat) * mlat;
    for (let j = Math.max(0, cj - rj); j < Math.min(nodeLon.length, cj + rj + 1); j++) {
      const dx = (nodeLon[j]! - lon) * mlon;
      if (dx * dx + dy * dy > SUMMIT_SEARCH_M ** 2) continue;
      const v = V[i]![j]!;
      if (v > -1e8 && (best === null || v > V[best[0]]![best[1]]!)) best = [i, j];
    }
  }
  return best === null ? null : ascend(best[0], best[1], V);
}

/** Walk uphill through 8-neighbors until no neighbor is higher. */
export function ascend(i: number, j: number, V: Grid): [number, number] {
  const ni = V.length;
  const nj = V[0]!.length;
  while (true) {
    const cur = V[i]![j]!;
    let bi = i;
    let bj = j;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const y = i + di;
        const x = j + dj;
        if (y >= 0 && y < ni && x >= 0 && x < nj && V[y]![x]! > V[bi]![bj]!) {
          bi = y;
          bj = x;
        }
      }
    }
    if (V[bi]![bj]! <= cur) return [i, j];
    i = bi;
    j = bj;
  }
}

/** Marching squares at the AZ cutoff; returns the closed ring containing
 * the summit (largest ring as fallback), rounded to 6 decimals. The cutoff
 * is 25 m below the DEM local max uphill of the summit (see demReference);
 * the official coordinates and altitude are used only when the DEM has no
 * data there. */
export function ringFromGrid(
  lat: number,
  lon: number,
  alt: number,
  nodeLat: number[],
  nodeLon: number[],
  V: Grid,
): number[][] | null {
  const top = demReference(lat, lon, nodeLat, nodeLon, V);
  let cutoff: number;
  let topPt: Point;
  if (top === null) {
    cutoff = alt - AZ_THRES_M;
    topPt = [lon, lat];
  } else {
    const [i, j] = top;
    cutoff = V[i]![j]! - AZ_THRES_M;
    topPt = [nodeLon[j]!, nodeLat[i]!];
  }
  const rings = marchingSquares(nodeLat, nodeLon, V, cutoff);
  const containing = rings.filter((r) => pointInRing(topPt, r));
  const cont = containing.length > 0 ? containing : rings;
  if (cont.length === 0) return null;
  const best = cont.reduce((a, b) => (b.length > a.length ? b : a));
  // An open contour means the AZ ran off the grid (or the trace broke);
  // closing it with a chord fabricates a straight edge that can even
  // self-intersect. Refuse, so callers widen the grid or report failure.
  const first = best[0]!;
  const last = best[best.length - 1]!;
  if (
    Math.abs(first[0] - last[0]) > 3 * Math.abs(nodeLon[1]! - nodeLon[0]!) ||
    Math.abs(first[1] - last[1]) > 3 * Math.abs(nodeLat[1]! - nodeLat[0]!)
  ) {
    return null;
  }
  const ring = best.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);
  const ringFirst = ring[0]!;
  const ringLast = ring[ring.length - 1]!;
  if (ringFirst[0] !== ringLast[0] || ringFirst[1] !== ringLast[1]) ring.push(ringFirst);
  return ring;
}

export async function computeAz(
  ref: string,
  lat: number,
  lon: number,
  alt: number,
  spend: (calls: number) => Promise<void> | void,
): Promise<number[][] | null> {
  const bbox = await coarseBbox(ref, lat, lon, alt);
  const { nodeLat, nodeLon } = buildGrid(lat, bbox);
  const n = nodeLat.length * nodeLon.length;
  console.log(`az: ${ref} grid ${nodeLat.length}x${nodeLon.length} (~${Math.ceil(n / 100)} elevation calls)`);
  const V = await fetchElevations(OPENTOPO + datasetFor(lat, lon), nodeLat, nodeLon, spend);
  return ringFromGrid(lat, lon, alt, nodeLat, nodeLon, V);
}
