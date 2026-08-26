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

// At a fixed 10 m step (buildGrid's default), a half-width above this holds
// a multi-million-node elevation grid — tens to hundreds of MB per summit,
// as plain JS number[][], not numpy's tight float64 buffers. Flat desert
// terrain (e.g. Nevada's Basin and Range) widens this far routinely, and
// several of those running at once under --concurrency is what blew a
// bulk-az run past Node's heap limit (OOM after ~2150/7433 summits on a
// W7N/W7O/W7W run). Bound how many such grids exist at once, independent
// of overall pool concurrency: small summits stay fully parallel, big ones
// serialize down to a handful in flight.
const LARGE_GRID_HALF_M = 4000.0;
const MAX_CONCURRENT_LARGE_GRIDS = 1;

let largeGridsInFlight = 0;
const largeGridWaiters: (() => void)[] = [];

async function acquireLargeGridSlot(): Promise<void> {
  if (largeGridsInFlight < MAX_CONCURRENT_LARGE_GRIDS) {
    largeGridsInFlight++;
    return;
  }
  await new Promise<void>((resolve) => largeGridWaiters.push(resolve));
  largeGridsInFlight++;
}

function releaseLargeGridSlot(): void {
  largeGridsInFlight--;
  largeGridWaiters.shift()?.();
}

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
      const large = half > LARGE_GRID_HALF_M;
      if (large) await acquireLargeGridSlot();
      let nodeLat: number[];
      let nodeLon: number[];
      try {
        const grid = buildGrid(lat, [lon - dlon, lat - dlat, lon + dlon, lat + dlat]);
        nodeLat = grid.nodeLat;
        nodeLon = grid.nodeLon;
        const V = await dem.grid(nodeLat, nodeLon);
        ring = ringFromGrid(lat, lon, alt, nodeLat, nodeLon, V);
      } finally {
        if (large) releaseLargeGridSlot();
      }
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
