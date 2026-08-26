# sota-wfs — SOTA & Tesla Superchargers → CalTopo

A minimal WFS server, on Cloudflare Workers, that publishes SOTA (Summits on
the Air) summit locations and Tesla Supercharger locations for consumption
in CalTopo.

CalTopo only ever issues two request shapes — `GetCapabilities` and
`GetFeature` with a BBOX, GeoJSON output — so the server implements exactly
that and nothing more. There is no origin server to keep running, no
tunnel, no local machine: fetch, storage, and serving all run on
Cloudflare, reachable at a stable custom domain.

## CalTopo integration

Public URL (stable, custom domain — you'll paste this into CalTopo, nothing
to install): `https://wfs.ke6mt.us`

### What you'll see once it's added

- **SOTA summits** — one marker per summit, drawn as a numbered circle
  colored by point value (green for 1-point summits up through red for
  10-point summits, matching [SOTL.as](https://sotl.as)'s own color scale).
  Clicking a summit shows its name, points, bonus points, activation count,
  and a link to its SOTL.as page. Zoom in on a summit far enough that your
  visible map spans less than about 25 miles (40 km) top-to-bottom and a
  translucent orange **activation zone** ring appears — the area within 25
  vertical meters of the true summit, i.e. where you need to be standing to
  log a valid activation. That ring is computed from elevation data the
  first time anyone views that summit and cached forever after; if you're
  the first person to zoom in on a given summit it can take a minute or two
  to show up — pan away and back, or see
  [Troubleshooting](#troubleshooting) if it never does.
- **Tesla Superchargers** — one marker per site; clicking it shows the
  address, DC fast-charge stall count, top connector power, and access
  hours.

Both layers refresh themselves automatically (summits daily, superchargers
weekly) — there's nothing to re-add or re-sync later.

### Quick setup: add both layers at once (recommended)

This is the easiest path and the one to use unless you specifically want to
hand-pick which fields show in the popup (see Manual setup below).

1. In CalTopo, open a map and use **Add → WFS Source**.
2. Choose **Auto-Configure URL** and paste in:

   ```
   https://wfs.ke6mt.us/geoserver/sota/wfs?service=WFS&version=2.0.0&request=GetCapabilities
   ```

3. CalTopo reads that URL and offers both layers — **SOTA_Summits** and
   **Tesla_Superchargers** — pre-filled with every available field. Add
   whichever ones you want (or both).
4. Each becomes a normal overlay layer on the map: toggle it on/off from
   the layer list, and it'll only load/draw features inside your current
   view (that's why panning or zooming can take a moment to populate —
   CalTopo is asking the server for just what's on screen).

### Manual setup: one URL per layer, with just the fields you want

Use this if you want a specific field as the marker label (Auto-Configure
always ends up using the feature ID), or you only want a subset of columns
in the popup.

1. In CalTopo, use **Add → WFS Source**, then choose **URL Template**
   instead of Auto-Configure.
2. Paste in one of the templates below, verbatim — CalTopo fills in
   `{bottom}`,`{left}`,`{top}`,`{right}` itself as you pan/zoom.
3. After adding, open the layer's settings and set **Label Name** to the
   field you want shown on the map (suggested per layer below) — without
   this, markers show a generic feature ID instead of a name.

**SOTA summits, common fields** (set Label Name to `SummitName`):

```
https://wfs.ke6mt.us/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&BBOX={bottom},{left},{top},{right}&OUTPUTFORMAT=application/json&TYPENAMES=sota:SOTA_Summits&PROPERTYNAME=SummitCode,SummitName,Points,BonusPoints,Activations,SOTLAS,the_geom
```

**SOTA summits, every field** (all 17 source columns plus SOTL.as link and
activation count): same as above with the `&PROPERTYNAME=...` part removed
entirely.

**Tesla Superchargers** (set Label Name to `title`):

```
https://wfs.ke6mt.us/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&BBOX={bottom},{left},{top},{right}&OUTPUTFORMAT=application/json&TYPENAMES=sota:Tesla_Superchargers&PROPERTYNAME=title,address,stalls,power_kw,access,the_geom
```

Want more Supercharger fields in the popup (`street`, `city`, `state`,
`zip`, `connectors`, `pricing`, `phone` are all available but omitted
above to keep the popup short)? Add them to the `PROPERTYNAME` list,
comma-separated, in any order.

### Making a layer permanent

Whichever setup path you used, the new layer only applies to the map you
were editing until you save it. In the WFS Source dialog (or the layer's
own settings afterward), use **Save To Account** to make it available on
every map you open — it'll then show up under **Your Data → Layers** and
in the **Your Overlays** picker on any map. Each "Save To Account" click
creates a separate saved copy, so if you're experimenting with field
choices, delete the old copy first (Your Data → Layers → row → ⓘ →
DELETE) rather than accumulating duplicates.

### Other apps (Gaia GPS, onX)

Not supported today, and not a config issue on this end — neither app has
anything comparable to CalTopo's live WFS source, so there's no URL to
paste in for them:

- **Gaia GPS** only accepts raster tile sources (TMS, or WMTS converted
  from an ArcGIS REST endpoint). WMS/WFS data has to be pre-converted to
  tiles with separate tools (QGIS + Mapbox Studio) before Gaia will take
  it at all — not a "paste this URL" workflow, and the per-summit
  click-to-see-popup behavior wouldn't survive being flattened into tiles
  anyway.
- **onX** doesn't expose any live external layer source. Its only import
  path is a one-time GPX/KML file (capped at 4 MB / 3,000 markups) — a
  snapshot you'd have to re-export and re-import by hand, not a
  periodically-refreshing feed.

If either of these becomes worth doing, the right fix is adding a small
export endpoint to this Worker (e.g. `/summit/*.gpx`) you could
re-download occasionally — not a client-side workaround.

## Components

- `src/index.ts` — Hono app: `/geoserver` WFS routes (`GetCapabilities`,
  `GetFeature`, `DescribeFeatureType`), plus `/summit/<ref>.geojson` and
  `/az/<ref>.geojson` single-record downloads.
- `src/scheduled.ts` — Cron Trigger handler: fetches and validates the SOTA
  summit list (daily) and Tesla Supercharger locations (weekly), then
  publishes them. A bad fetch (wrong header, too few rows/features) is
  never published — the previous good data keeps serving.
- **R2** (`sota-wfs-data` bucket) — each publish writes a new version's
  worth of bbox-tiled data (5°×5° tiles, `src/data/tiling.ts`) plus a
  compact `code → tile` lookup index, under a fresh version prefix;
  `current.json` is flipped last so a `GetFeature` request never observes a
  half-written generation. Two generations back are pruned automatically.
  A `GetFeature` with a BBOX (which is what CalTopo always sends) only
  reads the handful of tiles the view overlaps — never the whole dataset.
- **KV** (`AZ_CACHE` namespace) — one key per summit's cached activation-zone
  ring. Computed once, served forever; see [Activation zones](#activation-zones-az)
  below.
- **Durable Object** (`AzQueueDO`) — the single global coordinator for AZ
  polygon computation: a rate-limited (~1 req/s), daily-budgeted (900
  calls) queue driven by alarms, replacing what used to be an in-process
  thread in the old Python version.
- `scripts/measure-tiling.ts` — local diagnostic: fetches the real SOTA CSV
  and reports tile counts/sizes and a few data-shape sanity checks. Run
  with `npx tsx scripts/measure-tiling.ts` before changing anything in
  `src/data/` — the real dataset (~171k rows) is what forced several of
  this project's design decisions (see git log).

- `scripts/bulk-az.ts` — local bulk-precompute for AZ rings; see
  [Bulk AZ precompute](#bulk-az-precompute) below.

Not yet ported from the previous Python version: the offline
SOTL.as-validation tool (`az_compare`). It never ran as part of the live
service; the original is still available in git history before the
Cloudflare Workers migration.

## Layers served (namespace `sota`)

| Typename | Fields (popup subset in bold) |
|---|---|
| `sota:SOTA_Summits` | All 17 summit-list columns plus **`SOTLAS`** (link to <https://sotl.as>) and **`Activations`** (activation count as a string, so "0" still displays) |
| `sota:Tesla_Superchargers` | **`title`**, **`address`**, **`stalls`**, **`power_kw`**, **`access`**, plus `street`, `city`, `state`, `zip`, `connectors`, `pricing`, `phone` |

Supercharger field notes: `stalls` = DC fast-charge stall count, `power_kw` =
highest connector power at the site, `access` = hours plus NACS notes. The
extra columns are served but omitted from the CalTopo templates above — any
future template can re-include them via `PROPERTYNAME` without code changes.

### Activation zones (AZ)

SOTA summit points can carry an AZ polygon (the area within 25 vertical
meters of the summit). Rings are computed from a coarse bound
(api.activation.zone) plus a fine elevation grid (opentopodata), and are
**only ever computed once per summit**: a successful ring is cached in KV
permanently and never recomputed, since a summit's terrain doesn't change.
A failed computation is retried after 7 days. Polygons are only served
when the map is zoomed in enough (bbox lat span < 0.4°); a cache miss is
queued to `AzQueueDO` and appears on a later pan/refresh — never computed
synchronously in the request path, since the elevation API is slow and
rate-limited.

There's currently no automatic invalidation if a summit's official
coordinates/altitude change in the SOTA database — a real gap, but a rare
one (on the order of a handful of summits a year), and not yet worth the
tooling.

### Bulk AZ precompute

The on-demand queue (`AzQueueDO`) is rate-limited to opentopodata's public
budget (~1 req/s, 900 calls/day), so a summit you've never zoomed in on
before can take a while to get its ring — and a whole under-visited region
can outright exhaust the daily budget before working through its backlog.
`scripts/bulk-az.ts` sidesteps this for a one-off backfill: it reads
elevation directly from the public USGS 3DEP 1/3-arcsecond COGs on AWS via
HTTP range requests (`scripts/lib/dem.ts`, using `geotiff.js` — no local
DEM download, no server to run, no rate limit), computes rings locally, and
writes straight into the real `AZ_CACHE` KV namespace. The live Worker
then just serves what's already cached — no further computation needed.

Only covers the continental US/Alaska (that's the 3DEP tileset's extent).
Run it from your machine, not from a Worker:

```sh
npx tsx scripts/bulk-az.ts W6 W7O W7W [--limit N] [--concurrency N]
```

Notes:

- Prefixes match the leading part of `SummitCode` (e.g. `W7` covers every
  `W7*` region, `W7O` just that one). Pass as many as you like in one run.
- Already-cached summits — success *or* a prior failure — are skipped, so
  reruns are cheap and safe; only delete a KV entry first
  (`npx wrangler kv key delete "az:<ref>" --namespace-id <id> --remote`) to
  force a recompute.
- `--concurrency` (default 8) is local HTTP range-request parallelism
  against S3, unrelated to the live Worker's opentopodata budget — bump it
  freely.
- Takes a few ms/summit once DEM tiles are warm in the in-process cache;
  sorted by DEM tile name first so neighboring summits hit the same tile
  back-to-back. A run across a large, sparse region (thousands of summits)
  still takes several minutes.
- Requires `npx wrangler login` once (uses `wrangler kv key list`/
  `bulk put` under the hood against the real namespace) — no `NREL_API_KEY`
  or opentopodata access needed.
- Occasionally one of the `wrangler kv` subprocess calls fails with
  `Authentication error [code: 10000]` even with a valid, working login —
  a known wrangler OAuth-token-refresh race, not a real credential problem.
  Just rerun; already-cached summits are skipped so nothing is repeated.

## Deployment

Prerequisites: Node 20+, a Cloudflare account with the Workers Paid plan
(required for Durable Objects, and for the CPU time a 171k-row daily CSV
parse needs), and a zone you control on Cloudflare for the custom domain.

```sh
npm install
npx wrangler login                                  # once per machine
npx wrangler r2 bucket create sota-wfs-data          # matches wrangler.jsonc's r2_buckets
npx wrangler kv namespace create AZ_CACHE            # paste the returned id into wrangler.jsonc's kv_namespaces
npx wrangler deploy
```

`wrangler.jsonc` pins the custom domain (`routes`), the two cron schedules,
and the Durable Object migration — review it before deploying to a
different account/domain.

Optional, for a personal (non-`DEMO_KEY`) NREL rate limit on the
Supercharger fetch:

```sh
npx wrangler secret put NREL_API_KEY   # production — prompts, never touches your shell history
cp .dev.vars.example .dev.vars         # local `wrangler dev` — git-ignored
```

The Worker won't have data until its first successful fetch. Cron Triggers
don't run on demand, so trigger the first one manually:

```sh
npx wrangler dev --test-scheduled --remote &
curl "http://localhost:8787/__scheduled?cron=0+8+*+*+*"    # SOTA summits
curl "http://localhost:8787/__scheduled?cron=0+9+*+*+1"    # Tesla Superchargers
```

(`--remote` here means the local dev process reads/writes the *real*
deployed R2/KV/DO — this is the sanctioned way to test-fire a deployed
Worker's scheduled handler; `/__scheduled` doesn't exist on the live
production endpoint itself.)

## Operations

```sh
npx wrangler tail                          # live logs from the deployed Worker
npx wrangler deployments list              # deployment history
npm test                                   # vitest suite (Miniflare-local, no network)
npx tsx scripts/measure-tiling.ts          # real-CSV diagnostic (network, no writes)
```

## Verification

```sh
# capabilities list both layers and advertise application/json
curl -fsS 'https://wfs.ke6mt.us/geoserver/sota/wfs?service=WFS&version=2.0.0&request=GetCapabilities' | grep -c 'sota:'

# exact CalTopo request shape (Maja Rosit test summit)
curl -fsS 'https://wfs.ke6mt.us/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&BBOX=42.47,19.84,42.50,19.86&OUTPUTFORMAT=application/json&TYPENAMES=sota:SOTA_Summits&PROPERTYNAME=SummitCode,SummitName,Points,BonusPoints,Activations,SOTLAS,the_geom' | jq -M '.features[0]'

# superchargers
curl -fsS 'https://wfs.ke6mt.us/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&BBOX=37.3,-122.1,37.5,-121.9&OUTPUTFORMAT=application/json&TYPENAMES=sota:Tesla_Superchargers' | jq -M '.totalFeatures'
```

## Troubleshooting

- **`GetCapabilities` lists no layers** — the corresponding cron hasn't run
  yet (fresh deploy) or every publish so far has failed validation. Check
  `npx wrangler tail` during the next scheduled run, or trigger one
  manually (see Deployment above).
- **`GetFeature` returns a WFS error mentioning "not yet fetched"** — same
  as above, for that specific layer.
- **`GetFeature` returns a WFS error asking for a BBOX** — the SOTA layer
  is too large to serve without one (see `hasFullBlob` in
  `src/data/types.ts`); this only affects a BBOX-less request or one wide
  enough to span most of the dataset. Real CalTopo traffic always sends a
  tight BBOX and never hits this.
- **Markers labeled with feature IDs** (`Tesla_Superchargers.123`) — the
  layer's "Label Name" doesn't match a property in its `PROPERTYNAME` list;
  edit the layer and set it (e.g. `title`).
- **Stale data** — `npx wrangler tail` around the next scheduled run time;
  the fetcher refuses to replace good data with bad, which is intentional.
- **AZ polygon never appears for a summit** — it's queued, not synchronous;
  give it a pan/refresh a minute or two later. If it never appears, the
  daily 900-call opentopodata budget may be exhausted, or the summit's
  coordinates may not have DEM coverage.

## History

Until 2026-08-26 this ran as a Python/Flask process on a personal machine,
reachable via an ngrok tunnel with two systemd timers doing the data
fetches. See git history before the "Port sota-wfs ... to Cloudflare
Workers" commit for that implementation. Before that (also 2026-08, this
project moves fast), it was a GeoServer pipeline: CSV → ogr2ogr →
GeoPackage → kartoza/geoserver docker container, ngrok run by hand, all
driven from org-babel blocks in an org-roam file — see
`20250925163459-sota_mapserver.org` for the literate version.
