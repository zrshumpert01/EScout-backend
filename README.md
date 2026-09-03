# EScout — AI Whitetail Scouting & Hunting Maps

A hunting-map prototype with land ownership lookups, offline-style saved maps, and **Scout AI** — a
terrain engine that reads real public land-cover, elevation, and wind data to suggest likely bedding
areas, travel corridors, and stand sites for whatever area you're viewing.

The frontend is plain HTML/CSS/JS with no build step. The Premium subscription is a real Stripe
Checkout/Billing Portal subscription handled by a small FastAPI backend
(`api_server.py`) — no API keys are baked into the frontend; the backend reads its Stripe key from
an environment variable.

## Run it locally

Start the backend (handles Stripe checkout/portal/subscription-status; listens on port 8000):

```bash
pip install -r requirements.txt
# Set your own Stripe secret key, then:
CUSTOM_CRED_API_STRIPE_COM_URL=https://api.stripe.com CUSTOM_CRED_API_STRIPE_COM_TOKEN=sk_test_... python3 api_server.py
```

Then serve the static frontend from this folder with any static file server:

```bash
# Option A — Node (no install needed)
npx serve . -l 3000

# Option B — Python
python3 -m http.server 3000
```

Then open `http://localhost:3000` in your browser. Without the backend running, the map, layers,
and free-tier parcel lookups still work — only checkout/billing calls will fail.

You do need an internet connection — the app calls several free, keyless public APIs live:

- Map tiles: Esri World Imagery / OpenStreetMap
- Land cover: USDA/NLCD (`geo.fas.usda.gov`)
- Elevation: USGS 3DEP Elevation Point Query Service (`epqs.nationalmap.gov`)
- Live wind: Open-Meteo (`api.open-meteo.com`)
- Address search: OpenStreetMap Nominatim
- Parcel/ownership data: live statewide cadastral GIS services for 29 states (see `app.js`
  `STATE_PARCEL_CONFIG`); remaining states show a clearly labeled acreage estimate

No API keys, accounts, or payment info are needed for any of the map/data APIs above. Stripe is
only involved if you subscribe to a paid plan.

## Install as an app (PWA)

Open the site in Chrome, Edge, or Safari and use the **Get App** button in the left rail (or your
browser's own "Install" / "Add to Home Screen" option) to install EScout as a standalone app with
its own icon. A service worker (`sw.js`) caches the app shell so it opens instantly and the shell
still loads with no connection — live map/terrain data still requires a network connection.

## Project structure

```
index.html      — page structure, plan/pricing modal, install modal
style.css       — full design system + component styles
base.css        — CSS reset / base tokens
app.js          — all application logic (map, Scout AI, search, parcels, waypoints, journal…)
manifest.json   — PWA manifest (name, icons, colors)
sw.js           — service worker (app-shell caching only — never caches live data)
assets/icons/   — app icons (192/512/maskable/apple-touch)
api_server.py   — FastAPI backend: Stripe Checkout/Billing Portal + subscription persistence
requirements.txt — backend Python dependencies
```

## Notes

- A single Premium plan ($5/mo, unlocks Scout AI, property/ownership lookups, and the topo
  basemap + contour layer nationwide) is a real Stripe subscription handled by the backend. No
  user accounts are created — subscription state is keyed to a generated per-visitor id, not an
  email/password login.
- Property/parcel ownership lookups are live and real for 29 states; other states show a
  clearly labeled acreage estimate.
- Scout AI only reports what it actually finds in the sampled land-cover/elevation grid for the
  current map view — it will say so honestly if an area has no forest/shrub/wetland cover instead
  of inventing a result.
