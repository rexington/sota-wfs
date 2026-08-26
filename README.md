# sota-wfs — SOTA & Tesla Superchargers → CalTopo

A minimal WFS server, on Cloudflare Workers, that publishes SOTA (Summits on
the Air) summit locations and Tesla Supercharger locations for consumption
in CalTopo.

CalTopo only ever issues two request shapes — `GetCapabilities` and
`GetFeature` with a BBOX, GeoJSON output — so the server implements exactly
that and nothing more. There is no origin server to keep running, no
tunnel, no local machine: fetch, storage, and serving all run on
Cloudflare, reachable at a stable custom domain.

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

Not yet ported from the previous Python version: the offline
bulk-precompute and SOTL.as-validation tools (`bulk_az`, `az_area`,
`az_compare`). They never ran as part of the live service; the originals
are still available in git history before the Cloudflare Workers
migration.

## Layers served (namespace `sota`)

| Typename | Fields (popup subset in bold) |
|---|---|
| `sota:SOTA_Summits` | All 17 summit-list columns plus **`SOTLAS`** (link to <https://sotl.as>) and **`Activations`** (activation count as a string, so "0" still displays) |
| `sota:Tesla_Superchargers` | **`title`**, **`address`**, **`stalls`**, **`power_kw`**, **`access`**, plus `street`, `city`, `state`, `zip`, `connectors`, `pricing`, `phone` |

Supercharger field notes: `stalls` = DC fast-charge stall count, `power_kw` =
highest connector power at the site, `access` = hours plus NACS notes. The
extra columns are served but omitted from the CalTopo templates below — any
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

## CalTopo integration

Public URL (stable, custom domain): `https://wfs.ke6mt.us`

### Auto-configuration (Add → WFS Source → Auto-Configure URL)

```
https://wfs.ke6mt.us/geoserver/sota/wfs?service=WFS&version=2.0.0&request=GetCapabilities
```

### Manual layer templates (Add → WFS Source → URL Template)

SOTA summits, limited fields (label: `SummitName` or `SummitCode`):

```
https://wfs.ke6mt.us/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&BBOX={bottom},{left},{top},{right}&OUTPUTFORMAT=application/json&TYPENAMES=sota:SOTA_Summits&PROPERTYNAME=SummitCode,SummitName,Points,BonusPoints,Activations,SOTLAS,the_geom
```

SOTA summits, all fields: drop the `PROPERTYNAME` parameter.

Tesla Superchargers (label: `title`):

```
https://wfs.ke6mt.us/geoserver/wfs?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&BBOX={bottom},{left},{top},{right}&OUTPUTFORMAT=application/json&TYPENAMES=sota:Tesla_Superchargers&PROPERTYNAME=title,address,stalls,power_kw,access,the_geom
```

Use "Save To Account" in the WFS Source dialog to make a layer available on
every map (it appears under Your Data → Layers and in the "Your Overlays"
list). Note each "Save To Account" click creates a new copy — prune old ones
in Your Data → Layers (row → ⓘ → DELETE).

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
