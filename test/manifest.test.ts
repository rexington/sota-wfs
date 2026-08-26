import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { publishLayerVersion, publishLayerVersionInPasses, getIndex } from "../src/data/manifest";
import { tileForPoint, TILE_DEGREES } from "../src/data/tiling";
import type { FeatureRecord } from "../src/data/types";

// publishLayerVersion prunes the version from *two* publishes ago, not the
// one just superseded — see the module doc in manifest.ts for why (an
// isolate can hold a cached manifest pointing at the just-superseded
// version for up to RELOAD_CHECK_MS after the flip). This is the one part
// of that fix nothing else exercises: it never runs unless publish happens
// three-plus times against the same prefix.
describe("publishLayerVersion generation pruning", () => {
  const prefix = "prune-test";

  function rec(id: number): FeatureRecord {
    return { id, lon: 0, lat: 0, props: { code: `X${id}` } };
  }

  async function objectsUnder(version: string) {
    return (await env.DATA.list({ prefix: `${prefix}/${version}/` })).objects;
  }

  it("keeps the two most recent generations and deletes the third-oldest", async () => {
    const v1 = await publishLayerVersion(env.DATA, prefix, [rec(1)], ["code"], { keyProp: "code" });
    const v2 = await publishLayerVersion(env.DATA, prefix, [rec(2)], ["code"], { keyProp: "code" });
    expect(v1.version).not.toBe(v2.version);

    // Only one generation exists so far: nothing to prune yet.
    expect((await objectsUnder(v1.version)).length).toBeGreaterThan(0);

    const v3 = await publishLayerVersion(env.DATA, prefix, [rec(3)], ["code"], { keyProp: "code" });
    expect(v2.version).not.toBe(v3.version);

    // v1 is now two generations behind current (v3) and should be pruned;
    // v2 (one generation behind) and v3 (current) must both survive.
    expect(await objectsUnder(v1.version)).toEqual([]);
    expect((await objectsUnder(v2.version)).length).toBeGreaterThan(0);
    expect((await objectsUnder(v3.version)).length).toBeGreaterThan(0);
  });
});

// The pass-based publisher exists purely as a memory-bounded rewrite of the
// all-at-once one (see manifest.ts's doc on publishLayerVersionInPasses) —
// it must produce byte-identical tiles/index/manifest for the same input,
// regardless of how many passes it's split across.
describe("publishLayerVersionInPasses matches publishLayerVersion", () => {
  function scatteredRecords(n: number): FeatureRecord[] {
    // Spread across a grid of tiles so multiple passes and multiple tiles
    // both actually get exercised, not just one bucket.
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      lon: -170 + (i % 12) * 17,
      lat: -80 + Math.floor(i / 12) * 13,
      props: { code: `S${i}`, n: i },
    }));
  }

  async function tileContentsByKey(prefix: string, version: string) {
    const list = await env.DATA.list({ prefix: `${prefix}/${version}/tiles/` });
    const out: Record<string, FeatureRecord[]> = {};
    for (const obj of list.objects) {
      const tk = obj.key.split("/tiles/")[1]!.replace(/\.json$/, "");
      const body = await env.DATA.get(obj.key);
      out[tk] = await body!.json<FeatureRecord[]>();
    }
    return out;
  }

  it("produces the same tiles, index, and manifest either way", async () => {
    const records = scatteredRecords(60);
    const columns = ["code", "n"];

    const direct = await publishLayerVersion(env.DATA, "cmp-a", records, columns, { keyProp: "code" });
    const passed = await publishLayerVersionInPasses(env.DATA, "cmp-b", columns, "code", 4, (onRow) => {
      for (const r of records) onRow(r, tileForPoint(r.lon, r.lat, TILE_DEGREES));
    });

    expect(passed.featureCount).toBe(direct.featureCount);
    expect(passed.bbox).toEqual(direct.bbox);
    expect(passed.tileDegrees).toBe(direct.tileDegrees);

    const [indexA, indexB] = await Promise.all([
      getIndex(env.DATA, "cmp-a", direct.version),
      getIndex(env.DATA, "cmp-b", passed.version),
    ]);
    const sortRows = (rows: [string, string, number][] | null) => [...(rows ?? [])].sort();
    expect(sortRows(indexB)).toEqual(sortRows(indexA));

    const [tilesA, tilesB] = await Promise.all([
      tileContentsByKey("cmp-a", direct.version),
      tileContentsByKey("cmp-b", passed.version),
    ]);
    expect(Object.keys(tilesB).sort()).toEqual(Object.keys(tilesA).sort());
    for (const tk of Object.keys(tilesA)) {
      const byId = (recs: FeatureRecord[]) => [...recs].sort((a, b) => a.id - b.id);
      expect(byId(tilesB[tk]!)).toEqual(byId(tilesA[tk]!));
    }
  });
});
