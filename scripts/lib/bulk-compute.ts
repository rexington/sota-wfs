/**
 * Bulk AZ computation for whole associations from local DEM windows,
 * bypassing opentopodata's public rate limit entirely. Port of the old
 * Python version's sota_wfs/bulk_az.py.
 *
 * Instead of asking api.activation.zone for a coarse bbox per summit
 * (thousands of requests to a free service), the grid starts at a 500 m
 * half-width and doubles whenever the ring touches the grid edge (or no
 * contour closes), capped at 32 km (W5T/ST-043's ring runs 27 km south of
 * its summit). Only flat-country summits ever widen past 4 km, so the big
 * grids stay rare. A summit whose AZ still won't close at the cap is
 * reported as a failure rather than a clipped polygon.
 */
import { buildGrid, ringFromGrid } from "../../src/az/compute";
import type { Dem } from "./dem";

const START_HALF_M = 500.0;
const MAX_HALF_M = 32_000.0;

export interface BulkResult {
  ok: boolean;
  ring?: number[][];
  error?: string;
}

function touchesEdge(ring: number[][], nodeLat: number[], nodeLon: number[]): boolean {
  const step = 1.5 * (nodeLat[0]! - nodeLat[1]!);
  const lonLo = nodeLon[0]! + step;
  const lonHi = nodeLon[nodeLon.length - 1]! - step;
  const latLo = nodeLat[nodeLat.length - 1]! + step;
  const latHi = nodeLat[0]! - step;
  return ring.some(([x, y]) => x! < lonLo || x! > lonHi || y! < latLo || y! > latHi);
}

export async function computeOneLocal(
  dem: Dem,
  lat: number,
  lon: number,
  alt: number,
): Promise<BulkResult> {
  try {
    let half = START_HALF_M;
    let ring: number[][] | null = null;
    while (true) {
      const dlat = half / 111320.0;
      const dlon = half / (111320.0 * Math.cos((lat * Math.PI) / 180));
      const { nodeLat, nodeLon } = buildGrid(lat, [lon - dlon, lat - dlat, lon + dlon, lat + dlat]);
      const V = await dem.grid(nodeLat, nodeLon);
      ring = ringFromGrid(lat, lon, alt, nodeLat, nodeLon, V);
      if (half >= MAX_HALF_M || (ring !== null && !touchesEdge(ring, nodeLat, nodeLon))) break;
      half *= 2;
    }
    if (ring === null) {
      return { ok: false, error: `no closed ring within ${MAX_HALF_M / 1000} km grid` };
    }
    return { ok: true, ring };
  } catch (exc) {
    return { ok: false, error: String(exc) };
  }
}
