# Security Review — PAD-US Primary Tile Path: Query+Rasterize Instead of Broken /export Filter

**Date:** 2026-09-08
**Scope:** Backend only (`api_server.py`). No frontend files touched, no cache-bust bump required.

## What was actually wrong

The previous fix (Unit_Nm exclusion for Mississippi's 16th-Section trust land) was applied to
`layerDefs`, a parameter sent to the PAD-US MapServer's `/export` endpoint alongside
`dynamicLayers` (used for custom outline styling). Live testing today proved this parameter is
**silently ignored** by the upstream server whenever `dynamicLayers` is present: requests sent
with `layerDefs` set to the real filter, to `1=1` (match everything), and to `1=0` (match
nothing) all returned **byte-identical images** — proof no filter was ever actually being
applied on that code path, despite every request returning `200 OK`. This means the closed-access
filter, the Proclamation-category filter, and the 16th-section exclusion had **never worked in
production** on the primary tile path; only the rarely-used NETL fallback ever applied a filter.

Moving the filter to the ArcGIS-documented `dynamicLayers[0].definitionExpression` field does
get respected by the server for a single condition — but a WAF in front of that host 404s any
request combining two or more conditions with `AND` inside that JSON parameter (confirmed:
each condition alone succeeds; every 2-condition combination 404s). So the real 3-condition
filter could never reach the server via `/export` at all, regardless of how it was expressed.

## The fix

Replaced the `/export`-based primary tile path with a query-and-rasterize approach: query the
same MapServer's plain `/query` endpoint (flat `where` parameter, not JSON-nested — confirmed
this path has neither the ignored-parameter bug nor the WAF 404) for geometry + attributes
within the tile's bbox, then rasterize the returned polygons ourselves using the same drawing
helper already in use for the NETL fallback. This is the same defense-in-depth pattern the
codebase already uses for the fallback source, just applied to the primary source too.

## Verification

- Direct `/query` call with the full 3-condition filter against a known-affected bbox (West
  Point, MS area) returned exactly 29 features, none of which is the 16th-section record and
  none of which match the small-grid-square pattern.
- Rasterized those 29 features locally and visually confirmed: no grid squares, legitimate
  small parks and a WMA polygon render correctly.
- Confirmed the old `/export` path was returning byte-identical tiles for `where=1=0`,
  `where=1=1`, and the real filter — i.e., provably filtering nothing — which is the actual
  root cause of the fix "not working" despite being correctly deployed.

## Risk / trust boundary notes

- No new external inputs are trusted; `bbox` is still parsed and validated the same way.
- No secrets, keys, or credentials touched.
- Failure mode unchanged: any error still degrades to a blank transparent tile (never a 500 or
  broken image), and the NETL fallback is still tried second exactly as before.
- Slightly higher primary-path latency (measured ~0.9s for a feature-dense tile, previously a
  passthrough image request) — acceptable, and still bounded by the same 10s timeout with one
  retry before falling back to NETL.
