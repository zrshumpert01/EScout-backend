# Security Review — Exclude MS 16th-Section Trust Land by Unit Name

## Summary
Follow-up fix to the public-land overlay. The prior fix (see
`SECURITY_REVIEW_public_land_fallback.md`) hardened the NETL fallback path but did not
address the root cause on the **primary** PAD-US path, which is what's actually serving
most tiles in production. This change closes that gap.

## Root cause
Mississippi's entire 640,000+ acre 16th-Section Public School Trust Lands program (private,
school-district-leased land — not open to the public) is digitized in PAD-US as a **single
multi-part feature**: `Unit_Nm = 'Mississippi 16th Section Public School Trust Lands'`,
`Own_Name = 'SLB'`, `GIS_Acres = 646179` — one polygon ring per leased square-mile section
statewide. PAD-US tags this record `Pub_Access = 'OA'` (Open Access), so the existing
`Pub_Access <> 'XA'` filter never excluded it. This is the land the user saw reappearing on
the map (rendered as a grid of small green squares, one per leased section) — verified as the
same phenomenon by cross-referencing the app's rendering color, the recurring ~6-mile grid
spacing (matches the standard township grid, since section 16 recurs once per township), and
public sources describing 16th-section trust land as "one square-mile section in nearly every
36-square-mile township."

## Fix
Added `AND Unit_Nm <> 'Mississippi 16th Section Public School Trust Lands'` to the primary
PAD-US filter, in both:
- `app.js` (`PADUS_ACCESS_FILTER` — reference constant only; not on the live request path)
- `api_server.py` (`PADUS_PRIMARY_LAYER_DEFS` — the filter actually sent to
  `edits.nationalmap.gov`, used by every live tile request)

Verified directly against the live ArcGIS service (`/query` and `/export` endpoints) before
deploying:
- The new combined filter is accepted by both endpoints (no WAF/syntax rejection).
- It removes exactly the one problem record.
- It leaves the state's other `Own_Name='SLB'` records fully visible and unaffected: Red Creek
  Wildlife Management Area (`Pub_Access='RA'`) and small "State Lands" parcels
  (`Pub_Access='OA'`/`'UK'`), confirming the exclusion is surgical, not a blanket own-name ban.
- The NETL fallback path already excludes this same record (it shares `own_type='STAT'`,
  `own_name='SLB'`) via the fallback filter shipped in the prior fix, so both serving paths are
  now consistent.

## Scope of change
- Backend-only functional change (one `WHERE`-clause literal added to an existing filter
  constant); no new external hosts, no new endpoints, no schema changes.
- `app.js` touched only to keep its unused reference constant consistent with the backend
  (it does not sit on the live tile-request path — `USGS_PADUS_TILES` calls the backend, not
  this constant directly) — cache-bust version bumped anyway per standing convention since the
  file changed (`liveshare2` → `16thsection1`, synced across `sw.js` `CACHE_NAME` and
  `index.html` `?v=` tags).
- No secrets touched. Secret-grepped the diff before commit — clean.
- Filter change strictly narrows what's shown (never broadens); worst-case failure mode is
  identical to before this fix (record reappears), not a new failure mode.

## Verification before deploy
- `python3 -m py_compile` / `ast.parse` on `api_server.py` — clean.
- JS syntax check on `app.js` — clean.
- Live query against `edits.nationalmap.gov` with the new filter confirms exactly one record
  (the 16th-section aggregate) is excluded from the state+Alabama border test bbox, and no
  other legitimate public-land record is affected.
