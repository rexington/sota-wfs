/**
 * Windowed elevation reads from USGS 3DEP 1/3-arcsecond COGs on AWS, via
 * HTTP range requests (geotiff.js) — no local DEM download, no server to
 * run. Port of the old Python version's sota_wfs/dem.py (which did the
 * same range-request trick via rasterio/GDAL).
 *
 * Local-script only: geotiff.js and this module are never imported from
 * src/, so they never end up in the deployed Worker bundle.
 */
import { fromUrl, type GeoTIFF, type GeoTIFFImage } from "geotiff";

const TILE_URL = (name: string) =>
  `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/current/${name}/USGS_13_${name}.tif`;

export const NODATA_SENTINEL = -1e9; // matches src/az/compute.ts's null-elevation handling

export class TileMissing extends Error {}

interface Point {
  i: number;
  j: number;
  lat: number;
  lon: number;
}

export class Dem {
  private images = new Map<string, Promise<GeoTIFFImage | null>>();

  /** Tiles are named by their NW corner: n35w120 covers 34..35N, 120..119W. */
  static tileName(lat: number, lon: number): string {
    const ns = String(Math.ceil(lat)).padStart(2, "0");
    const ew = String(Math.ceil(-lon)).padStart(3, "0");
    return `n${ns}w${ew}`;
  }

  private getImage(name: string): Promise<GeoTIFFImage | null> {
    let p = this.images.get(name);
    if (!p) {
      p = (async () => {
        try {
          const tiff: GeoTIFF = await fromUrl(TILE_URL(name));
          return await tiff.getImage();
        } catch {
          return null; // e.g. grid margin crossing into Canada/ocean: clip at data edge
        }
      })();
      this.images.set(name, p);
    }
    return p;
  }

  /** Elevations for the nodeLat x nodeLon mesh, shaped like
   * src/az/compute.ts's fetchElevations return: rows follow nodeLat, cols
   * follow nodeLon. */
  async grid(nodeLat: number[], nodeLon: number[]): Promise<number[][]> {
    const out: number[][] = nodeLat.map(() => new Array<number>(nodeLon.length).fill(NODATA_SENTINEL));

    const byTile = new Map<string, Point[]>();
    for (let i = 0; i < nodeLat.length; i++) {
      for (let j = 0; j < nodeLon.length; j++) {
        const name = Dem.tileName(nodeLat[i]!, nodeLon[j]!);
        const pts = byTile.get(name);
        const pt = { i, j, lat: nodeLat[i]!, lon: nodeLon[j]! };
        if (pts) pts.push(pt);
        else byTile.set(name, [pt]);
      }
    }

    let gotAny = false;
    for (const [name, pts] of byTile) {
      const image = await this.getImage(name);
      if (!image) continue;
      const vals = await this.sample(image, pts);
      for (let k = 0; k < pts.length; k++) {
        const v = vals[k]!;
        out[pts[k]!.i]![pts[k]!.j] = v;
        if (v > -1e8) gotAny = true;
      }
    }
    if (!gotAny) throw new TileMissing(`no DEM coverage for any of ${[...byTile.keys()].join(",")}`);
    return out;
  }

  /** Bilinear sample at each point; matches the old dem.py's Dem._sample. */
  private async sample(image: GeoTIFFImage, pts: Point[]): Promise<number[]> {
    const [minX, minY, maxX, maxY] = image.getBoundingBox();
    const width = image.getWidth();
    const height = image.getHeight();
    // Affine transform, top-left origin: (c, f) is the top-left corner,
    // (a, e) are pixel width/height (e negative since rows increase south).
    const a = (maxX! - minX!) / width;
    const e = -(maxY! - minY!) / height;
    const c = minX!;
    const f = maxY!;
    const nodata = image.getGDALNoData() ?? -999999;

    const cols = pts.map((p) => (p.lon - c) / a - 0.5);
    const rows = pts.map((p) => (p.lat - f) / e - 0.5);
    const r0 = rows.map((r) => Math.min(Math.max(Math.floor(r), 0), height - 2));
    const c0 = cols.map((cc) => Math.min(Math.max(Math.floor(cc), 0), width - 2));
    const fr = rows.map((r, k) => Math.min(Math.max(r - r0[k]!, 0), 1));
    const fc = cols.map((cc, k) => Math.min(Math.max(cc - c0[k]!, 0), 1));

    const minR = Math.min(...r0);
    const maxR = Math.max(...r0);
    const minC = Math.min(...c0);
    const maxC = Math.max(...c0);
    const window = [minC, minR, maxC + 2, maxR + 2];
    const rasters = await image.readRasters({ window });
    const band = (Array.isArray(rasters) ? rasters[0] : rasters) as unknown as ArrayLike<number>;
    const winWidth = window[2]! - window[0]!;

    return pts.map((_, k) => {
      const rr = r0[k]! - minR;
      const cc = c0[k]! - minC;
      const v00 = band[rr * winWidth + cc]!;
      const v01 = band[rr * winWidth + cc + 1]!;
      const v10 = band[(rr + 1) * winWidth + cc]!;
      const v11 = band[(rr + 1) * winWidth + cc + 1]!;
      if (v00 === nodata || v01 === nodata || v10 === nodata || v11 === nodata) {
        return NODATA_SENTINEL;
      }
      return v00 * (1 - fr[k]!) * (1 - fc[k]!) + v01 * (1 - fr[k]!) * fc[k]! + v10 * fr[k]! * (1 - fc[k]!) + v11 * fr[k]! * fc[k]!;
    });
  }
}
