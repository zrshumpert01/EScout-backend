# EScout Security Review — Public-Land Fallback Filter Fix

**Date:** 2026-09-08
**Scope:** `api_server.py` — `/api/tiles/public-land` endpoint only. No frontend files changed.

## What changed

1. **Retry hardening on the primary PAD-US request.** The primary tile fetch
   (`edits.nationalmap.gov`) now retries once (with a 0.4s backoff) and uses a 10s timeout
   instead of a bare single attempt at 6s, before falling through to the DOE NETL fallback.
   Purpose: minimize how often transient network blips on the primary source trigger the
   weaker fallback path below.
2. **Tightened the NETL fallback's `where` filter.** Added
   `AND NOT (own_type = 'STAT' AND own_name IN ('SLB', 'OTHS', 'UNK'))` to
   `NETL_FALLBACK_WHERE`, excluding the ambiguous "State Land Board / Other or Unknown State
   Land" ownership bucket (which mixes genuinely open land with closed/leased state-trust
   parcels, e.g. Mississippi's 16th-Section school-trust program) from the fallback data
   source. Named categories (State Fish & Wildlife/WMAs, State Parks, Federal, City, County)
   are unaffected.
3. Added `own_name` to the fallback query's `outFields` (was `category,own_type`) so the field
   used in the new filter is also returned, for future debugging.

## Why this is safe

- **No new external hosts, no new credentials, no secrets touched.** Both endpoints
  (`edits.nationalmap.gov`, `arcgis.netl.doe.gov`) were already called by this route before
  this change; only the query parameters and retry behavior changed.
- **No user data involved.** This endpoint takes only a map bounding box and returns a public
  land-ownership tile image — no auth, no PII, no write to any datastore.
- **Fail-safe unchanged.** Both sources failing still degrades to a blank transparent tile
  (`_blank_tile()`), never a 500 or broken image — same behavior as before.
- **Filter is strictly narrower, never broader.** The new `where` clause only *removes*
  additional records from what the fallback would have shown; it cannot cause previously
  hidden land to appear.
- **Verified against live data before deploying:** a live query comparison (old filter vs. new
  filter) over Mississippi showed the new filter drops 90 of 1,496 statewide records (all in
  the ambiguous SLB/OTHS/UNK bucket) while a spot-check near the user's home region confirmed
  legitimate Federal (FWS, NPS), City, and named State Park records are unaffected.

## Trade-offs / known limitations

- The NETL fallback source has no `Pub_Access`-equivalent field, so this is a best-effort
  approximation based on ownership-name codes, not a perfect parity with the primary source's
  closed-access filter. Some ambiguous state land that's actually open could now be
  under-included when the fallback is used; the retry hardening in change #1 is intended to
  make hitting the fallback path itself rare.
- No changes to authentication, secrets, CORS policy, or any other endpoint.
