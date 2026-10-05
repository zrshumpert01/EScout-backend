#!/usr/bin/env python3
"""api_server.py — EScout backend: Stripe Checkout/Billing Portal + subscription
persistence, keyed by the platform's per-visitor X-Visitor-Id header (no cookies/
localStorage available inside the sandboxed preview iframe). Runs on port 8000.

Stripe calls go through the custom-credentials proxy: instead of calling
https://api.stripe.com directly with an Authorization header, we call
{CUSTOM_CRED_API_STRIPE_COM_URL}/v1/... with header x-api-key: {CUSTOM_CRED_API_STRIPE_COM_TOKEN}.
Both env vars are injected by start_server(api_credentials=["custom-cred:api.stripe.com"]).

Comp (complimentary) premium grants let the owner give specific people free access without
going through Stripe at all — see the /api/admin/grants* and /api/redeem endpoints below. Admin
endpoints are gated by a key read from the ADMIN_KEY env var (set in the Render dashboard, so it
survives every redeploy). If ADMIN_KEY isn't set (e.g. local dev), a random key is generated and
persisted in admin_key.txt instead — fine locally, but on Render that file lives on the
no-persistent-disk filesystem and gets regenerated (rotated) on every redeploy, which is exactly
why the env var is the real, intended path in production. Never checked into git, never shipped
in the static dist/public bundle.

Persistence: all app data lives in Supabase (Postgres) instead of a local SQLite file, so it
survives independently of this sandbox — see SUPABASE_URL/SUPABASE_ANON_KEY below. The anon key
is used only from this server process (never sent to the browser); Row Level Security is
enabled on every table with a policy scoped to that key, and this backend enforces per-visitor
access control in application code before any table is touched.
"""
import asyncio
import collections
import hashlib
import hmac
import io
import json
import math
import os
import re
import secrets
import time
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageChops, ImageDraw, ImageFilter
from pydantic import BaseModel, Field
from supabase import AsyncClient, create_async_client

ADMIN_KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "admin_key.txt")
# Production (Render, or any real host): call api.stripe.com directly with a standard
# Authorization: Bearer <secret key> header, configured via the STRIPE_SECRET_KEY env var.
# Sandbox/dev fallback: route through the agent's custom-credentials proxy instead, which
# injects CUSTOM_CRED_API_STRIPE_COM_URL/TOKEN when start_server(api_credentials=[...]) is used.
STRIPE_SECRET_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
if STRIPE_SECRET_KEY:
    STRIPE_BASE = "https://api.stripe.com"
    STRIPE_KEY_HEADER = {"Authorization": f"Bearer {STRIPE_SECRET_KEY}"}
else:
    STRIPE_BASE = os.environ.get("CUSTOM_CRED_API_STRIPE_COM_URL", "").rstrip("/")
    STRIPE_KEY_HEADER = {"x-api-key": os.environ.get("CUSTOM_CRED_API_STRIPE_COM_TOKEN", "")}

SECONDS_PER_DAY = 86400


def _load_dotenv(path: str) -> None:
    # Local/dev convenience only — in production, publish_website injects SUPABASE_URL and
    # SUPABASE_ANON_KEY directly as sandbox env vars, so this file won't exist there.
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
# Signing secret for the live Stripe webhook endpoint (registered via the Stripe API against
# https://escout.pplx.app/port/8000/api/webhook). When present, every inbound webhook request
# is cryptographically verified against it before its payload is trusted (see verify_stripe_
# signature below) so an attacker can't forge a fake "subscription active"/"cancelled" event
# for an arbitrary Stripe customer id. Left optional (rather than required at boot) so the app
# still runs in local/dev setups that haven't registered a webhook yet — the primary sync paths
# (confirm-on-checkout-return, and the live re-check in /api/subscription) don't depend on it.
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
WEBHOOK_TOLERANCE_SECONDS = 300  # reject signed events whose timestamp has drifted this far

supabase: AsyncClient | None = None
http_client: httpx.AsyncClient | None = None


def _load_or_create_admin_key() -> str:
    # Preferred path: an ADMIN_KEY env var, set once in the Render dashboard/API. Render
    # env vars persist across every redeploy (unlike this service's filesystem, which has
    # no attached persistent disk and is recreated from scratch on each deploy) — so this
    # is what makes the admin key survive redeploys instead of rotating every time. Falls
    # through to the file-based generator below only when the env var isn't set (e.g. local
    # dev, where a throwaway per-boot key is fine and simpler than requiring a .env entry).
    env_key = os.environ.get("ADMIN_KEY", "").strip()
    if env_key:
        return env_key
    return _load_or_create_admin_key_from_file()


def _load_or_create_admin_key_from_file() -> str:
    # Persisted across backend restarts (this file lives next to this script, outside the
    # static dist/public bundle that gets served publicly — see .gitignore).
    #
    # Runs under multiple uvicorn worker processes (--workers 2), each executing this module
    # top-level at boot independently. A plain "check exists, then write" (the previous
    # version of this function) has a real race window between the check and the write: two
    # workers starting within microseconds of each other can both see the file missing, both
    # generate their OWN random key, and both write it — whichever wrote last silently wins
    # on disk, but the OTHER worker already has the earlier key loaded into its own process
    # memory (ADMIN_KEY is read once at import time) and keeps using it for every request it
    # handles for the rest of its life. Since requests get load-balanced across workers, this
    # produced two simultaneously "valid-looking" admin keys, with roughly half of real admin
    # calls failing with 401 depending on which worker happened to pick them up — confirmed
    # directly against production logs after a fresh deploy, which printed two different keys
    # a few milliseconds apart.
    #
    # Fix: use O_CREAT|O_EXCL, which atomically fails with FileExistsError if another process
    # already created the file first (the file-creation equivalent of a compare-and-swap) —
    # so only ONE worker's generated key ever actually gets persisted, and every other worker
    # falls into the except branch and reads that same winning key back off disk instead of
    # keeping the one it generated.
    if os.path.exists(ADMIN_KEY_PATH):
        with open(ADMIN_KEY_PATH, "r") as f:
            key = f.read().strip()
            if key:
                return key
    key = secrets.token_urlsafe(24)
    try:
        fd = os.open(ADMIN_KEY_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(key)
        return key
    except FileExistsError:
        # Another worker won the race and created the file a moment before we did — use its
        # key instead of the one we generated, so every worker converges on one shared value.
        # The winner's write (open+write+close, a single small write() call) can in principle
        # still be mid-flight the instant we open for read, so retry briefly on an empty read
        # rather than trusting a single read to always see the fully-written content.
        for _ in range(10):
            with open(ADMIN_KEY_PATH, "r") as f:
                existing = f.read().strip()
            if existing:
                return existing
            time.sleep(0.05)
        raise RuntimeError(f"admin_key.txt exists but stayed empty at {ADMIN_KEY_PATH}")


ADMIN_KEY = _load_or_create_admin_key()
_admin_key_source = "ADMIN_KEY env var (persists across redeploys)" if os.environ.get("ADMIN_KEY", "").strip() else "generated admin_key.txt (will rotate on next redeploy — set ADMIN_KEY env var to persist it)"
print(f"[escout] Admin key source: {_admin_key_source}", flush=True)
# NOTE: the key itself is intentionally never printed -- Render's log viewer is not a secure
# place to display it. Look it up directly in the Render dashboard's ADMIN_KEY env var, or in
# admin_key.txt on disk for the generated-fallback path.


def require_admin(x_admin_key: str | None):
    if not x_admin_key or not secrets.compare_digest(x_admin_key, ADMIN_KEY):
        raise HTTPException(401, "Invalid admin key")


# A single Premium plan at $5/mo, nationwide — mirrors the pricing modal in index.html.
# Kept server-side so the price actually charged can never be manipulated from the client.
# (Formerly two tiers — a per-state Standard plan and a nationwide Premium plan — collapsed
# into one plan covering every paid feature everywhere.)
PLAN_PRICES = {
    "premium": {"amount": 500, "name": "EScout Premium"},
}


# ------------------------------------------------------------------------------------------
# Rate limiting — simple in-process sliding-window limiter. This is intentionally lightweight
# (a dict of deques, no external dependency) rather than a distributed limiter: at the scale
# this app runs at (a single backend process), it's enough to blunt abuse of the
# billing/redemption endpoints without adding infrastructure. Keys are pruned lazily so the
# dict doesn't grow unbounded as new visitors show up.
# ------------------------------------------------------------------------------------------
_rate_buckets: dict[str, collections.deque] = {}
_rate_lock = asyncio.Lock()


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


async def rate_limit(key: str, limit: int, window_seconds: int) -> None:
    now = time.time()
    async with _rate_lock:
        bucket = _rate_buckets.setdefault(key, collections.deque())
        while bucket and now - bucket[0] > window_seconds:
            bucket.popleft()
        if len(bucket) >= limit:
            raise HTTPException(429, "Too many requests — please slow down and try again shortly.")
        bucket.append(now)
        if not bucket:
            _rate_buckets.pop(key, None)


@asynccontextmanager
async def lifespan(app):
    global supabase, http_client
    if not SUPABASE_URL or not SUPABASE_ANON_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_ANON_KEY must be set")
    supabase = await create_async_client(SUPABASE_URL, SUPABASE_ANON_KEY)
    http_client = httpx.AsyncClient(timeout=20)
    yield
    await http_client.aclose()


app = FastAPI(lifespan=lifespan)
# CORS is load-bearing here, not decorative: the frontend is served from escouthunt.com /
# escout.pplx.app but calls this backend at escout-backend.onrender.com, so every single API
# call is cross-origin. An origin missing from this list doesn't degrade — it breaks the app
# for everyone on that origin. So add, don't prune, unless you're certain an origin is dead.
#
# Replaces a former allow_origins=["*"], which let any website on the internet call these
# endpoints — most importantly the auth/restore ones that send mail through Resend from our
# own domain.
#
# `capacitor://localhost` is the iOS native WebView's origin and `https://localhost` is
# Android's. Both are Capacitor defaults (server.iosScheme=capacitor, server.androidScheme=
# https, server.hostname=localhost) and capacitor.config.json overrides none of them, so the
# native app's fetches carry those Origin headers. Documented at
# https://capacitorjs.com/docs/config. Android is listed ahead of ever shipping there.
#
# allow_credentials stays OFF (the default). Identity rides in the `vid` query parameter, not
# a cookie, so nothing here needs credentialed requests — and leaving it off means a hostile
# page still cannot make a victim's browser attach anything it has stored for us.
#
# Requests with no Origin header at all (curl, server-to-server, Stripe webhooks) are not
# affected by any of this: CORS is enforced by browsers, not by this middleware.
ALLOWED_ORIGINS = [
    "https://escouthunt.com",
    "https://www.escouthunt.com",
    "https://escout.pplx.app",
    "capacitor://localhost",
    "https://localhost",
]

# Preview/staging deploys land on generated *.pplx.app hostnames (sites.pplx.app proxy,
# preview--*.pplx.app), which can't be enumerated ahead of time. Anchored at both ends so it
# matches the whole origin and can't be satisfied by a lookalike such as
# https://evil-pplx.app.example.com.
ALLOWED_ORIGIN_REGEX = r"https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.pplx\.app"

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Per-visitor identity — deliberately NOT a custom request header or a Set-Cookie response
# header. Live diagnostics on the published domain confirmed the hosting proxy in front of
# it silently (a) rewrites any client-supplied "X-Visitor-Id" header to its own generated
# value before the request reaches this process, AND (b) strips any Set-Cookie this backend
# tries to issue — only the proxy's own bot-management cookie ever reaches the browser. Both
# are why complimentary/premium status kept silently reverting to Free: the identity the
# client thought it was sending never survived the trip. A `vid` query parameter on the
# request URL is part of what the proxy has to preserve to route the request at all, so it
# passes through untouched — that's the one channel confirmed durable end-to-end.
VISITOR_COOKIE = "escout_vid"
VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 5  # 5 years


@app.middleware("http")
async def ensure_visitor_id(request: Request, call_next):
    # Preference order: query param (proven durable through the proxy) > cookie > custom
    # header > fresh id. The cookie/header paths are kept only as a best-effort fallback for
    # direct/local access that isn't going through the proxy at all.
    vid = (
        request.query_params.get("vid")
        or request.cookies.get(VISITOR_COOKIE)
        or request.headers.get("x-visitor-id")
        or uuid.uuid4().hex
    )
    request.state.vid = vid
    response = await call_next(request)
    response.set_cookie(
        VISITOR_COOKIE,
        vid,
        max_age=VISITOR_COOKIE_MAX_AGE,
        path="/",
        samesite="lax",
        httponly=True,
    )
    return response


# ---------------------------------------------------------------------------
# Dynamic per-visitor Web App Manifest
# ---------------------------------------------------------------------------
# Why this exists: localStorage is the frontend's normal home for the visitor
# id, but an installed PWA's storage can be wiped (a browser "clear site
# data" action, certain OS storage-pressure evictions, etc.) independently of
# the home-screen icon itself -- and when that happened before, the frontend
# silently minted a brand-new id, orphaning the visitor's real subscription
# and waypoints server-side with no way back.
#
# Both iOS and Android permanently capture a PWA's manifest `start_url` at
# "Add to Home Screen" / install time and re-navigate to that *exact* URL on
# every subsequent launch from the home-screen icon, regardless of what
# happens to that origin's storage in between. So instead of relying on
# localStorage alone, the frontend (see repointManifestLink() in app.js)
# always points its <link rel="manifest"> at this endpoint, which bakes the
# already-resolved vid into the returned start_url. Any *future* install then
# carries that vid permanently -- a channel a storage wipe can't touch.
#
# start_url/scope/icons must be emitted as *absolute* URLs pointing at the
# real frontend origin (never this backend's own onrender.com origin) --
# manifest URLs are otherwise resolved relative to the manifest's own URL,
# which would silently break every icon and try to "launch" the installed
# app at a URL on this API host instead of the actual site.
_MANIFEST_ALLOWED_ORIGINS = {
    "https://escout.pplx.app",
    "https://escouthunt.com",
    "https://www.escouthunt.com",
    "http://localhost:3000",
    "http://localhost:8765",
}

_MANIFEST_ICONS = [
    {"src": "assets/icons/icon-192.png?v=26f7426b", "sizes": "192x192", "type": "image/png", "purpose": "any"},
    {"src": "assets/icons/icon-512.png?v=26f7426b", "sizes": "512x512", "type": "image/png", "purpose": "any"},
    {"src": "assets/icons/icon-maskable-512.png?v=26f7426b", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
]


@app.get("/manifest.json")
async def dynamic_manifest(request: Request):
    vid = request.state.vid
    # Never trust an arbitrary client-supplied origin string into a response
    # that drives navigation/where icons load from -- only ever echo a value
    # that matched our allow-list exactly. Falls back to a relative,
    # vid-less manifest (identical in shape to the static manifest.json) if
    # the origin is missing or unrecognized, so nothing breaks -- it just
    # won't carry the vid into a future install from that origin.
    origin = request.query_params.get("origin", "")
    base = origin.rstrip("/") if origin in _MANIFEST_ALLOWED_ORIGINS else ""
    manifest = {
        "name": "EScout — AI Whitetail Scouting & Hunting Maps",
        "short_name": "EScout",
        "description": (
            "AI terrain engine that finds likely whitetail bedding areas, travel "
            "corridors, and stand sites from real public land-cover, elevation, "
            "and weather data."
        ),
        "start_url": f"{base}/?vid={vid}" if base else f"./index.html?vid={vid}",
        "scope": f"{base}/" if base else "./",
        "display": "standalone",
        "orientation": "portrait-primary",
        "background_color": "#14120e",
        "theme_color": "#14120e",
        "categories": ["sports", "navigation", "utilities"],
        "icons": [
            {**icon, "src": f"{base}/{icon['src']}" if base else f"./{icon['src']}"}
            for icon in _MANIFEST_ICONS
        ],
    }
    return JSONResponse(manifest, media_type="application/manifest+json")


SUBSCRIPTION_COLUMNS = (
    "visitor_id,stripe_customer_id,stripe_subscription_id,tier,state,status,"
    "current_period_end,source,comp_code"
)


async def get_row(vid: str) -> dict | None:
    res = await supabase.table("subscriptions").select(SUBSCRIPTION_COLUMNS).eq("visitor_id", vid).limit(1).execute()
    rows = res.data
    return rows[0] if rows else None


async def upsert_row(vid: str, **fields) -> None:
    row = await get_row(vid)
    now = int(time.time())
    merged = {**(row or {}), **fields}
    payload = {
        "visitor_id": vid,
        "stripe_customer_id": merged.get("stripe_customer_id"),
        "stripe_subscription_id": merged.get("stripe_subscription_id"),
        "tier": merged.get("tier", "free"),
        "state": merged.get("state"),
        "status": merged.get("status"),
        "current_period_end": merged.get("current_period_end"),
        "updated_at": now,
        "source": merged.get("source", "stripe"),
        "comp_code": merged.get("comp_code"),
    }
    await supabase.table("subscriptions").upsert(payload, on_conflict="visitor_id").execute()


async def stripe_request(method: str, path: str, data: dict | None = None, params: dict | None = None):
    if not STRIPE_BASE:
        raise HTTPException(500, "Stripe credential not configured on the server")
    url = f"{STRIPE_BASE}{path}"
    resp = await http_client.request(method, url, data=data, params=params, headers=STRIPE_KEY_HEADER)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("error", {}).get("message", resp.text)
        except Exception:
            detail = resp.text
        raise HTTPException(resp.status_code if resp.status_code < 500 else 422, detail)
    return resp.json()


class CheckoutBody(BaseModel):
    plan: str = "premium"
    origin: str  # full https URL of the page, so success/cancel URLs return to the right deploy


@app.post("/api/checkout")
async def create_checkout(body: CheckoutBody, request: Request):
    await rate_limit(f"checkout:{client_ip(request)}", limit=20, window_seconds=60)
    vid = request.state.vid
    if body.plan not in PLAN_PRICES:
        raise HTTPException(400, "Unknown plan")

    price = PLAN_PRICES[body.plan]
    row = await get_row(vid)
    customer_id = row.get("stripe_customer_id") if row else None

    origin = body.origin.rstrip("/")
    success_url = f"{origin}?checkout=success&session_id={{CHECKOUT_SESSION_ID}}"
    cancel_url = f"{origin}?checkout=cancelled"

    data = {
        "mode": "subscription",
        "client_reference_id": vid,
        "success_url": success_url,
        "cancel_url": cancel_url,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": str(price["amount"]),
        "line_items[0][price_data][recurring][interval]": "month",
        "line_items[0][price_data][product_data][name]": price["name"],
        "metadata[plan]": body.plan,
        "metadata[visitor_id]": vid,
    }
    if customer_id:
        data["customer"] = customer_id
    # In subscription mode Stripe always creates (or reuses) a Customer automatically —
    # customer_creation is only valid in payment mode, so it's omitted here.

    session = await stripe_request("POST", "/v1/checkout/sessions", data=data)
    return {"url": session["url"], "id": session["id"]}


@app.get("/api/checkout/confirm")
async def confirm_checkout(session_id: str, request: Request):
    vid = request.state.vid
    session = await stripe_request(
        "GET", f"/v1/checkout/sessions/{session_id}", params={"expand[]": "subscription"}
    )
    if session.get("client_reference_id") != vid:
        # Session belongs to a different visitor id — don't let it write another visitor's row.
        raise HTTPException(403, "Session does not match this visitor")
    if session.get("payment_status") not in ("paid", "no_payment_required") and session.get("status") != "complete":
        return {"confirmed": False}

    sub = session.get("subscription") or {}
    plan = (session.get("metadata") or {}).get("plan", "premium")
    await upsert_row(
        vid,
        stripe_customer_id=session.get("customer"),
        stripe_subscription_id=sub.get("id") if isinstance(sub, dict) else sub,
        tier=plan,
        state=None,
        status=(sub.get("status") if isinstance(sub, dict) else None) or "active",
        current_period_end=sub.get("current_period_end") if isinstance(sub, dict) else None,
        source="stripe",
        comp_code=None,
    )
    return {"confirmed": True, "tier": plan, "state": None}


@app.get("/api/subscription")
async def get_subscription(request: Request):
    vid = request.state.vid
    row = await get_row(vid)
    if not row:
        return {"tier": "free", "state": None}

    if row.get("source") == "comp":
        now = int(time.time())
        expires_at = row.get("current_period_end")
        if expires_at and now < expires_at:
            return {
                "tier": row["tier"],
                "state": row["state"],
                "status": "comp_active",
                "source": "comp",
                "expiresAt": expires_at,
            }
        # Comp grant lapsed — fall back to free (a fresh grant/redeem can re-activate it).
        await upsert_row(vid, tier="free", state=None, status="expired", source="stripe", comp_code=None)
        return {"tier": "free", "state": None, "status": "expired"}

    if not row.get("stripe_subscription_id"):
        return {"tier": "free", "state": None}

    # Re-verify live against Stripe so a cancellation done through the Billing Portal (or an
    # expired/past-due subscription) is reflected even if our webhook/confirm step missed it.
    try:
        sub = await stripe_request("GET", f"/v1/subscriptions/{row['stripe_subscription_id']}")
        status = sub.get("status")
        if status in ("active", "trialing"):
            await upsert_row(vid, status=status, current_period_end=sub.get("current_period_end"))
            return {"tier": row["tier"], "state": row["state"], "status": status}
        else:
            await upsert_row(vid, tier="free", state=None, status=status)
            return {"tier": "free", "state": None, "status": status}
    except HTTPException:
        # If Stripe is briefly unreachable, fall back to the last known local state rather
        # than downgrading the visitor.
        return {"tier": row["tier"], "state": row["state"], "status": row.get("status")}


class PortalBody(BaseModel):
    origin: str


@app.post("/api/portal")
async def create_portal(body: PortalBody, request: Request):
    await rate_limit(f"portal:{client_ip(request)}", limit=20, window_seconds=60)
    vid = request.state.vid
    row = await get_row(vid)
    if not row or not row.get("stripe_customer_id"):
        raise HTTPException(400, "No billing account on file yet — subscribe first")
    session = await stripe_request(
        "POST",
        "/v1/billing_portal/sessions",
        data={"customer": row["stripe_customer_id"], "return_url": body.origin},
    )
    return {"url": session["url"]}


def verify_stripe_signature(payload: bytes, sig_header: str | None) -> bool:
    # Reimplements Stripe's documented webhook signature scheme by hand (no stripe SDK
    # dependency): the Stripe-Signature header is "t=<unix ts>,v1=<hex hmac>[,v0=...]" where
    # v1 = HMAC-SHA256(webhook_secret, f"{t}.{raw_body}"). Verifying this before trusting the
    # payload stops an attacker who doesn't know the secret from POSTing a forged event (e.g.
    # "this customer's subscription is now active") for an arbitrary stripe_customer_id already
    # on file. Comparison uses hmac.compare_digest to avoid timing side-channels, and the
    # timestamp is checked against a tolerance window to reject replayed-but-otherwise-valid
    # signed payloads.
    if not STRIPE_WEBHOOK_SECRET:
        return False
    if not sig_header:
        return False
    parts = dict(p.split("=", 1) for p in sig_header.split(",") if "=" in p)
    timestamp = parts.get("t")
    signature = parts.get("v1")
    if not timestamp or not signature:
        return False
    try:
        if abs(time.time() - int(timestamp)) > WEBHOOK_TOLERANCE_SECONDS:
            return False
    except ValueError:
        return False
    signed_payload = f"{timestamp}.".encode() + payload
    expected = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), signed_payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


@app.post("/api/webhook")
async def stripe_webhook(request: Request):
    # Defense-in-depth on top of the confirm-on-return flow above and the live re-check in
    # /api/subscription, which remain the primary sync paths since webhook delivery uptime to
    # a single-process backend isn't guaranteed. When STRIPE_WEBHOOK_SECRET is configured (see
    # above — wired for the live escout.pplx.app endpoint), every request is signature-verified
    # before its payload is trusted; unsigned/invalid requests are rejected outright rather than
    # silently processed, since an unverified webhook could otherwise be used to forge
    # subscription status changes for any known Stripe customer id.
    raw_body = await request.body()
    if STRIPE_WEBHOOK_SECRET:
        if not verify_stripe_signature(raw_body, request.headers.get("stripe-signature")):
            raise HTTPException(400, "Invalid webhook signature")
    payload = json.loads(raw_body)
    event_type = payload.get("type", "")
    obj = (payload.get("data") or {}).get("object") or {}
    if event_type == "checkout.session.completed":
        # Belt-and-suspenders alongside the confirm-on-return flow (/api/checkout/confirm):
        # if the customer closes the tab right after paying instead of landing back on the
        # success_url, this webhook is what actually activates their subscription. Guarded the
        # same way confirm_checkout is — client_reference_id must match a real visitor id we
        # generated, and payment must actually be complete.
        vid = obj.get("client_reference_id")
        if vid and (obj.get("payment_status") in ("paid", "no_payment_required") or obj.get("status") == "complete"):
            plan = (obj.get("metadata") or {}).get("plan", "premium")
            sub_id = obj.get("subscription")
            await upsert_row(
                vid,
                stripe_customer_id=obj.get("customer"),
                stripe_subscription_id=sub_id if isinstance(sub_id, str) else (sub_id or {}).get("id"),
                tier=plan,
                state=None,
                status="active",
                source="stripe",
                comp_code=None,
            )
    elif event_type == "customer.subscription.updated" or event_type == "customer.subscription.deleted":
        customer_id = obj.get("customer")
        if customer_id:
            res = await supabase.table("subscriptions").select("visitor_id").eq(
                "stripe_customer_id", customer_id
            ).limit(1).execute()
            if res.data:
                vid = res.data[0]["visitor_id"]
                status = obj.get("status")
                if status in ("active", "trialing"):
                    await upsert_row(vid, status=status, current_period_end=obj.get("current_period_end"))
                else:
                    await upsert_row(vid, tier="free", state=None, status=status)
    elif event_type == "invoice.payment_failed":
        customer_id = obj.get("customer")
        if customer_id:
            res = await supabase.table("subscriptions").select("visitor_id").eq(
                "stripe_customer_id", customer_id
            ).limit(1).execute()
            if res.data:
                # Don't downgrade immediately on one failed invoice — Stripe's own retry
                # schedule (Smart Retries) will keep trying, and the subscription's own
                # status transitions to "past_due"/"unpaid"/"canceled" (handled above) once
                # retries are exhausted. Just record the status for visibility.
                await upsert_row(res.data[0]["visitor_id"], status="payment_failed")
    return {"received": True}


# ------------------------------------------------------------------------------------------
# Comp (complimentary) premium grants — owner-issued free access for specific people, bypassing
# Stripe entirely. Flow: owner opens /admin.html, enters the admin key, generates a one-time
# redemption code + link; the recipient opens that link once and the frontend calls /api/redeem,
# which activates premium (or the chosen tier) for exactly that visitor for `duration_days`.
# ------------------------------------------------------------------------------------------


class CreateGrantBody(BaseModel):
    label: str | None = None
    duration_days: int = 365
    # Required (unlike label) — it's the only way this person can ever recover Premium later
    # via /api/restore/* if their visitor id gets orphaned (new device, storage wipe, reinstall
    # after an app update). Grants created before this field existed have no email and simply
    # aren't restorable by email — only a fresh grant fixes that for them.
    email: str


def _grant_dict(row: dict) -> dict:
    code = row["code"]
    label = row["label"]
    tier = row["tier"]
    duration_days = row["duration_days"]
    created_at = row["created_at"]
    redeemed_at = row["redeemed_at"]
    redeemed_visitor_id = row["redeemed_visitor_id"]
    revoked_at = row["revoked_at"]
    now = int(time.time())
    expires_at = (redeemed_at + duration_days * SECONDS_PER_DAY) if redeemed_at else None
    if revoked_at:
        status = "revoked"
    elif redeemed_at:
        status = "active" if (expires_at and now < expires_at) else "expired"
    else:
        status = "pending"
    return {
        "code": code,
        "label": label,
        "email": row.get("email"),
        "tier": tier,
        "durationDays": duration_days,
        "createdAt": created_at,
        "redeemedAt": redeemed_at,
        "redeemedVisitorId": redeemed_visitor_id,
        "revokedAt": revoked_at,
        "expiresAt": expires_at,
        "status": status,
    }


@app.post("/api/admin/grants")
async def create_grant(body: CreateGrantBody, x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    # Comp grants are Premium-only (all 50 states) — a comp'd Standard grant would need a
    # state assignment too, which the redemption flow doesn't collect, so it's not offered.
    if body.duration_days < 1 or body.duration_days > 3650:
        raise HTTPException(400, "duration_days must be between 1 and 3650")
    email = (body.email or "").strip().lower()
    if not email or "@" not in email or len(email) > 254:
        raise HTTPException(400, "Enter the recipient's email so they can restore access later if needed")
    code = secrets.token_urlsafe(9)
    now = int(time.time())
    await supabase.table("comp_grants").insert(
        {
            "code": code,
            "label": body.label,
            "email": email,
            "tier": "premium",
            "duration_days": body.duration_days,
            "created_at": now,
        }
    ).execute()
    return {"code": code}


@app.get("/api/admin/grants")
async def list_grants(x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    res = await supabase.table("comp_grants").select("*").order("created_at", desc=True).execute()
    return {"grants": [_grant_dict(r) for r in res.data]}


@app.post("/api/admin/grants/{code}/revoke")
async def revoke_grant(code: str, x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    res = await supabase.table("comp_grants").select("redeemed_visitor_id").eq("code", code).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "Grant not found")
    now = int(time.time())
    await supabase.table("comp_grants").update({"revoked_at": now}).eq("code", code).execute()
    redeemed_visitor_id = res.data[0]["redeemed_visitor_id"]
    if redeemed_visitor_id:
        # Only downgrade if that visitor's active grant is still this exact code — avoids
        # clobbering a real Stripe subscription they may have started since redeeming.
        row = await get_row(redeemed_visitor_id)
        if row and row.get("source") == "comp" and row.get("comp_code") == code:
            await upsert_row(redeemed_visitor_id, tier="free", state=None, status="revoked", source="stripe", comp_code=None)
    return {"revoked": True}


@app.delete("/api/admin/grants/{code}")
async def delete_grant(code: str, x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    res = await supabase.table("comp_grants").select("*").eq("code", code).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "Grant not found")
    row = res.data[0]
    status = _grant_dict(row)["status"]
    # Pending (never redeemed) codes are always safe to delete. Revoked and expired grants are
    # also safe — the person's access was already cut off (revoke) or lapsed on its own
    # (expiry), so deleting the record can't grant or extend anyone's access. Active grants are
    # never deletable this way — revoke first.
    if status == "active":
        raise HTTPException(400, "Grant is still active — revoke it instead of deleting")
    await supabase.table("comp_grants").delete().eq("code", code).execute()
    return {"deleted": True}


@app.post("/api/admin/grants/clear-old")
async def clear_old_grants(x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    res = await supabase.table("comp_grants").select("*").execute()
    to_delete = [r["code"] for r in res.data if _grant_dict(r)["status"] in ("revoked", "expired")]
    for code in to_delete:
        await supabase.table("comp_grants").delete().eq("code", code).execute()
    return {"deleted": len(to_delete)}


# ------------------------------------------------------------------------------------------
# Share-banner campaign — a lightweight, owner-controlled promo: a "Love the app? Share it
# with a friend!" banner shown to every visitor for a 5-day window. This is a single global
# on/off switch (not per-visitor), stored in the generic `app_settings` key/value table so it
# persists across redeploys and this sandbox restarting. The owner starts/stops it from
# /admin.html; the frontend just calls the public GET below on each app load to know whether
# to show the banner and flash the Share button.
# ------------------------------------------------------------------------------------------
SHARE_BANNER_DURATION_DAYS = 5
SHARE_BANNER_SETTING_KEY = "share_banner_campaign"


async def _get_share_banner_started_at() -> int | None:
    res = await supabase.table("app_settings").select("value").eq("key", SHARE_BANNER_SETTING_KEY).limit(1).execute()
    if not res.data:
        return None
    value = res.data[0]["value"] or {}
    return value.get("started_at")


def _share_banner_status(started_at: int | None) -> dict:
    now = int(time.time())
    ends_at = (started_at + SHARE_BANNER_DURATION_DAYS * SECONDS_PER_DAY) if started_at else None
    active = bool(started_at and ends_at and now < ends_at)
    return {"active": active, "startedAt": started_at, "endsAt": ends_at}


@app.get("/api/share-banner")
async def get_share_banner():
    started_at = await _get_share_banner_started_at()
    return _share_banner_status(started_at)


@app.post("/api/admin/share-banner/start")
async def start_share_banner(x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    now = int(time.time())
    await supabase.table("app_settings").upsert(
        {"key": SHARE_BANNER_SETTING_KEY, "value": {"started_at": now}, "updated_at": now},
        on_conflict="key",
    ).execute()
    return _share_banner_status(now)


@app.post("/api/admin/share-banner/stop")
async def stop_share_banner(x_admin_key: str | None = Header(default=None)):
    require_admin(x_admin_key)
    now = int(time.time())
    await supabase.table("app_settings").upsert(
        {"key": SHARE_BANNER_SETTING_KEY, "value": {"started_at": None}, "updated_at": now},
        on_conflict="key",
    ).execute()
    return _share_banner_status(None)


class RedeemBody(BaseModel):
    code: str


@app.post("/api/redeem")
async def redeem_grant(body: RedeemBody, request: Request):
    await rate_limit(f"redeem:{client_ip(request)}", limit=10, window_seconds=60)
    vid = request.state.vid
    res = await supabase.table("comp_grants").select("tier,duration_days,redeemed_at,revoked_at").eq(
        "code", body.code
    ).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "Invalid or unrecognized code")
    grant = res.data[0]
    if grant["revoked_at"]:
        raise HTTPException(410, "This code has been revoked")
    if grant["redeemed_at"]:
        raise HTTPException(409, "This code has already been redeemed")
    now = int(time.time())
    # Atomic conditional claim: the WHERE clause repeats the not-yet-redeemed/not-revoked
    # check at write time, so if two requests race to redeem the same code only one update
    # actually matches a row. Without this, two simultaneous redeems could both pass the
    # check above (a real gap now that each step is a separate network round trip to
    # Postgres) and both activate premium off a single-use code.
    claim = (
        await supabase.table("comp_grants")
        .update({"redeemed_at": now, "redeemed_visitor_id": vid})
        .eq("code", body.code)
        .is_("redeemed_at", "null")
        .is_("revoked_at", "null")
        .execute()
    )
    if not claim.data:
        raise HTTPException(409, "This code has already been redeemed")
    expires_at = now + grant["duration_days"] * SECONDS_PER_DAY
    await upsert_row(
        vid,
        tier=grant["tier"],
        state=None,
        status="comp_active",
        current_period_end=expires_at,
        source="comp",
        comp_code=body.code,
    )
    return {"tier": grant["tier"], "expiresAt": expires_at}


class RestoreBody(BaseModel):
    email: str


class RestoreConfirmBody(BaseModel):
    email: str
    code: str


RESTORE_CODE_TTL_SECONDS = 10 * 60  # 10 minutes
RESTORE_MAX_CODE_ATTEMPTS = 5

# App Review demo account. Sign-in is passwordless, so an Apple reviewer has no inbox to read
# the emailed code from and literally cannot enter the app -- Guideline 2.1 requires we give
# them full access. This one address instead accepts a fixed code supplied through the Render
# environment, so the secret never enters git or dist/public. Both values unset (local dev,
# any future environment) means the path is completely inert: _is_review_account returns False
# and sign-in behaves exactly as it does for everyone else.
APP_REVIEW_EMAIL = (os.getenv("APP_REVIEW_EMAIL") or "").strip().lower()
APP_REVIEW_CODE = (os.getenv("APP_REVIEW_CODE") or "").strip()


def _is_review_account(email: str) -> bool:
    if not APP_REVIEW_EMAIL:
        return False
    return secrets.compare_digest(email, APP_REVIEW_EMAIL)


def _review_code_matches(code: str) -> bool:
    # Minimum length guards against a truncated or accidentally-blanked env var turning into a
    # trivially guessable bypass. compare_digest keeps the check free of a timing oracle.
    if len(APP_REVIEW_CODE) < 6:
        return False
    return secrets.compare_digest(code, APP_REVIEW_CODE)


# Sender for verification-code emails, and the API key for the send itself. Same dual-path
# pattern as Stripe above: production (Render) sets RESEND_API_KEY directly as a real secret
# in the dashboard, so it survives redeploys and never touches git or dist/public. Sandbox/dev
# fallback routes through the agent's custom-credentials proxy instead, which injects
# CUSTOM_CRED_API_RESEND_COM_URL/TOKEN when start_server(api_credentials=[...]) is used —
# without this fallback, a sandbox test would need the real key sitting in this process's env.
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
if RESEND_API_KEY:
    RESEND_BASE = "https://api.resend.com"
    RESEND_KEY_HEADER = {"Authorization": f"Bearer {RESEND_API_KEY}"}
else:
    RESEND_BASE = os.environ.get("CUSTOM_CRED_API_RESEND_COM_URL", "").rstrip("/")
    RESEND_KEY_HEADER = {"x-api-key": os.environ.get("CUSTOM_CRED_API_RESEND_COM_TOKEN", "")}
RESTORE_FROM_EMAIL = os.environ.get("RESTORE_FROM_EMAIL", "EScout <support@escouthunt.com>")


def _hash_restore_code(email: str, code: str) -> str:
    # Keyed with ADMIN_KEY (already a private, per-deploy secret) so a Supabase row alone
    # can't be replayed or brute-forced offline without also knowing that server secret.
    msg = f"{email}:{code}".encode()
    return hmac.new(ADMIN_KEY.encode(), msg, hashlib.sha256).hexdigest()


async def _send_restore_code_email(email: str, code: str) -> None:
    if not RESEND_BASE:
        raise HTTPException(500, "Email service isn't configured on the server yet")
    resp = await http_client.post(
        f"{RESEND_BASE}/emails",
        headers=RESEND_KEY_HEADER,
        json={
            "from": RESTORE_FROM_EMAIL,
            "to": [email],
            "subject": f"{code} is your EScout verification code",
            "text": (
                f"Your EScout verification code is {code}.\n\n"
                "Enter it in the app to restore Premium on this device. It expires in "
                "10 minutes. If you didn't request this, you can ignore this email."
            ),
            "html": (
                f"<p>Your EScout verification code is:</p>"
                f"<p style='font-size:28px;font-weight:700;letter-spacing:4px'>{code}</p>"
                "<p>Enter it in the app to restore Premium on this device. It expires in "
                "10 minutes. If you didn't request this, you can ignore this email.</p>"
            ),
        },
    )
    if resp.status_code >= 400:
        # Don't leak provider error detail (could include the recipient address) to the client.
        raise HTTPException(502, "Couldn't send the verification email — please try again shortly")


async def _find_active_subscription_by_email(email: str) -> tuple[str, dict] | None:
    escaped = email.replace("\\", "\\\\").replace("'", "\\'")
    search = await stripe_request("GET", "/v1/customers/search", params={"query": f"email:'{escaped}'"})
    customers = search.get("data") or []
    if not customers:
        # Stripe's search index can lag a few seconds behind very recent writes — fall back to
        # an exact-match list lookup, which reads the primary store instead of the index.
        listed = await stripe_request("GET", "/v1/customers", params={"email": email, "limit": 10})
        customers = listed.get("data") or []
    if not customers:
        return None

    best_sub = None
    best_customer_id = None
    for cust in customers:
        subs = await stripe_request(
            "GET", "/v1/subscriptions", params={"customer": cust["id"], "status": "all", "limit": 10}
        )
        for sub in subs.get("data") or []:
            if sub.get("status") not in ("active", "trialing", "past_due"):
                continue
            if best_sub is None or (sub.get("current_period_end") or 0) > (best_sub.get("current_period_end") or 0):
                best_sub = sub
                best_customer_id = cust["id"]
    if not best_sub:
        return None
    return best_customer_id, best_sub


async def _find_active_comp_grant_by_email(email: str) -> dict | None:
    # Mirrors _find_active_subscription_by_email's job but for owner-issued comp grants
    # (see the comp grants section above) instead of Stripe. Only grants created with an
    # email on file are matched — older grants (created before that field existed) simply
    # aren't reachable this way. A person could in principle have been granted more than once
    # over time (renewal, replacement code), so pick whichever redeemed, non-revoked grant has
    # the furthest-out expiry rather than assuming there's exactly one row.
    res = (
        await supabase.table("comp_grants")
        .select("code,tier,duration_days,redeemed_at,revoked_at")
        .eq("email", email)
        .execute()
    )
    now = int(time.time())
    best = None
    best_expires_at = None
    for row in res.data:
        if row.get("revoked_at") or not row.get("redeemed_at"):
            continue
        expires_at = row["redeemed_at"] + row["duration_days"] * SECONDS_PER_DAY
        if expires_at <= now:
            continue
        if best is None or expires_at > best_expires_at:
            best = row
            best_expires_at = expires_at
    if not best:
        return None
    return {"code": best["code"], "tier": best["tier"], "expires_at": best_expires_at}


@app.post("/api/restore/request")
async def restore_request(body: RestoreBody, request: Request):
    # Step 1 of Restore Purchase: send a one-time code to the typed email before restoring
    # anything. This closes the gap in the earlier single-step /api/restore endpoint, which
    # trusted whatever email was typed with no proof the caller actually owned that inbox —
    # anyone who knew a paying customer's address could have restored Premium onto their own
    # device. Rate-limited per IP AND per email so neither a single caller nor a spread of
    # requests targeting one address can spam a mailbox.
    await rate_limit(f"restore_req_ip:{client_ip(request)}", limit=5, window_seconds=60)
    vid = request.state.vid
    email = (body.email or "").strip().lower()
    if not email or "@" not in email or len(email) > 254:
        raise HTTPException(400, "Enter a valid email address")
    await rate_limit(f"restore_req_email:{email}", limit=3, window_seconds=600)

    code = f"{secrets.randbelow(1_000_000):06d}"
    now = int(time.time())
    await supabase.table("restore_codes").insert({
        "email": email,
        "code_hash": _hash_restore_code(email, code),
        "vid": vid,
        "attempts": 0,
        "expires_at": now + RESTORE_CODE_TTL_SECONDS,
        "created_at": now,
        "purpose": "restore",
    }).execute()
    await _send_restore_code_email(email, code)
    # Generic response regardless of whether this email actually has an active subscription —
    # the code has to be entered correctly before /api/restore/confirm reveals anything.
    return {"sent": True}


@app.post("/api/restore/confirm")
async def restore_confirm(body: RestoreConfirmBody, request: Request):
    # Step 2: only after the caller proves they received the code at that inbox do we look the
    # subscription up in Stripe and restore it onto this device's visitor id.
    await rate_limit(f"restore_confirm:{client_ip(request)}", limit=10, window_seconds=60)
    vid = request.state.vid
    email = (body.email or "").strip().lower()
    code = (body.code or "").strip()
    if not email or "@" not in email:
        raise HTTPException(400, "Enter a valid email address")
    if not code:
        raise HTTPException(400, "Enter the code from your email")

    now = int(time.time())
    res = (
        await supabase.table("restore_codes")
        .select("id,code_hash,vid,attempts,expires_at,used_at")
        .eq("email", email)
        .eq("vid", vid)
        .eq("purpose", "restore")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = res.data
    row = rows[0] if rows else None
    invalid = HTTPException(400, "That code is invalid or has expired — request a new one")
    if not row or row.get("used_at") or row["expires_at"] < now:
        raise invalid
    if row["attempts"] >= RESTORE_MAX_CODE_ATTEMPTS:
        raise HTTPException(429, "Too many incorrect attempts — request a new code")

    if not secrets.compare_digest(row["code_hash"], _hash_restore_code(email, code)):
        await (
            supabase.table("restore_codes")
            .update({"attempts": row["attempts"] + 1})
            .eq("id", row["id"])
            .execute()
        )
        raise invalid

    # Mark used immediately so the same code can't be replayed even if this request is retried.
    await (
        supabase.table("restore_codes")
        .update({"used_at": now})
        .eq("id", row["id"])
        .execute()
    )

    # Proving the inbox is exactly what sign-in proves, so restoring also signs this device in
    # to that email's account (creating it if needed) and continues on the account's identity.
    # Without this, a restore copied Premium onto a device that stayed signed out: the app
    # then asked for the email a second time and the account's pins didn't show.
    acct_res = await supabase.table("accounts").select("email,visitor_id").eq("email", email).limit(1).execute()
    if acct_res.data:
        canonical_vid = acct_res.data[0]["visitor_id"]
    else:
        canonical_vid = vid
        await supabase.table("accounts").insert(
            {"email": email, "visitor_id": canonical_vid, "created_at": now}
        ).execute()
    if vid != canonical_vid:
        await _merge_visitor_into_account(vid, canonical_vid)
    vid = canonical_vid

    def _signed_in_response(payload: dict) -> JSONResponse:
        response = JSONResponse({**payload, "signedIn": True, "visitorId": canonical_vid, "email": email})
        response.set_cookie(
            VISITOR_COOKIE,
            canonical_vid,
            max_age=VISITOR_COOKIE_MAX_AGE,
            path="/",
            samesite="lax",
            httponly=True,
        )
        return response

    found = await _find_active_subscription_by_email(email)
    if found:
        best_customer_id, best_sub = found
        await upsert_row(
            vid,
            stripe_customer_id=best_customer_id,
            stripe_subscription_id=best_sub["id"],
            tier="premium",
            state=None,
            status=best_sub.get("status"),
            current_period_end=best_sub.get("current_period_end"),
            source="stripe",
            comp_code=None,
        )
        return _signed_in_response({"restored": True, "tier": "premium", "status": best_sub.get("status")})

    # No paid subscription — check for a complimentary (comp) grant on file for this email
    # before giving up. This is what lets a comp'd member (a friend/family free-access grant,
    # not a Stripe customer) recover Premium the same way a paying subscriber does, if their
    # visitor id ever gets orphaned (new device, storage wipe, reinstall after an app update).
    comp = await _find_active_comp_grant_by_email(email)
    if not comp:
        # Safe to be specific now — the caller already proved they own this inbox, so this
        # can't be used to probe which emails have paid or been granted access.
        # The account itself may already carry Premium (e.g. it was on another device and the
        # merge above just brought this device onto it) — report that rather than an error.
        acct_sub = await get_row(canonical_vid)
        if acct_sub and (acct_sub.get("tier") or "free") != "free":
            return _signed_in_response({"restored": True, "tier": acct_sub["tier"], "status": acct_sub.get("status")})
        return _signed_in_response({"restored": False, "tier": "free", "status": None,
                                    "message": "Signed in, but no active subscription or complimentary access was found for that email"})

    # Re-point the grant at this device/visitor id, same as how a fresh redemption works — the
    # original expiry is preserved, this doesn't grant any extra time.
    await (
        supabase.table("comp_grants")
        .update({"redeemed_visitor_id": vid})
        .eq("code", comp["code"])
        .execute()
    )
    await upsert_row(
        vid,
        tier=comp["tier"],
        state=None,
        status="comp_active",
        current_period_end=comp["expires_at"],
        source="comp",
        comp_code=comp["code"],
    )
    return _signed_in_response({"restored": True, "tier": comp["tier"], "status": "comp_active"})


# ------------------------------------------------------------------------------------------
# Accounts — every visitor must sign in with an email + one-time code before using the app.
# There is no password: the same Resend-based verification code mechanism above (built for
# Restore Purchase) doubles as the sign-in step, just tagged with purpose="login" so the two
# code streams never cross. An account is just a durable mapping from email -> whichever
# visitor_id is "canonical" for that person. The very first device to ever verify a given
# email becomes canonical automatically (nothing to migrate, its existing data is already
# correct). Any later device that signs in with the same email has its own local data merged
# onto the canonical visitor_id, then adopts that canonical id for all future requests — so
# waypoints, subscription, and view state all follow the account across every device/browser.
# ------------------------------------------------------------------------------------------


class AuthRequestBody(BaseModel):
    email: str


class AuthVerifyBody(BaseModel):
    email: str
    code: str


async def _send_login_code_email(email: str, code: str) -> None:
    if not RESEND_BASE:
        raise HTTPException(500, "Email service isn't configured on the server yet")
    resp = await http_client.post(
        f"{RESEND_BASE}/emails",
        headers=RESEND_KEY_HEADER,
        json={
            "from": RESTORE_FROM_EMAIL,
            "to": [email],
            "subject": f"{code} is your EScout sign-in code",
            "text": (
                f"Your EScout sign-in code is {code}.\n\n"
                "Enter it in the app to sign in. It expires in 10 minutes. If you didn't "
                "request this, you can ignore this email."
            ),
            "html": (
                f"<p>Your EScout sign-in code is:</p>"
                f"<p style='font-size:28px;font-weight:700;letter-spacing:4px'>{code}</p>"
                "<p>Enter it in the app to sign in. It expires in 10 minutes. If you didn't "
                "request this, you can ignore this email.</p>"
            ),
        },
    )
    if resp.status_code >= 400:
        raise HTTPException(502, "Couldn't send the sign-in email — please try again shortly")


async def _merge_visitor_into_account(old_vid: str, canonical_vid: str) -> None:
    # Folds one device's local data onto the account's canonical visitor_id. Safe to call even
    # when old_vid has nothing yet (brand-new device signing into an existing account) — every
    # step is a targeted update/delete keyed on old_vid, so a device with no rows is a no-op.
    if old_vid == canonical_vid:
        return
    await supabase.table("waypoints").update({"visitor_id": canonical_vid}).eq("visitor_id", old_vid).execute()
    await supabase.table("tracks").update({"visitor_id": canonical_vid}).eq("visitor_id", old_vid).execute()
    await supabase.table("waypoint_shares").update({"visitor_id": canonical_vid}).eq("visitor_id", old_vid).execute()
    await supabase.table("waypoint_share_grants").update({"recipient_vid": canonical_vid}).eq(
        "recipient_vid", old_vid
    ).execute()
    await supabase.table("waypoint_share_grants").update({"owner_vid": canonical_vid}).eq(
        "owner_vid", old_vid
    ).execute()
    await supabase.table("comp_grants").update({"redeemed_visitor_id": canonical_vid}).eq(
        "redeemed_visitor_id", old_vid
    ).execute()

    old_sub_res = await supabase.table("subscriptions").select("*").eq("visitor_id", old_vid).limit(1).execute()
    if old_sub_res.data:
        old_sub = old_sub_res.data[0]
        if (old_sub.get("tier") or "free") != "free":
            canon_sub_res = (
                await supabase.table("subscriptions").select("*").eq("visitor_id", canonical_vid).limit(1).execute()
            )
            canon_sub = canon_sub_res.data[0] if canon_sub_res.data else None
            should_adopt = (
                not canon_sub
                or (canon_sub.get("tier") or "free") == "free"
                or (old_sub.get("current_period_end") or 0) > (canon_sub.get("current_period_end") or 0)
            )
            if should_adopt:
                await upsert_row(
                    canonical_vid,
                    stripe_customer_id=old_sub.get("stripe_customer_id"),
                    stripe_subscription_id=old_sub.get("stripe_subscription_id"),
                    tier=old_sub.get("tier"),
                    state=old_sub.get("state"),
                    status=old_sub.get("status"),
                    current_period_end=old_sub.get("current_period_end"),
                    source=old_sub.get("source"),
                    comp_code=old_sub.get("comp_code"),
                )
        await supabase.table("subscriptions").delete().eq("visitor_id", old_vid).execute()

    canon_view_res = await supabase.table("view_state").select("visitor_id").eq("visitor_id", canonical_vid).limit(
        1
    ).execute()
    if not canon_view_res.data:
        old_view_res = await supabase.table("view_state").select("*").eq("visitor_id", old_vid).limit(1).execute()
        if old_view_res.data:
            row = dict(old_view_res.data[0])
            row["visitor_id"] = canonical_vid
            await supabase.table("view_state").upsert(row).execute()
    await supabase.table("view_state").delete().eq("visitor_id", old_vid).execute()

    canon_name_res = await supabase.table("display_names").select("visitor_id").eq(
        "visitor_id", canonical_vid
    ).limit(1).execute()
    if not canon_name_res.data:
        old_name_res = await supabase.table("display_names").select("*").eq("visitor_id", old_vid).limit(
            1
        ).execute()
        if old_name_res.data:
            row = dict(old_name_res.data[0])
            row["visitor_id"] = canonical_vid
            await supabase.table("display_names").upsert(row).execute()
    await supabase.table("display_names").delete().eq("visitor_id", old_vid).execute()


@app.get("/api/auth/status")
async def auth_status(request: Request):
    # Lets the frontend silently confirm sign-in state from the durable vid cookie/query param
    # instead of asking for email again on every load, as long as the device is already linked.
    vid = request.state.vid
    res = await supabase.table("accounts").select("email").eq("visitor_id", vid).limit(1).execute()
    if res.data:
        return {"signedIn": True, "email": res.data[0]["email"]}
    return {"signedIn": False}


@app.post("/api/auth/request-code")
async def auth_request_code(body: AuthRequestBody, request: Request):
    await rate_limit(f"auth_req_ip:{client_ip(request)}", limit=5, window_seconds=60)
    email = (body.email or "").strip().lower()
    if not email or "@" not in email or len(email) > 254:
        raise HTTPException(400, "Enter a valid email address")
    await rate_limit(f"auth_req_email:{email}", limit=3, window_seconds=600)

    if _is_review_account(email):
        # App Review can't read our inbox, so this address uses the fixed code from the
        # environment. Nothing is stored and no mail is sent, but the response is identical
        # to a real send so the sign-in screen behaves normally for the reviewer.
        return {"sent": True}

    code = f"{secrets.randbelow(1_000_000):06d}"
    now = int(time.time())
    await supabase.table("restore_codes").insert({
        "email": email,
        "code_hash": _hash_restore_code(email, code),
        "vid": request.state.vid,
        "attempts": 0,
        "expires_at": now + RESTORE_CODE_TTL_SECONDS,
        "created_at": now,
        "purpose": "login",
    }).execute()
    await _send_login_code_email(email, code)
    return {"sent": True}


@app.post("/api/auth/verify-code")
async def auth_verify_code(body: AuthVerifyBody, request: Request):
    await rate_limit(f"auth_confirm:{client_ip(request)}", limit=10, window_seconds=60)
    vid = request.state.vid
    email = (body.email or "").strip().lower()
    code = (body.code or "").strip()
    if not email or "@" not in email:
        raise HTTPException(400, "Enter a valid email address")
    if not code:
        raise HTTPException(400, "Enter the code from your email")

    now = int(time.time())

    # The App Review address proves itself with the fixed environment code instead of a mailed
    # one, so it has no restore_codes row to look up. Every other caller goes through the
    # normal path below completely unchanged.
    reviewer = _is_review_account(email) and _review_code_matches(code)
    if not reviewer:
        res = (
            await supabase.table("restore_codes")
            .select("id,code_hash,vid,attempts,expires_at,used_at")
            .eq("email", email)
            .eq("vid", vid)
            .eq("purpose", "login")
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = res.data
        row = rows[0] if rows else None
        invalid = HTTPException(400, "That code is invalid or has expired — request a new one")
        if not row or row.get("used_at") or row["expires_at"] < now:
            raise invalid
        if row["attempts"] >= RESTORE_MAX_CODE_ATTEMPTS:
            raise HTTPException(429, "Too many incorrect attempts — request a new code")
        if not secrets.compare_digest(row["code_hash"], _hash_restore_code(email, code)):
            await (
                supabase.table("restore_codes")
                .update({"attempts": row["attempts"] + 1})
                .eq("id", row["id"])
                .execute()
            )
            raise invalid
        await (
            supabase.table("restore_codes")
            .update({"used_at": now})
            .eq("id", row["id"])
            .execute()
        )

    acct_res = await supabase.table("accounts").select("email,visitor_id").eq("email", email).limit(1).execute()
    if acct_res.data:
        canonical_vid = acct_res.data[0]["visitor_id"]
    else:
        canonical_vid = vid
        await supabase.table("accounts").insert(
            {"email": email, "visitor_id": canonical_vid, "created_at": now}
        ).execute()

    if vid != canonical_vid:
        await _merge_visitor_into_account(vid, canonical_vid)

    response = JSONResponse({"ok": True, "visitorId": canonical_vid, "email": email})
    # The client should switch to sending this vid going forward (as the durable `vid` query
    # param — see ensure_visitor_id above), but also refresh the cookie fallback here in case
    # of direct/local access that bypasses the proxy.
    response.set_cookie(
        VISITOR_COOKIE,
        canonical_vid,
        max_age=VISITOR_COOKIE_MAX_AGE,
        path="/",
        samesite="lax",
        httponly=True,
    )
    return response


# ------------------------------------------------------------------------------------------
# Account deletion. App Store Review Guideline 5.1.1(v) requires that any app supporting
# account creation also let the user delete that account from inside the app, so this is a
# hard requirement for shipping on iOS, not a nicety.
#
# Two steps on purpose. Sign-in state here is a durable visitor id (cookie/query param), not
# a short-lived session, so possession of an unlocked phone is otherwise enough to irreversibly
# destroy someone's account. Requiring a fresh emailed code proves the caller still controls
# the inbox before anything is erased.
# ------------------------------------------------------------------------------------------


class AccountDeleteBody(BaseModel):
    code: str


async def _account_email_for_vid(vid: str) -> str:
    res = await supabase.table("accounts").select("email").eq("visitor_id", vid).limit(1).execute()
    if not res.data:
        raise HTTPException(401, "You need to be signed in to delete your account")
    return res.data[0]["email"]


async def _send_delete_code_email(email: str, code: str) -> None:
    if not RESEND_BASE:
        raise HTTPException(500, "Email service isn't configured on the server yet")
    resp = await http_client.post(
        f"{RESEND_BASE}/emails",
        headers=RESEND_KEY_HEADER,
        json={
            "from": RESTORE_FROM_EMAIL,
            "to": [email],
            "subject": f"{code} is your EScout account deletion code",
            "text": (
                f"Your EScout account deletion code is {code}.\n\n"
                "Entering this code in the app will permanently delete your EScout account, "
                "including every saved pin, trail camera entry, and hunt journal entry. This "
                "cannot be undone. The code expires in 10 minutes.\n\n"
                "If you did NOT request this, do not enter the code \u2014 ignore this email and "
                "your account stays exactly as it is."
            ),
            "html": (
                "<p>Your EScout account deletion code is:</p>"
                f"<p style='font-size:28px;font-weight:700;letter-spacing:4px'>{code}</p>"
                "<p>Entering this code in the app will <strong>permanently delete your EScout "
                "account</strong>, including every saved pin, trail camera entry, and hunt "
                "journal entry. This cannot be undone. The code expires in 10 minutes.</p>"
                "<p>If you did <strong>not</strong> request this, do not enter the code \u2014 ignore "
                "this email and your account stays exactly as it is.</p>"
            ),
        },
    )
    if resp.status_code >= 400:
        raise HTTPException(502, "Couldn't send the confirmation email \u2014 please try again shortly")


@app.post("/api/account/delete/request-code")
async def account_delete_request_code(request: Request):
    await rate_limit(f"acct_del_req_ip:{client_ip(request)}", limit=5, window_seconds=60)
    vid = request.state.vid
    email = await _account_email_for_vid(vid)
    await rate_limit(f"acct_del_req_email:{email}", limit=3, window_seconds=600)

    code = f"{secrets.randbelow(1_000_000):06d}"
    now = int(time.time())
    await supabase.table("restore_codes").insert({
        "email": email,
        "code_hash": _hash_restore_code(email, code),
        "vid": vid,
        "attempts": 0,
        "expires_at": now + RESTORE_CODE_TTL_SECONDS,
        "created_at": now,
        "purpose": "delete",
    }).execute()
    await _send_delete_code_email(email, code)
    # Echo the address (which the client already knows) so the UI can say exactly where it went.
    return {"sent": True, "email": email}


# POST rather than DELETE: this carries a body, and intermediate proxies are entitled to drop
# the body off a DELETE. Mirrors the /api/restore/confirm naming already used above.
@app.post("/api/account/delete/confirm")
async def delete_account(body: AccountDeleteBody, request: Request):
    await rate_limit(f"acct_del:{client_ip(request)}", limit=10, window_seconds=60)
    vid = request.state.vid
    email = await _account_email_for_vid(vid)
    code = (body.code or "").strip()
    if not code:
        raise HTTPException(400, "Enter the code from your email")

    now = int(time.time())
    res = (
        await supabase.table("restore_codes")
        .select("id,code_hash,vid,attempts,expires_at,used_at")
        .eq("email", email)
        .eq("vid", vid)
        .eq("purpose", "delete")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    row = res.data[0] if res.data else None
    invalid = HTTPException(400, "That code is invalid or has expired \u2014 request a new one")
    if not row or row.get("used_at") or row["expires_at"] < now:
        raise invalid
    if row["attempts"] >= RESTORE_MAX_CODE_ATTEMPTS:
        raise HTTPException(429, "Too many incorrect attempts \u2014 request a new code")
    if not secrets.compare_digest(row["code_hash"], _hash_restore_code(email, code)):
        await (
            supabase.table("restore_codes")
            .update({"attempts": row["attempts"] + 1})
            .eq("id", row["id"])
            .execute()
        )
        raise invalid
    # Burn the code before doing any destructive work, so a retried/duplicated request can't
    # re-enter the deletion path partway through.
    await supabase.table("restore_codes").update({"used_at": now}).eq("id", row["id"]).execute()

    sub_res = (
        await supabase.table("subscriptions")
        .select("stripe_subscription_id,comp_code,source")
        .eq("visitor_id", vid)
        .limit(1)
        .execute()
    )
    sub = sub_res.data[0] if sub_res.data else None

    # Billing first. If this fails we abort before deleting anything, because the one outcome
    # we must never produce is a live recurring charge with no account left to cancel it from.
    cancelled_subscription = False
    if sub and sub.get("stripe_subscription_id"):
        try:
            await stripe_request("DELETE", f"/v1/subscriptions/{sub['stripe_subscription_id']}")
            cancelled_subscription = True
        except HTTPException as exc:
            # A subscription Stripe no longer has (already cancelled, or test data) must not
            # block the user from deleting their account.
            if exc.status_code not in (404, 400):
                raise HTTPException(
                    502,
                    "We couldn't cancel your subscription with our payment processor, so nothing "
                    "was deleted. Please try again in a moment.",
                )

    # Release any complimentary code back to unredeemed so it can be issued or reused later.
    released_comp_code = False
    if sub and sub.get("comp_code"):
        await (
            supabase.table("comp_grants")
            .update({"redeemed_at": None, "redeemed_visitor_id": None})
            .eq("code", sub["comp_code"])
            .execute()
        )
        released_comp_code = True
    # Belt and braces: catch any grant claimed by this visitor that the subscription row
    # didn't name (e.g. an older grant superseded by a later one).
    await (
        supabase.table("comp_grants")
        .update({"redeemed_at": None, "redeemed_visitor_id": None})
        .eq("redeemed_visitor_id", vid)
        .execute()
    )

    # Shares in both directions. Grants where this account owns the pin would also disappear
    # via the waypoint_id FK cascade when the pins go, but grants where this account is the
    # RECIPIENT point at other people's pins and would otherwise survive as dangling access.
    await supabase.table("waypoint_share_grants").delete().eq("recipient_vid", vid).execute()
    await supabase.table("waypoint_share_grants").delete().eq("owner_vid", vid).execute()
    # Share-link rows are keyed on the owner, so any outstanding link they handed out dies here.
    await supabase.table("waypoint_shares").delete().eq("visitor_id", vid).execute()

    await supabase.table("waypoints").delete().eq("visitor_id", vid).execute()
    await supabase.table("tracks").delete().eq("visitor_id", vid).execute()
    await supabase.table("view_state").delete().eq("visitor_id", vid).execute()
    await supabase.table("display_names").delete().eq("visitor_id", vid).execute()
    await supabase.table("subscriptions").delete().eq("visitor_id", vid).execute()
    # Every outstanding sign-in/restore/delete code for this address, so no emailed code can
    # be replayed against a recreated account.
    await supabase.table("restore_codes").delete().eq("email", email).execute()
    # The account row goes last: while it exists the steps above remain re-runnable if this
    # request dies midway, whereas losing it first would orphan everything else.
    await supabase.table("accounts").delete().eq("email", email).execute()

    response = JSONResponse({
        "deleted": True,
        "cancelledSubscription": cancelled_subscription,
        "releasedCompCode": released_comp_code,
    })
    # Clear the device's identity so the app comes back up as a brand new free visitor rather
    # than a signed-in one pointing at rows that no longer exist.
    response.delete_cookie(VISITOR_COOKIE, path="/")
    return response


# ------------------------------------------------------------------------------------------
# Waypoints (dropped pins) — persisted per visitor, plus shareable links so a set of pins can
# be shared onto another visitor's map. Sharing is a
# LIVE, view-only grant (see waypoint_share_grants below), not a copy: the recipient always
# sees the owner's current row, the owner can revoke access any time, and the recipient can
# never edit or delete the original.
# ------------------------------------------------------------------------------------------


class WaypointBody(BaseModel):
    type: str
    lng: float
    lat: float
    # Length caps prevent a single visitor from bloating the database with oversized
    # free-text fields (storage-abuse hardening added during security review).
    label: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=2000)
    confidence: int | None = None


class WaypointBulkBody(BaseModel):
    items: list[WaypointBody] = Field(max_length=200)


class ShareBody(BaseModel):
    ids: list[str] | None = None


class DisplayNameBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


WAYPOINT_COLUMNS = "id,visitor_id,type,lng,lat,label,note,confidence,created_at,shared_from"


def _waypoint_dict(row: dict, view_only: bool = False, owner_name: str | None = None) -> dict:
    return {
        "id": row["id"],
        "type": row["type"],
        "lng": row["lng"],
        "lat": row["lat"],
        "label": row["label"],
        "note": row["note"],
        "confidence": row["confidence"],
        "createdAt": row["created_at"],
        "sharedFrom": row["shared_from"],
        "viewOnly": view_only,
        "ownerName": owner_name,
    }


async def _insert_waypoint(vid: str, item: WaypointBody, shared_from: str | None = None) -> dict:
    wp_id = secrets.token_urlsafe(9)
    now = int(time.time())
    await supabase.table("waypoints").insert(
        {
            "id": wp_id,
            "visitor_id": vid,
            "type": item.type,
            "lng": item.lng,
            "lat": item.lat,
            "label": item.label,
            "note": item.note,
            "confidence": item.confidence,
            "created_at": now,
            "shared_from": shared_from,
        }
    ).execute()
    return {
        "id": wp_id,
        "type": item.type,
        "lng": item.lng,
        "lat": item.lat,
        "label": item.label,
        "note": item.note,
        "confidence": item.confidence,
        "createdAt": now,
        "sharedFrom": shared_from,
    }


@app.get("/api/waypoints")
async def list_waypoints(request: Request):
    vid = request.state.vid
    res = await supabase.table("waypoints").select(WAYPOINT_COLUMNS).eq("visitor_id", vid).order(
        "created_at", desc=False
    ).execute()
    own = [_waypoint_dict(r) for r in res.data]

    # Live shares: pins someone else owns and has actively shared with this visitor. These
    # are never copied into this visitor's own `waypoints` rows — we re-fetch the owner's
    # live row every time, so edits/deletes on the owner's side are reflected automatically,
    # and the recipient can never edit or delete the original (view-only, enforced below and
    # again server-side on every mutating endpoint by ownership checks).
    grants_res = await supabase.table("waypoint_share_grants").select("waypoint_id").eq(
        "recipient_vid", vid
    ).is_("revoked_at", "null").execute()
    shared_ids = [g["waypoint_id"] for g in grants_res.data]
    shared = []
    if shared_ids:
        shared_res = await supabase.table("waypoints").select(WAYPOINT_COLUMNS).in_(
            "id", shared_ids
        ).execute()
        # Each shared row's own `visitor_id` IS the owner (a live view of the owner's row,
        # never a copy) -- look up display names keyed on that to label each pin with who
        # shared it, onX-style, every time the map loads.
        owner_names = await _lookup_display_names([r["visitor_id"] for r in shared_res.data])
        shared = [
            _waypoint_dict(r, view_only=True, owner_name=owner_names.get(r["visitor_id"]))
            for r in shared_res.data
        ]
    return {"waypoints": own + shared}


@app.post("/api/waypoints")
async def create_waypoint(body: WaypointBody, request: Request):
    await rate_limit(f"waypoint-write:{client_ip(request)}", limit=60, window_seconds=60)
    vid = request.state.vid
    wp = await _insert_waypoint(vid, body)
    return wp


@app.post("/api/waypoints/bulk")
async def create_waypoints_bulk(body: WaypointBulkBody, request: Request):
    await rate_limit(f"waypoint-write:{client_ip(request)}", limit=60, window_seconds=60)
    vid = request.state.vid
    if not body.items:
        raise HTTPException(400, "No waypoints provided")
    if len(body.items) > 200:
        raise HTTPException(400, "Too many waypoints in one request")
    created = [await _insert_waypoint(vid, item) for item in body.items]
    return {"waypoints": created}


class WaypointUpdateBody(BaseModel):
    # Only the pin's style (type) and its display label can be edited; position, note and
    # ownership are untouched. Same length caps as WaypointBody.
    type: str = Field(min_length=1, max_length=40)
    label: str | None = Field(default=None, max_length=200)


@app.patch("/api/waypoints/{wp_id}")
async def update_waypoint(wp_id: str, body: WaypointUpdateBody, request: Request):
    await rate_limit(f"waypoint-write:{client_ip(request)}", limit=60, window_seconds=60)
    vid = request.state.vid
    res = await supabase.table("waypoints").select("visitor_id").eq("id", wp_id).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "Waypoint not found")
    # Owner-only, same check as delete: people a pin is shared with can never edit it.
    if res.data[0]["visitor_id"] != vid:
        raise HTTPException(403, "This pin belongs to a different visitor")
    update = {"type": body.type}
    if body.label is not None:
        update["label"] = body.label
    await supabase.table("waypoints").update(update).eq("id", wp_id).execute()
    return {"id": wp_id, **update}


@app.delete("/api/waypoints/{wp_id}")
async def delete_waypoint(wp_id: str, request: Request):
    vid = request.state.vid
    res = await supabase.table("waypoints").select("visitor_id").eq("id", wp_id).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "Waypoint not found")
    if res.data[0]["visitor_id"] != vid:
        raise HTTPException(403, "This pin belongs to a different visitor")
    await supabase.table("waypoints").delete().eq("id", wp_id).execute()
    return {"deleted": True}


def _clean_display_name(raw: str) -> str:
    # Strip control characters and collapse whitespace -- this is shown directly to other
    # visitors (share banners, access lists), so keep it to plain visible text.
    cleaned = "".join(ch for ch in raw if ch.isprintable()).strip()
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        raise HTTPException(400, "Please enter a name")
    return cleaned[:40]


@app.get("/api/profile/name")
async def get_display_name(request: Request):
    # Optional, per-visitor display name shown only in pin-sharing contexts (never required to
    # use the app). Keyed on visitor_id rather than account/email so it works the same whether
    # or not the visitor has signed in yet.
    vid = request.state.vid
    res = await supabase.table("display_names").select("name").eq("visitor_id", vid).limit(1).execute()
    return {"name": res.data[0]["name"] if res.data else None}


@app.post("/api/profile/name")
async def set_display_name(body: DisplayNameBody, request: Request):
    await rate_limit(f"display-name:{client_ip(request)}", limit=30, window_seconds=60)
    vid = request.state.vid
    name = _clean_display_name(body.name)
    now = int(time.time())
    existing = await supabase.table("display_names").select("visitor_id").eq("visitor_id", vid).limit(1).execute()
    if existing.data:
        await supabase.table("display_names").update({"name": name, "updated_at": now}).eq(
            "visitor_id", vid
        ).execute()
    else:
        await supabase.table("display_names").insert(
            {"visitor_id": vid, "name": name, "created_at": now, "updated_at": now}
        ).execute()
    return {"name": name}


async def _lookup_display_names(vids: list[str]) -> dict[str, str]:
    unique = list({v for v in vids if v})
    if not unique:
        return {}
    res = await supabase.table("display_names").select("visitor_id,name").in_("visitor_id", unique).execute()
    return {row["visitor_id"]: row["name"] for row in res.data}


# ------------------------------------------------------------------------------------------
# Tracks (recorded GPS walks, onX-style) — Premium only. Saved per visitor like waypoints, so
# a signed-in account sees them on every device (merged in _merge_visitor_into_account and
# wiped in account deletion). Points are stored as a compact [[lng, lat, unix_seconds], ...]
# array; distance is recomputed server-side from the points rather than trusted from the client.
# ------------------------------------------------------------------------------------------

TRACK_MAX_POINTS = 20000  # ~11 h at one point every 2 s — far beyond a normal hunt
TRACK_COLUMNS = "id,name,points,distance_m,duration_s,created_at"


class TrackBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    points: list[list[float]] = Field(min_length=2, max_length=TRACK_MAX_POINTS)


class TrackRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=80)


def _track_distance_m(points: list[list[float]]) -> float:
    total = 0.0
    for a, b in zip(points, points[1:]):
        lat1, lat2 = math.radians(a[1]), math.radians(b[1])
        dlat = lat2 - lat1
        dlng = math.radians(b[0] - a[0])
        h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
        total += 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(h)))
    return total


async def _require_premium(request: Request) -> None:
    sub = await get_subscription(request)
    if sub.get("tier", "free") == "free":
        raise HTTPException(402, "Tracks are a Premium feature")


# ---------------------------------------------------------------------------------------
# Paid parcel lookups (GetParcelData) for states with no free statewide parcel service.
# The frontend only calls this when its own STATE_PARCEL_CONFIG has no free source for the
# tapped state, so free states never spend a paid lookup. Guard rails, because every
# upstream call is billed (Starter plan: 1,000 lookups/month, overage per lookup):
#   * Premium-only (same gate as the parcel layer itself).
#   * Hard monthly cap (PARCEL_MONTHLY_CAP, default 950) enforced with an atomic Postgres
#     counter (bump_parcel_lookups), incremented BEFORE the upstream call so concurrent taps
#     can't overshoot. Past the cap the app falls back to the old acreage estimate.
#   * Every returned parcel is cached with its bounding box + polygon; a later tap anywhere
#     inside an already-fetched parcel is answered from the cache for free.
#   * Per-IP and per-visitor rate limits.
# The API key lives only in the Render env (GETPARCELDATA_API_KEY) — never in the frontend.
GETPARCELDATA_API_KEY = os.environ.get("GETPARCELDATA_API_KEY", "")
if GETPARCELDATA_API_KEY:
    GPD_BASE = "https://api.getparceldata.com"
    GPD_HEADERS = {"Authorization": f"Bearer {GETPARCELDATA_API_KEY}"}
else:  # sandbox testing through the custom-credentials proxy
    GPD_BASE = os.environ.get("CUSTOM_CRED_API_GETPARCELDATA_COM_URL", "").rstrip("/")
    GPD_HEADERS = {"x-api-key": os.environ.get("CUSTOM_CRED_API_GETPARCELDATA_COM_TOKEN", "")}
PARCEL_MONTHLY_CAP = int(os.environ.get("PARCEL_MONTHLY_CAP", "950"))


def _wkt_rings(wkt: str) -> list:
    """Outer rings of a POLYGON/MULTIPOLYGON WKT as lists of (x, y)."""
    body = wkt[wkt.index("("):] if "(" in wkt else ""
    rings = []
    depth = 0
    buf = ""
    ring_depth = 3 if wkt.strip().upper().startswith("MULTIPOLYGON") else 2
    poly_ring_index = 0
    for ch in body:
        if ch == "(":
            depth += 1
            if depth == ring_depth:
                buf = ""
            if depth == ring_depth - 1:
                poly_ring_index = 0
            continue
        if ch == ")":
            if depth == ring_depth:
                if poly_ring_index == 0:  # keep outer ring only
                    pts = []
                    for pair in buf.split(","):
                        xy = pair.split()
                        if len(xy) >= 2:
                            pts.append((float(xy[0]), float(xy[1])))
                    if len(pts) >= 3:
                        rings.append(pts)
                poly_ring_index += 1
            depth -= 1
            continue
        if depth == ring_depth:
            buf += ch
    return rings


def _point_in_rings(x: float, y: float, rings: list) -> bool:
    for ring in rings:
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-15) + xi:
                inside = not inside
            j = i
        if inside:
            return True
    return False


def _parcel_summary(p: dict) -> dict:
    def num(v):
        try:
            f = float(v)
            return f if f > 0 else None
        except (TypeError, ValueError):
            return None
    return {
        "owner": (p.get("owner_name") or "").strip() or None,
        "acres": num(p.get("acreage")) or (num(p.get("area")) / 4046.8564224 if num(p.get("area")) else None),
        "siteAddress": (p.get("property_address_line1") or "").strip() or None,
        "siteCity": (p.get("property_city") or "").strip() or None,
        "parcelId": (p.get("parcel_id") or p.get("apn") or "").strip() or None,
        "value": num(p.get("assessed_value")) or num(p.get("land_value")),
    }


@app.get("/api/parcel")
async def paid_parcel_lookup(lat: float, lng: float, request: Request):
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(400, "Bad coordinates")
    await rate_limit(f"parcel-ip:{client_ip(request)}", limit=30, window_seconds=60)
    await rate_limit(f"parcel-vid:{request.state.vid}", limit=120, window_seconds=3600)
    sub = await get_subscription(request)
    if sub.get("tier", "free") == "free":
        raise HTTPException(402, "Parcel details are a Premium feature")
    # 1) Cache: any stored parcel whose bbox contains the point and whose polygon does too.
    cached = await supabase.table("parcel_cache").select("summary,wkt").lte("min_x", lng).gte(
        "max_x", lng).lte("min_y", lat).gte("max_y", lat).limit(20).execute()
    for row in cached.data or []:
        try:
            if _point_in_rings(lng, lat, _wkt_rings(row["wkt"])):
                return {"kind": "live", "cached": True, "attrs": row["summary"]}
        except Exception:
            continue
    if not GPD_BASE:
        return {"kind": "unavailable"}
    # 2) Atomic monthly budget check before spending a paid lookup.
    month = time.strftime("%Y-%m", time.gmtime())
    try:
        res = await supabase.rpc("bump_parcel_lookups", {"p_month": month, "p_cap": PARCEL_MONTHLY_CAP}).execute()
        allowed = bool(res.data)
    except Exception:
        return {"kind": "unavailable"}
    if not allowed:
        return {"kind": "capped"}
    # 3) Paid upstream lookup.
    try:
        r = await http_client.get(
            f"{GPD_BASE}/v1/parcels/point",
            params={"lat": f"{lat:.6f}", "lng": f"{lng:.6f}", "limit": 1},
            headers=GPD_HEADERS,
            timeout=15,
        )
        if r.status_code != 200:
            return {"kind": "unavailable"}
        parcels = (r.json() or {}).get("parcels") or []
    except Exception:
        return {"kind": "unavailable"}
    if not parcels:
        return {"kind": "empty"}
    p = parcels[0]
    summary = _parcel_summary(p)
    wkt = p.get("geometry_wkt") or ""
    try:
        rings = _wkt_rings(wkt)
        xs = [x for ring in rings for x, _ in ring]
        ys = [y for ring in rings for _, y in ring]
        if xs and len(wkt) < 400000:
            key = (summary.get("parcelId") or "") + ":" + (p.get("county_geoid") or "")
            if key == ":":
                key = f"pt:{lng:.5f},{lat:.5f}"
            await supabase.table("parcel_cache").upsert({
                "id": key[:200], "summary": summary, "wkt": wkt,
                "min_x": min(xs), "max_x": max(xs), "min_y": min(ys), "max_y": max(ys),
                "created_at": int(time.time()),
            }).execute()
    except Exception:
        pass  # caching is best-effort; never fail the user's lookup over it
    return {"kind": "live", "cached": False, "attrs": summary}


# ---------------------------------------------------------------------------
# Scout AI surroundings: USDA NASS Cropland Data Layer (CDL) context around a scan area.
# CropScape (nassgeodata.gmu.edu) sends no CORS headers, so the app can't call it directly.
# Given the scan area's bbox, this expands it by a buffer (default 1/2 mile), clips the CDL
# raster for that box, and returns coarse 90 m cells of the classes Scout AI weighs:
# food crops/pasture, water, and developed ground (disturbance), plus per-patch acreage.
# Public, free data; no key. Results cached in memory (same area + year) to spare CropScape.
# ---------------------------------------------------------------------------
_ALB_A = 6378137.0
_ALB_E2 = 0.00669438002290
_ALB_E = math.sqrt(_ALB_E2)


def _alb_q(phi):
    s = math.sin(phi)
    return (1 - _ALB_E2) * (s / (1 - _ALB_E2 * s * s) - (1 / (2 * _ALB_E)) * math.log((1 - _ALB_E * s) / (1 + _ALB_E * s)))


def _alb_m(phi):
    s = math.sin(phi)
    return math.cos(phi) / math.sqrt(1 - _ALB_E2 * s * s)


_ALB_P1, _ALB_P2, _ALB_P0, _ALB_L0 = [math.radians(v) for v in (29.5, 45.5, 23.0, -96.0)]
_ALB_N = (_alb_m(_ALB_P1) ** 2 - _alb_m(_ALB_P2) ** 2) / (_alb_q(_ALB_P2) - _alb_q(_ALB_P1))
_ALB_C = _alb_m(_ALB_P1) ** 2 + _ALB_N * _alb_q(_ALB_P1)
_ALB_R0 = _ALB_A * math.sqrt(_ALB_C - _ALB_N * _alb_q(_ALB_P0)) / _ALB_N


def _to_albers(lng, lat):
    """WGS84 lng/lat -> EPSG:5070 (NAD83 CONUS Albers), the CDL's native grid."""
    rho = _ALB_A * math.sqrt(_ALB_C - _ALB_N * _alb_q(math.radians(lat))) / _ALB_N
    th = _ALB_N * (math.radians(lng) - _ALB_L0)
    return rho * math.sin(th), _ALB_R0 - rho * math.cos(th)


def _from_albers(x, y):
    rho = math.hypot(x, _ALB_R0 - y)
    q = (_ALB_C - (rho * _ALB_N / _ALB_A) ** 2) / _ALB_N
    th = math.atan2(x, _ALB_R0 - y)
    phi = math.asin(max(-1.0, min(1.0, q / 2)))
    for _ in range(8):
        s = math.sin(phi)
        phi += (1 - _ALB_E2 * s * s) ** 2 / (2 * math.cos(phi)) * (
            q / (1 - _ALB_E2) - s / (1 - _ALB_E2 * s * s)
            + (1 / (2 * _ALB_E)) * math.log((1 - _ALB_E * s) / (1 + _ALB_E * s)))
    return math.degrees(_ALB_L0 + th / _ALB_N), math.degrees(phi)


# CDL class -> (kind, short label). Anything not listed is ignored (grass, barren, etc.).
_CDL_FOOD = {
    1: "Corn", 12: "Sweet Corn", 13: "Corn", 225: "Wheat/Corn", 226: "Oats/Corn", 237: "Barley/Corn",
    241: "Corn/Soybeans", 5: "Soybeans", 26: "Wheat/Soybeans", 240: "Soybeans/Oats", 254: "Barley/Soybeans",
    236: "Wheat/Sorghum", 4: "Sorghum", 24: "Winter Wheat", 23: "Spring Wheat", 22: "Durum Wheat",
    21: "Barley", 27: "Rye", 28: "Oats", 205: "Triticale", 29: "Millet", 36: "Alfalfa", 58: "Clover",
    37: "Hay", 10: "Peanuts", 2: "Cotton", 238: "Wheat/Cotton", 6: "Sunflower", 31: "Canola",
    53: "Peas", 42: "Dry Beans", 43: "Potatoes", 41: "Sugarbeets", 74: "Pecans", 68: "Apples",
    61: "Fallow", 176: "Pasture",
}
_CDL_OTHER = {
    111: ("water", "Open Water"), 190: ("water", "Woody Wetland"), 195: ("water", "Herbaceous Wetland"),
    122: ("developed", "Houses/Roads"), 123: ("developed", "Developed"), 124: ("developed", "Developed"),
}
_CDL_CACHE: dict = {}
_CDL_CACHE_MAX = 300
CDL_SERVICE = "https://nassgeodata.gmu.edu/axis2/services/CDLService"


def _cdl_kind(v):
    if v in _CDL_FOOD:
        return "food", _CDL_FOOD[v]
    return _CDL_OTHER.get(v, (None, None))


async def _cdl_fetch_tif(year: int, bbox_alb: str) -> bytes | None:
    r = await http_client.get(f"{CDL_SERVICE}/GetCDLFile", params={"year": year, "bbox": bbox_alb}, timeout=25)
    if r.status_code != 200 or "<returnURL>" not in r.text:
        return None
    url = r.text.split("<returnURL>", 1)[1].split("</returnURL>", 1)[0].strip()
    if not url.startswith("https://nassgeodata.gmu.edu/"):
        return None
    t = await http_client.get(url, timeout=25)
    return t.content if t.status_code == 200 and len(t.content) < 8_000_000 else None


@app.get("/api/crop-context")
async def crop_context(w: float, s: float, e: float, n: float, request: Request, buffer_m: float = 805):
    if not (-125 <= w < e <= -66 and 24 <= s < n <= 50):
        raise HTTPException(400, "Area must be inside the lower 48 states")
    buffer_m = max(0.0, min(buffer_m, 1610.0))
    await rate_limit(f"crop-ip:{client_ip(request)}", limit=20, window_seconds=60)
    xs, ys = zip(*[_to_albers(lng, lat) for lng, lat in ((w, s), (w, n), (e, s), (e, n))])
    x0, x1 = min(xs) - buffer_m, max(xs) + buffer_m
    y0, y1 = min(ys) - buffer_m, max(ys) + buffer_m
    if (x1 - x0) > 16000 or (y1 - y0) > 16000:
        return {"kind": "too_large"}
    # Snap to the 30 m CDL grid (and to 90 m for the cache key) so repeat scans reuse results.
    x0, y0 = math.floor(x0 / 90) * 90, math.floor(y0 / 90) * 90
    x1, y1 = math.ceil(x1 / 90) * 90, math.ceil(y1 / 90) * 90
    this_year = time.gmtime().tm_year
    key = (x0, y0, x1, y1)
    hit = _CDL_CACHE.get(key)
    if hit and time.time() - hit[0] < 86400 * 7:
        return hit[1]
    tif = None
    year = None
    for yr in (this_year - 1, this_year - 2, this_year - 3):
        try:
            tif = await _cdl_fetch_tif(yr, f"{x0},{y0},{x1},{y1}")
        except Exception:
            tif = None
        if tif:
            year = yr
            break
    if not tif:
        return {"kind": "unavailable"}
    try:
        im = Image.open(io.BytesIO(tif))
        tags = im.tag_v2
        sx, sy = tags.get(33550)[:2]
        tie = tags.get(33922)
        ox, oy = tie[3], tie[4]
        W, H = im.size
        px = im.load()
    except Exception:
        return {"kind": "unavailable"}
    # Label connected same-kind/same-label patches at 30 m so each cell can report its field's
    # acreage (a 3 ac food plot vs. a 400 ac bean field pulls deer very differently).
    lab = [[None] * W for _ in range(H)]
    patch_acres: list = []
    grid = [[_cdl_kind(px[c, r]) for c in range(W)] for r in range(H)]
    for r in range(H):
        for c in range(W):
            k, name = grid[r][c]
            if k is None or lab[r][c] is not None:
                continue
            pid = len(patch_acres)
            stack = [(r, c)]
            lab[r][c] = pid
            cnt = 0
            while stack:
                rr, cc = stack.pop()
                cnt += 1
                for dr, dc in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nr, nc = rr + dr, cc + dc
                    if 0 <= nr < H and 0 <= nc < W and lab[nr][nc] is None and grid[nr][nc] == (k, name):
                        lab[nr][nc] = pid
                        stack.append((nr, nc))
            patch_acres.append(cnt * sx * sy / 4046.86)
    # Downsample to 90 m blocks: majority relevant class wins; ignore specks under 2 pixels.
    cells = []
    for br in range(0, H, 3):
        for bc in range(0, W, 3):
            tally: dict = {}
            for r in range(br, min(br + 3, H)):
                for c in range(bc, min(bc + 3, W)):
                    k, name = grid[r][c]
                    if k is None:
                        continue
                    t = tally.setdefault((k, name), [0, lab[r][c]])
                    t[0] += 1
            if not tally:
                continue
            (k, name), (cnt, pid) = max(tally.items(), key=lambda kv: kv[1][0])
            if cnt < 2:
                continue
            ax = ox + (bc + 1.5) * sx
            ay = oy - (br + 1.5) * sy
            lng, lat = _from_albers(ax, ay)
            cells.append([round(lng, 6), round(lat, 6), k[0], name, round(patch_acres[pid], 1)])
    out = {"kind": "ok", "year": year, "source": "USDA NASS Cropland Data Layer", "cellMeters": 90,
           "cells": cells[:20000]}
    if len(_CDL_CACHE) >= _CDL_CACHE_MAX:
        _CDL_CACHE.pop(next(iter(_CDL_CACHE)))
    _CDL_CACHE[key] = (time.time(), out)
    return out


@app.get("/api/tracks")
async def list_tracks(request: Request):
    vid = request.state.vid
    res = await supabase.table("tracks").select(TRACK_COLUMNS).eq("visitor_id", vid).order(
        "created_at", desc=True
    ).execute()
    return {
        "tracks": [
            {
                "id": r["id"],
                "name": r["name"],
                "points": r["points"],
                "distanceM": r["distance_m"],
                "durationS": r["duration_s"],
                "createdAt": r["created_at"],
            }
            for r in res.data
        ]
    }


@app.post("/api/tracks")
async def create_track(body: TrackBody, request: Request):
    await rate_limit(f"track-write:{client_ip(request)}", limit=20, window_seconds=60)
    await _require_premium(request)
    vid = request.state.vid
    pts = []
    for p in body.points:
        if len(p) < 3:
            raise HTTPException(400, "Each track point needs lng, lat and time")
        lng, lat, t = p[0], p[1], p[2]
        if not (-180 <= lng <= 180 and -90 <= lat <= 90 and math.isfinite(t)):
            raise HTTPException(400, "Track point out of range")
        pts.append([round(lng, 6), round(lat, 6), int(t)])
    distance = round(_track_distance_m(pts), 1)
    duration = max(0, pts[-1][2] - pts[0][2])
    track_id = secrets.token_urlsafe(9)
    now = int(time.time())
    await supabase.table("tracks").insert(
        {
            "id": track_id,
            "visitor_id": vid,
            "name": body.name.strip() or "Track",
            "points": pts,
            "distance_m": distance,
            "duration_s": duration,
            "created_at": now,
        }
    ).execute()
    return {
        "id": track_id,
        "name": body.name.strip() or "Track",
        "points": pts,
        "distanceM": distance,
        "durationS": duration,
        "createdAt": now,
    }


async def _own_track_or_404(track_id: str, vid: str) -> None:
    res = await supabase.table("tracks").select("visitor_id").eq("id", track_id).limit(1).execute()
    if not res.data or res.data[0]["visitor_id"] != vid:
        raise HTTPException(404, "Track not found")


@app.patch("/api/tracks/{track_id}")
async def rename_track(track_id: str, body: TrackRenameBody, request: Request):
    await rate_limit(f"track-write:{client_ip(request)}", limit=20, window_seconds=60)
    vid = request.state.vid
    await _own_track_or_404(track_id, vid)
    await supabase.table("tracks").update({"name": body.name.strip()}).eq("id", track_id).execute()
    return {"id": track_id, "name": body.name.strip()}


@app.delete("/api/tracks/{track_id}")
async def delete_track(track_id: str, request: Request):
    vid = request.state.vid
    await _own_track_or_404(track_id, vid)
    await supabase.table("tracks").delete().eq("id", track_id).eq("visitor_id", vid).execute()
    return {"deleted": True}


@app.post("/api/waypoints/share")
async def share_waypoints(body: ShareBody, request: Request):
    vid = request.state.vid
    if body.ids:
        res = await supabase.table("waypoints").select("id").eq("visitor_id", vid).in_("id", body.ids).execute()
        found_ids = [r["id"] for r in res.data]
        if not found_ids:
            raise HTTPException(404, "No matching pins found to share")
    else:
        res = await supabase.table("waypoints").select("id").eq("visitor_id", vid).order(
            "created_at", desc=False
        ).execute()
        found_ids = [r["id"] for r in res.data]
        if not found_ids:
            raise HTTPException(400, "You don't have any pins to share yet")
    code = secrets.token_urlsafe(9)
    now = int(time.time())
    await supabase.table("waypoint_shares").insert(
        {"code": code, "visitor_id": vid, "waypoint_ids": json.dumps(found_ids), "created_at": now}
    ).execute()
    return {"code": code, "count": len(found_ids)}


async def _load_shared_ordered(code: str) -> list[dict]:
    res = await supabase.table("waypoint_shares").select("waypoint_ids").eq("code", code).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "This share link is invalid or has expired")
    ids = json.loads(res.data[0]["waypoint_ids"])
    if not ids:
        return []
    res2 = await supabase.table("waypoints").select(WAYPOINT_COLUMNS).in_("id", ids).execute()
    by_id = {row["id"]: row for row in res2.data}
    # Preserve the order pins were shared in, and silently drop any the owner deleted since.
    return [by_id[i] for i in ids if i in by_id]


@app.get("/api/waypoints/share/{code}")
async def preview_share(code: str, request: Request):
    # Read-only, no-grant preview so the frontend can show an onX-style "Pin shared with
    # you -- Accept/Decline" prompt BEFORE anything is recorded. Deliberately returns only
    # a count, never the pin contents/coordinates themselves -- those stay hidden until the
    # recipient actually accepts, same boundary as the accept endpoint's rate limiting.
    await rate_limit(f"share-preview:{client_ip(request)}", limit=30, window_seconds=60)
    share_res = await supabase.table("waypoint_shares").select("visitor_id").eq("code", code).limit(1).execute()
    if not share_res.data:
        raise HTTPException(404, "This share link is invalid or has expired")
    owner_vid = share_res.data[0]["visitor_id"]
    rows = await _load_shared_ordered(code)
    owner_name = (await _lookup_display_names([owner_vid])).get(owner_vid)
    return {"count": len(rows), "ownLink": owner_vid == request.state.vid, "ownerName": owner_name}


@app.post("/api/waypoints/share/{code}/accept")
async def accept_share(code: str, request: Request):
    # Live share, onX-style: accepting a link does NOT copy the pin into the recipient's
    # own `waypoints` rows. Instead it records a standing grant that lets this visitor read
    # the owner's live row on every /api/waypoints load -- so edits the owner makes later
    # (or the owner deleting the pin, via the FK's ON DELETE CASCADE on this table) are
    # reflected automatically, and the owner can revoke access at any time from their side.
    # The recipient can never edit or delete the original: every mutating waypoint endpoint
    # checks `visitor_id` ownership, and a shared pin's `visitor_id` is always the owner's.
    await rate_limit(f"share-accept:{client_ip(request)}", limit=20, window_seconds=60)
    vid = request.state.vid
    share_res = await supabase.table("waypoint_shares").select("visitor_id").eq("code", code).limit(1).execute()
    if not share_res.data:
        raise HTTPException(404, "This share link is invalid or has expired")
    owner_vid = share_res.data[0]["visitor_id"]
    rows = await _load_shared_ordered(code)
    owner_name = (await _lookup_display_names([owner_vid])).get(owner_vid)
    if owner_vid == vid:
        # The sender opened their own link -- nothing to grant, these are already theirs.
        return {"waypoints": [_waypoint_dict(r) for r in rows], "ownLink": True, "ownerName": owner_name}
    now = int(time.time())
    for row in rows:
        await supabase.table("waypoint_share_grants").upsert(
            {
                "waypoint_id": row["id"],
                "owner_vid": owner_vid,
                "recipient_vid": vid,
                "share_code": code,
                "created_at": now,
                "revoked_at": None,
            },
            on_conflict="waypoint_id,recipient_vid",
        ).execute()
    return {
        "waypoints": [_waypoint_dict(r, view_only=True, owner_name=owner_name) for r in rows],
        "ownLink": False,
        "ownerName": owner_name,
    }


@app.get("/api/waypoints/{wp_id}/shares")
async def list_waypoint_shares(wp_id: str, request: Request):
    # Owner-only "who has this pin" view, for the Manage access list in the share modal.
    vid = request.state.vid
    wp_res = await supabase.table("waypoints").select("visitor_id").eq("id", wp_id).limit(1).execute()
    if not wp_res.data:
        raise HTTPException(404, "Waypoint not found")
    if wp_res.data[0]["visitor_id"] != vid:
        raise HTTPException(403, "This pin belongs to a different visitor")
    res = await supabase.table("waypoint_share_grants").select("id,created_at,recipient_vid").eq(
        "waypoint_id", wp_id
    ).is_("revoked_at", "null").order("created_at", desc=False).execute()
    names = await _lookup_display_names([g["recipient_vid"] for g in res.data])
    return {
        "grants": [
            {"id": g["id"], "createdAt": g["created_at"], "name": names.get(g["recipient_vid"])}
            for g in res.data
        ]
    }


@app.post("/api/waypoints/{wp_id}/shares/{grant_id}/revoke")
async def revoke_waypoint_share(wp_id: str, grant_id: int, request: Request):
    # Owner revokes one recipient's access. Takes effect next time that recipient's app
    # loads /api/waypoints -- there's no push channel to pull it off their map instantly.
    vid = request.state.vid
    wp_res = await supabase.table("waypoints").select("visitor_id").eq("id", wp_id).limit(1).execute()
    if not wp_res.data:
        raise HTTPException(404, "Waypoint not found")
    if wp_res.data[0]["visitor_id"] != vid:
        raise HTTPException(403, "This pin belongs to a different visitor")
    res = await supabase.table("waypoint_share_grants").select("id").eq("id", grant_id).eq(
        "waypoint_id", wp_id
    ).is_("revoked_at", "null").limit(1).execute()
    if not res.data:
        raise HTTPException(404, "That share grant wasn't found or was already revoked")
    await supabase.table("waypoint_share_grants").update({"revoked_at": int(time.time())}).eq(
        "id", grant_id
    ).execute()
    return {"revoked": True}


@app.delete("/api/waypoints/{wp_id}/my-share")
async def remove_my_shared_waypoint(wp_id: str, request: Request):
    # Recipient-side "remove from my map" -- hides a pin someone shared with you without
    # touching the owner's original or anyone else it was shared with.
    vid = request.state.vid
    res = await supabase.table("waypoint_share_grants").select("id").eq("waypoint_id", wp_id).eq(
        "recipient_vid", vid
    ).is_("revoked_at", "null").limit(1).execute()
    if not res.data:
        raise HTTPException(404, "This pin isn't currently shared with you")
    await supabase.table("waypoint_share_grants").update({"revoked_at": int(time.time())}).eq(
        "id", res.data[0]["id"]
    ).execute()
    return {"removed": True}


# ------------------------------------------------------------------------------------------
# Last-viewed map position — so the map opens back where the visitor left off instead of the
# hardcoded default center on every visit.
# ------------------------------------------------------------------------------------------


class ViewStateBody(BaseModel):
    lng: float
    lat: float
    zoom: float


@app.get("/api/view-state")
async def get_view_state(request: Request):
    vid = request.state.vid
    res = await supabase.table("view_state").select("lng,lat,zoom").eq("visitor_id", vid).limit(1).execute()
    if not res.data:
        return {}
    r = res.data[0]
    return {"lng": r["lng"], "lat": r["lat"], "zoom": r["zoom"]}


@app.api_route("/api/view-state", methods=["PUT", "POST"])
async def save_view_state(body: ViewStateBody, request: Request):
    # POST is accepted alongside PUT solely so the frontend can flush the last map
    # position via navigator.sendBeacon() when the tab is being backgrounded/closed —
    # sendBeacon only ever sends POST and can't set a custom method. See the
    # visibilitychange/pagehide handlers in app.js.
    await rate_limit(f"view-state:{client_ip(request)}", limit=60, window_seconds=60)
    vid = request.state.vid
    now = int(time.time())
    await supabase.table("view_state").upsert(
        {"visitor_id": vid, "lng": body.lng, "lat": body.lat, "zoom": body.zoom, "updated_at": now},
        on_conflict="visitor_id",
    ).execute()
    return {"saved": True}


# ---- Public-land tile proxy: PAD-US primary + DOE NETL fallback ----------------------
#
# The frontend used to hit edits.nationalmap.gov directly from the browser for the
# public/protected-land highlight overlay. That host has had real outages (confirmed live:
# a 503 "Service Unavailable" while investigating a user report of the overlay vanishing),
# and a browser-side raster source has no way to retry a different backend when its one
# configured tile URL starts failing -- MapLibre just silently drops the tile, which reads
# to the user as "no public land here" instead of "the data source is down". Routing tile
# requests through this backend instead lets us try the primary service first and, only on
# failure, fall back to a second live data source so the layer degrades gracefully instead
# of going blank during an outage.
#
# Primary: PAD-US 4.1 Landforms MapServer (edits.nationalmap.gov) -- unchanged from the
# existing client-side URL (same layer, same layerDefs/dynamicLayers/style), just proxied
# through here so a failure can be caught server-side instead of silently eaten by the
# browser. On success this is a byte-for-byte passthrough of the same PNG the browser used
# to fetch directly.
#
# Fallback: DOE NETL's hosted mirror of the same PAD-US dataset (arcgis.netl.doe.gov),
# confirmed live and responsive when the primary was down. It's a FeatureServer (vector
# query only, no /export image endpoint) with a different field schema that's missing the
# Pub_Access field the primary's access filter relies on -- so this route queries it and
# rasterizes the result itself, approximating the same "exclude closed/private-easement
# clutter" filter using the fields it does have: `category` (Fee/Designation/Easement/
# Proclamation). Excluding Easement approximates excluding Pub_Access='XA' (verified
# separately: MS's Pub_Access='XA' records are overwhelmingly private conservation
# easements), and excluding Proclamation matches the primary's own existing filter (removes
# the oversized "authorized acquisition boundary" outline around refuges/forests). This is a
# deliberate approximation, not as precise as the primary's real Pub_Access field, and only
# ever used while the primary is down.
PADUS_PRIMARY_QUERY_URL = "https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_Landforms/MapServer/0/query"
# Mississippi's entire 640,000+ acre 16th-Section Public School Trust Lands program is
# digitized in PAD-US as ONE multi-part feature (Unit_Nm='Mississippi 16th Section Public
# School Trust Lands', Own_Name='SLB', GIS_Acres=646179) covering every one-square-mile leased
# trust section statewide -- and PAD-US tags it Pub_Access='OA' (Open Access), so the bare
# Pub_Access <> 'XA' filter never excluded it even though it's leased to private individuals by
# local school districts and not open to public hunting/access. This is the land reported
# reappearing on the map as a grid of small squares (one per leased section). Verified live
# against the service's own query endpoint that this is a single distinct record, so excluding
# it by exact Unit_Nm is surgical -- the state's other SLB-owned records (Red Creek WMA, small
# "State Lands" parcels) are untouched and stay visible.
PADUS_PRIMARY_WHERE = (
    "Pub_Access <> 'XA' AND Category <> 'Proclamation' "
    "AND Unit_Nm <> 'Mississippi 16th Section Public School Trust Lands'"
)
# IMPORTANT -- do not resurrect the old /export + layerDefs/dynamicLayers approach here.
# Confirmed live (2026-09-08) that this MapServer's /export endpoint SILENTLY IGNORES the
# top-level `layerDefs` parameter whenever `dynamicLayers` is also present (needed for the
# custom thin-outline styling) -- requests with `layerDefs` set to the real filter, to `1=1`,
# and to `1=0` all returned byte-identical images, proving no filter was ever actually being
# applied on that path despite returning 200. Moving the filter into `dynamicLayers[0].
# definitionExpression` (the ArcGIS-documented way to filter a layer when dynamicLayers is in
# use) DOES get respected by the server for a single condition, but a front-end WAF in front of
# this host 404s any request combining two or more conditions with `AND` inside that JSON param
# (confirmed: each condition alone succeeds, every 2-condition combination 404s) -- so the real
# 3-condition filter can never reach the server via /export at all. The plain `/0/query`
# endpoint's flat `where` param has neither problem (verified: correctly excludes the 16th-
# section record and returns only the 29 legitimate features expected for a test area), so that
# is now the primary path -- see public_land_tile() below, which queries geometry and rasterizes
# it with the same helper used for the NETL fallback.
PADUS_PRIMARY_DYNAMIC_LAYERS = json.dumps([{
    "id": 0,
    "source": {"type": "mapLayer", "mapLayerId": 0},
    "drawingInfo": {
        "showLabels": False,
        "renderer": {
            "type": "simple",
            "symbol": {
                "type": "esriSFS",
                "style": "esriSFSSolid",
                "color": [190, 240, 165, 33],
                "outline": {"type": "esriSLS", "style": "esriSLSSolid", "color": [140, 215, 115, 255], "width": 1.5},
            },
        },
    },
}])

# USACE's own real-estate system of record (REMIS "Civil Works Land Data Migration"), layer 5
# ("Site") -- the authoritative per-project Corps boundary, kept in sync with the mirrored
# constants in app.js (USACE_CWLDM_*). Proxied here for the same reason as the PAD-US route
# above, but for a different root cause: geospatial.sec.usace.army.mil only sends
# Access-Control-Allow-Origin for requests whose Origin header is itself a *.usace.army.mil
# domain (confirmed live by sending different Origin headers and comparing responses) --
# escouthunt.com/escout.pplx.app can never be on that allow-list, so the browser permanently
# blocks this tile as a CORS failure regardless of whether the USACE server itself is up. A
# server-to-server request from this backend isn't subject to browser CORS at all, so simply
# proxying it here fixes the layer with no change to USACE's own access policy required.
#
# Fill opacity -- IMPORTANT CAVEAT (2026-09-15, follow-up): this REMIS "Site" layer is the
# Corps' full PROJECT ACQUISITION boundary, not a "land open to the public" boundary. It
# legitimately includes privately-titled flowage-easement land (the Corps holds flood-control
# rights but the landowner keeps title and keeps farming it -- verified with the Corps' own
# district page: https://www.swf-wc.usace.army.mil/lakeopines/Realestate/Adjland.shtml) plus
# other closed areas (developed recreation sites, waterfowl refuge in season). Cross-checked at
# Mark Twain Lake: this polygon computes to ~65,251 acres, vs. the Corps' own published
# "approximately 45,000 acres of land and water are available for hunting" figure
# (https://www.mvs.usace.army.mil/Missions/Recreation/Mark-Twain-Lake/Recreation/Hunting/) --
# roughly 20,000 acres too generous. Confirmed no available government layer can cleanly
# subtract the difference: REMIS layer 4 ("Land Parcel Area") has an RPINTEREST field that
# would carry Fee vs. Flowage Easement, but it's NULL for every parcel at this project; REMIS
# layer 2 ("Outgrant Area", agricultural/other leases) returns zero records here; PAD-US's own
# USACE record for this reservoir is Category="Designation" at only ~19,446 acres (essentially
# just the water surface, not the surrounding land at all). The onX-style correct fix would be
# cross-referencing county tax-assessor parcel ownership (exclude any parcel still privately
# titled) -- that needs a paid parcel-data provider and is intentionally NOT done here; user
# chose a cheap interim stopgap instead (2026-09-15): dial opacity back down from the prior
# "Subtle" pick (rendered 38/255, ~15%) to a fainter ~10% (rendered ~26/255) so the over-broad
# fill reads as a rough reference rather than a precise access boundary, paired with an
# in-app disclaimer on the layer toggle itself (see app.js LAYER_DEFS 'public' row). Do not
# raise this back toward "Subtle" without either sourcing parcel data to exclude private
# in-holdings, or re-confirming with the user that the trespassing-risk tradeoff is acceptable.
# IMPORTANT: this MapServer's dynamicLayers renderer attenuates the requested fill alpha by a
# consistent ~0.588x factor before rasterizing (confirmed live by probing requested alphas
# 10/38/65/100/255 -> rendered 6/22/38/59/150, a stable ratio) -- so the `color` alpha below
# must be requested pre-scaled (45 -> renders ~26/255) to hit the intended ~10% on screen. Do
# not "fix" this to a naive 26 -- that would silently render at ~15 (~6%) instead. Outline
# unchanged.
USACE_CWLDM_TILE_SERVICE = "https://geospatial.sec.usace.army.mil/server/rest/services/REMIS/cwldm/MapServer/export"
USACE_CWLDM_DYNAMIC_LAYERS = json.dumps([{
    "id": 5,
    "source": {"type": "mapLayer", "mapLayerId": 5},
    "drawingInfo": {
        "renderer": {
            "type": "simple",
            "symbol": {
                "type": "esriSFS",
                "style": "esriSFSSolid",
                "color": [190, 240, 165, 57],
                "outline": {"type": "esriSLS", "style": "esriSLSSolid", "color": [140, 215, 115, 255], "width": 1.5},
            },
        },
    },
}])

NETL_FALLBACK_QUERY_URL = (
    "https://arcgis.netl.doe.gov/server/rest/services/Hosted/"
    "Protected_Areas_Database_for_the_United_States_PADUS/FeatureServer/32/query"
)
# NETL's own hosted PAD-US mirror doesn't carry a Pub_Access-equivalent field (its schema is
# limited to category/own_type/own_name/loc_own/ownermanager -- verified directly against the
# service's own metadata), so it can't replicate the primary source's Pub_Access <> 'XA' filter
# above. As a best-effort approximation using the fields it does have: own_name's own coded
# domain distinguishes named, unambiguous public categories (SFW = "State Fish and Wildlife"
# i.e. WMAs, SPR = "State Park and Recreation") from the catch-all "SLB" (State Land Board) /
# "OTHS" (Other or Unknown State Land) bucket. SLB is literally the agency type that
# administers leased state-trust land (e.g. Mississippi's 16th-Section school-trust program) in
# many states, and a live query of Mississippi's own STAT-owned records on the primary source
# confirmed this OTHS/SLB bucket mixes genuinely open land with Pub_Access='XA' (closed) leased
# parcels -- exactly the previously-filtered land reported as reappearing. Excluding own_type
# STAT records whose own_name falls in that ambiguous bucket keeps named WMAs/state parks fully
# intact while dropping the parcels most likely to be closed/leased trust land, on the rare
# tiles that ever reach this fallback path (see the retry/timeout hardening above, which should
# make that rare).
NETL_FALLBACK_WHERE = (
    "category NOT IN ('Proclamation', 'Easement') "
    "AND NOT (own_type = 'STAT' AND own_name IN ('SLB', 'OTHS', 'UNK'))"
)
# Fill opacity raised 2026-09-26 at the user's request ("the fill is too transparent, I'm unable
# to clearly determine public from private"): ~4% -> ~25% (alpha 64) for PAD-US, and the USACE
# layer below matched to the same ~25% on screen (requested 109 -> renders ~64 after the
# ~0.588x attenuation noted above). Dialed back same day to ~12% (alpha 31; USACE requested 53 -> renders
# 31, verified live) after the user found 25% too strong. User explicitly asked for the Corps fill too, superseding the
# 2026-09-15 "keep it faint" stopgap; the in-app flowage-easement disclaimer stays. Outlines are
# deliberately UNCHANGED (user: "the outline is fine").
# 2026-09-26: restyled to an onX-like natural green (user picked option "A"): ~10% fill
# (alpha 26) with a clearer 1.5px edge, replacing the neon (57,255,20) at ~12% that made
# forested public land look hazy. USACE requests fill 44 (renders ~26 after the ~0.588x
# attenuation noted above).
# 2026-09-26 (later): user picked light-green "Option A" -- a lighter onX-style green at ~30%
# on screen (alpha 83 x 0.92 raster-opacity) so public vs private is easy to tell. USACE requests
# fill 141 (renders ~83 after the ~0.588x attenuation). Outline a slightly deeper light green.
PADUS_FILL_RGBA = (190, 240, 165, 33)
PADUS_OUTLINE_RGBA = (140, 215, 115, 255)
TILE_SIZE = 256
_TRANSPARENT_TILE = None  # lazily built once, see _blank_tile()

# In-memory cache for the rasterized/proxied public-land and USACE tiles. Map tile bboxes are
# deterministic per zoom/x/y, so panning back over an already-seen tile produces the exact same
# bbox string -- an exact-match cache (no grid-snapping needed, unlike private-roads' arbitrary
# viewport bboxes) gets very high hit rates for normal pan/zoom use. This matters for memory, not
# just speed: every uncached request allocates several full 1024x1024 RGBA buffers (see
# _rasterize_netl_features) and re-queries the upstream service, so a burst of concurrent
# requests from fast panning was observed to spike the backend past its memory limit and get
# OOM-killed. Caching means repeat pans over the same area hit these dicts instead of
# re-fetching and re-rendering. "Confirmed empty/rendered" results are cached normally; total
# upstream failures are NOT cached, so a transient outage doesn't get stuck serving blank tiles
# long after the upstream recovers.
TILE_CACHE_TTL = 24 * 3600
TILE_CACHE_MAX_ENTRIES = 4000
_public_land_tile_cache: dict[str, tuple[float, bytes, str]] = {}  # bbox -> (expires_at, png_bytes, source)
_usace_tile_cache: dict[str, tuple[float, bytes, str]] = {}


def _tile_cache_get(cache: dict[str, tuple[float, bytes, str]], key: str) -> tuple[bytes, str] | None:
    entry = cache.get(key)
    if entry is None:
        return None
    expires_at, data, source = entry
    if expires_at <= time.time():
        cache.pop(key, None)
        return None
    return data, source


def _tile_cache_set(cache: dict[str, tuple[float, bytes, str]], key: str, data: bytes, source: str) -> None:
    if len(cache) >= TILE_CACHE_MAX_ENTRIES:
        now = time.time()
        for k in [k for k, v in cache.items() if v[0] <= now]:
            cache.pop(k, None)
        while len(cache) >= TILE_CACHE_MAX_ENTRIES:
            cache.pop(next(iter(cache)), None)  # evict oldest inserted
    cache[key] = (time.time() + TILE_CACHE_TTL, data, source)


def _cache_and_respond(cache: dict[str, tuple[float, bytes, str]], key: str, data: bytes, source: str) -> Response:
    """Store a confirmed (non-error) tile result in `cache` and return it as a PNG response."""
    _tile_cache_set(cache, key, data, source)
    return Response(content=data, media_type="image/png", headers={"X-Tile-Source": source})


def _blank_tile() -> bytes:
    global _TRANSPARENT_TILE
    if _TRANSPARENT_TILE is None:
        buf = io.BytesIO()
        Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0)).save(buf, format="PNG")
        _TRANSPARENT_TILE = buf.getvalue()
    return _TRANSPARENT_TILE


def _parse_bbox(bbox: str) -> tuple[float, float, float, float]:
    parts = [float(p) for p in bbox.split(",")]
    if len(parts) != 4:
        raise ValueError(f"bbox must have 4 comma-separated values, got {bbox!r}")
    xmin, ymin, xmax, ymax = parts
    return xmin, ymin, xmax, ymax


def _rasterize_netl_features(features: list[dict], bbox: tuple[float, float, float, float], out_size: int = TILE_SIZE) -> bytes:
    """Render Esri-JSON polygon features (already in the tile's EPSG:3857 bbox/size) into a
    transparent 256x256 PNG matching the primary source's fill+outline style. Supersamples at
    4x and downsamples with antialiasing, since Pillow's native polygon drawing has no
    anti-aliasing and the primary source's thin (0.75px) outline would otherwise look jagged.
    Even-odd (XOR) ring compositing per feature so donut-shaped polygons (e.g. a refuge
    boundary with private inholdings) render their holes correctly regardless of ring winding
    order, which Esri JSON doesn't reliably encode.
    """
    xmin, ymin, xmax, ymax = bbox
    # Always draw on the same 1024px canvas; a 512px (sharp-screen) tile just downsamples less.
    # Outline width is set in canvas pixels, so it keeps the same on-screen weight either way.
    scale = 4
    dim = TILE_SIZE * scale
    span_x = xmax - xmin
    span_y = ymax - ymin

    def to_px(pt: list[float]) -> tuple[float, float]:
        x, y = pt[0], pt[1]
        px = (x - xmin) / span_x * dim if span_x else 0.0
        py = (ymax - y) / span_y * dim if span_y else 0.0  # flip: map y-up vs image y-down
        return px, py

    fill_layer = Image.new("RGBA", (dim, dim), (0, 0, 0, 0))
    outline_layer = Image.new("RGBA", (dim, dim), (0, 0, 0, 0))
    outline_draw = ImageDraw.Draw(outline_layer)
    outline_width = max(1, round(1.5 * scale))

    for feat in features:
        rings = (feat.get("geometry") or {}).get("rings") or []
        if not rings:
            continue
        feature_mask = Image.new("1", (dim, dim), 0)
        for ring in rings:
            if len(ring) < 3:
                continue
            pts = [to_px(pt) for pt in ring]
            ring_mask = Image.new("1", (dim, dim), 0)
            ImageDraw.Draw(ring_mask).polygon(pts, fill=1)
            feature_mask = ImageChops.logical_xor(feature_mask, ring_mask)
            outline_draw.line(pts + [pts[0]], fill=PADUS_OUTLINE_RGBA, width=outline_width)
        fill_solid = Image.new("RGBA", (dim, dim), PADUS_FILL_RGBA)
        fill_layer = Image.composite(fill_solid, fill_layer, feature_mask)

    composited = Image.alpha_composite(fill_layer, outline_layer)
    composited = composited.resize((out_size, out_size), Image.LANCZOS)
    buf = io.BytesIO()
    composited.save(buf, format="PNG")
    return buf.getvalue()


def _tile_px(px: int | None) -> int:
    """Output tile size: 256 (default) or 512 for sharp (retina) phone screens."""
    if px is None or px == 256:
        return 256
    if px == 512:
        return 512
    raise HTTPException(status_code=400, detail="invalid px")


@app.get("/api/tiles/public-land")
async def public_land_tile(bbox: str, px: int | None = None):
    """Serves the PAD-US public-land highlight tile by querying the primary source's feature
    layer directly (geometry + attributes for the tile's bbox, filtered server-side by
    PADUS_PRIMARY_WHERE) and rasterizing the result ourselves -- NOT via the MapServer's
    /export endpoint, which cannot reliably apply this filter at all (see the long comment on
    PADUS_PRIMARY_WHERE above for why). Falls back to querying+rasterizing the DOE NETL mirror
    only if the primary query errors or times out. Always returns a 200 PNG (falling back to a
    blank transparent tile if BOTH sources fail) so a data-source outage degrades to "no
    highlight this tile" instead of surfacing as a broken image/console error -- consistent
    with how a tile with genuinely no public land nearby already renders.
    """
    try:
        parsed_bbox = _parse_bbox(bbox)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid bbox")
    out_px = _tile_px(px)
    cache_key = bbox if out_px == 256 else f"{bbox}|512"

    cached = _tile_cache_get(_public_land_tile_cache, cache_key)
    if cached is not None:
        data, source = cached
        return Response(content=data, media_type="image/png", headers={"X-Tile-Source": f"{source}-cached"})

    xmin, ymin, xmax, ymax = parsed_bbox
    primary_query_params = {
        "geometry": f"{xmin},{ymin},{xmax},{ymax}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": 3857,
        "outSR": 3857,
        "spatialRel": "esriSpatialRelIntersects",
        "where": PADUS_PRIMARY_WHERE,
        "outFields": "Unit_Nm",
        "returnGeometry": "true",
        "geometryPrecision": 4,
        "f": "json",
    }
    # One retry on a short backoff -- the primary is normally sub-second, and a bare single
    # timeout was tripping on transient blips alone.
    for attempt in range(2):
        try:
            resp = await http_client.get(
                PADUS_PRIMARY_QUERY_URL, params=primary_query_params, timeout=httpx.Timeout(10.0)
            )
            resp.raise_for_status()
            data = resp.json()
            if "error" not in data:
                features = data.get("features") or []
                if not features:
                    return _cache_and_respond(_public_land_tile_cache, cache_key, _blank_tile(), "padus-primary-empty")
                tile_bytes = _rasterize_netl_features(features, parsed_bbox, out_px)
                return _cache_and_respond(_public_land_tile_cache, cache_key, tile_bytes, "padus-primary")
        except (httpx.TimeoutException, httpx.HTTPError, ValueError):
            pass  # retry once, then fall through to NETL fallback below
        if attempt == 0:
            await asyncio.sleep(0.4)

    query_params = {
        "geometry": f"{xmin},{ymin},{xmax},{ymax}",
        "geometryType": "esriGeometryEnvelope",
        "inSR": 3857,
        "outSR": 3857,
        "spatialRel": "esriSpatialRelIntersects",
        "where": NETL_FALLBACK_WHERE,
        "outFields": "category,own_type,own_name",
        "returnGeometry": "true",
        "geometryPrecision": 2,
        "f": "json",
    }
    try:
        resp = await http_client.get(NETL_FALLBACK_QUERY_URL, params=query_params, timeout=httpx.Timeout(8.0))
        resp.raise_for_status()
        data = resp.json()
        features = data.get("features") or []
        if not features:
            return _cache_and_respond(_public_land_tile_cache, cache_key, _blank_tile(), "none-empty")
        tile_bytes = _rasterize_netl_features(features, parsed_bbox, out_px)
        return _cache_and_respond(_public_land_tile_cache, cache_key, tile_bytes, "netl-fallback")
    except Exception:
        # Both sources failed -- degrade to a blank tile rather than a broken image or a
        # 500 that would surface as a map error to the user. Deliberately NOT cached: a
        # transient upstream outage shouldn't get stuck serving blank tiles after it recovers.
        return Response(content=_blank_tile(), media_type="image/png", headers={"X-Tile-Source": "none-error"})


@app.get("/api/tiles/usace-land")
async def usace_land_tile(bbox: str, px: int | None = None):
    """Proxies the USACE REMIS (Civil Works Land Data Migration) layer-5 tile. This is a
    straight passthrough, not a fallback like public_land_tile above -- there's only one
    upstream source here, and it isn't down, it's a browser CORS restriction: USACE only
    sends Access-Control-Allow-Origin for requests whose Origin is itself a *.usace.army.mil
    domain, which this app's origin can never be. A server-to-server request from this
    backend has no Origin-based restriction, so proxying it here is the whole fix. Always
    returns a 200 PNG -- a blank transparent tile on any upstream failure -- for the same
    reason as public_land_tile: an outage should look like "no boundary here", not a broken
    tile or console error.
    """
    try:
        _parse_bbox(bbox)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid bbox")
    out_px = _tile_px(px)
    cache_key = bbox if out_px == 256 else f"{bbox}|512"

    cached = _tile_cache_get(_usace_tile_cache, cache_key)
    if cached is not None:
        data, source = cached
        return Response(content=data, media_type="image/png", headers={"X-Tile-Source": f"{source}-cached"})

    params = {
        "bbox": bbox,
        "bboxSR": 3857,
        "imageSR": 3857,
        "size": f"{out_px},{out_px}",
        # Keep line weights the same on screen at 512px (ArcGIS draws symbols per-DPI).
        "dpi": 96 * out_px // 256,
        "format": "png32",
        "transparent": "true",
        "layers": "show:5",
        "dynamicLayers": USACE_CWLDM_DYNAMIC_LAYERS,
        "f": "image",
    }
    try:
        resp = await http_client.get(USACE_CWLDM_TILE_SERVICE, params=params, timeout=httpx.Timeout(8.0))
        content_type = resp.headers.get("content-type", "")
        if resp.status_code == 200 and content_type.startswith("image/"):
            _tile_cache_set(_usace_tile_cache, cache_key, resp.content, "usace-direct")
            return Response(content=resp.content, media_type=content_type, headers={"X-Tile-Source": "usace-direct"})
    except (httpx.TimeoutException, httpx.HTTPError):
        pass
    # Not cached -- a transient upstream failure shouldn't get stuck serving blank tiles.
    return Response(content=_blank_tile(), media_type="image/png", headers={"X-Tile-Source": "none-error"})


# USGS's 3DEP elevation ImageServer renders each contour-line tile on the fly from raw
# lidar/DEM data instead of serving a pre-cached tile -- confirmed directly against the live
# service: a never-before-requested bbox took 3-15 seconds to render, vs sub-second for every
# other proxied source in this file. The in-memory dict caches above (_public_land_tile_cache,
# _usace_tile_cache) don't help here in the way they do for those fast sources: this app gets
# redeployed frequently, which wipes process memory, so a slow render would keep happening
# again for the first viewer of any area after every deploy. Instead this uses the durable
# contour_tile_cache Postgres table (via Supabase) -- once ANY user anywhere has rendered a
# given z/bbox/rule combination, every later request for it (their next visit, a different
# user, after a redeploy) is a fast DB read instead of a multi-second upstream render.
USGS_CONTOUR_SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
CONTOUR_RENDERING_RULES = {
    "fine": '{"rasterFunction": "Preset 10ft Contour Interval"}',
    "coarse": '{"rasterFunction": "Contour Smoothed 25"}',
}


# Web Mercator (EPSG:3857) world bounds, with a small margin -- used to reject NaN/Infinity
# and grossly out-of-range bbox values before they reach the upstream ArcGIS call or the
# cache-key hash, per the pre-publish security review's bbox-validation finding.
_WEB_MERCATOR_WORLD_BOUND = 20_037_508.34 * 1.05


def _validate_contour_bbox(bbox: str) -> tuple[float, float, float, float]:
    """Parses and sanity-checks a contour tile bbox, then returns a canonicalized
    (fixed-precision) version. Canonicalizing collapses formatting variants of what is
    effectively the same tile (extra decimal places, trailing zeros, etc.) into one cache
    key, so the durable cache can't be flooded with unbounded near-duplicate rows.
    """
    xmin, ymin, xmax, ymax = _parse_bbox(bbox)
    for v in (xmin, ymin, xmax, ymax):
        if not math.isfinite(v):
            raise ValueError("bbox values must be finite")
        if abs(v) > _WEB_MERCATOR_WORLD_BOUND:
            raise ValueError("bbox out of world bounds")
    if xmax <= xmin or ymax <= ymin:
        raise ValueError("bbox must have positive width and height")
    span_x, span_y = xmax - xmin, ymax - ymin
    # A single 256px tile never legitimately spans more than one world-width; this also
    # bounds how much upstream-render cost a single request can trigger.
    if span_x > 2 * _WEB_MERCATOR_WORLD_BOUND or span_y > 2 * _WEB_MERCATOR_WORLD_BOUND:
        raise ValueError("bbox span too large")
    # Centimeter precision is far finer than this layer ever needs and keeps the cache key
    # stable across floating-point formatting noise from the client.
    return (round(xmin, 2), round(ymin, 2), round(xmax, 2), round(ymax, 2))


def _contour_cache_key(z: int, bbox: tuple[float, float, float, float], rule: str) -> str:
    canon = ",".join(f"{v:.2f}" for v in bbox)
    return hashlib.sha256(f"{z}|{canon}|{rule}".encode()).hexdigest()


async def _contour_cache_get(cache_key: str) -> bytes | None:
    try:
        res = await supabase.table("contour_tile_cache").select("png_data").eq("cache_key", cache_key).limit(1).execute()
        if not res.data:
            return None
        hex_str = res.data[0]["png_data"]
        # PostgREST serializes bytea columns as Postgres hex-encoded text ("\x...").
        if not isinstance(hex_str, str):
            raise ValueError("unexpected png_data type")
        if hex_str.startswith("\\x"):
            hex_str = hex_str[2:]
        data = bytes.fromhex(hex_str)
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("cached row is not a valid PNG")
        return data
    except Exception:
        # A malformed/corrupt row (or a transient read error) should degrade to a cache miss
        # -- re-render and overwrite -- rather than 500 the request the user is waiting on.
        return None


async def _contour_cache_set(cache_key: str, data: bytes) -> None:
    try:
        await supabase.table("contour_tile_cache").upsert(
            {"cache_key": cache_key, "png_data": "\\x" + data.hex()}, on_conflict="cache_key"
        ).execute()
    except Exception:
        pass  # a cache write failure shouldn't fail the tile response the user is waiting on


@app.get("/api/tiles/contour")
async def contour_tile(request: Request, z: int, bbox: str, rule: str, px: int | None = None):
    """Proxies + permanently caches a USGS 3DEP contour-line tile render. `rule` is the
    frontend's already-computed zoom-tier choice ('fine' below CONTOUR_ZOOM_DETAIL_THRESHOLD,
    'coarse' above it) -- validated against an allow-list here rather than trusted as a raw
    ArcGIS renderingRule string, since that's user-reachable input. Recoloring/halo styling
    still happens client-side in the escout-recolor protocol handler; this endpoint only
    serves the raw (near-black line) elevation render, which is style-independent and safe to
    cache indefinitely -- the underlying elevation data doesn't change.
    """
    if rule not in CONTOUR_RENDERING_RULES:
        raise HTTPException(status_code=400, detail="invalid rule")
    if not (0 <= z <= 22):
        raise HTTPException(status_code=400, detail="invalid z")
    try:
        canon_bbox = _validate_contour_bbox(bbox)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid bbox")

    out_px = _tile_px(px)
    # 256px tiles keep their original cache keys; 512px (sharp-screen) renders get their own.
    cache_key = _contour_cache_key(z, canon_bbox, rule if out_px == 256 else f"{rule}|512")
    cached = await _contour_cache_get(cache_key)
    if cached is not None:
        return Response(
            content=cached,
            media_type="image/png",
            headers={"X-Tile-Source": "contour-cached", "Cache-Control": "public, max-age=604800, immutable"},
        )

    # Only the real upstream-render path is rate-limited -- cache hits are cheap DB reads and
    # shouldn't be throttled during normal panning. Capped lower than most other per-IP limits
    # in this file (20/min, matching the checkout/portal tier) because each miss can trigger a
    # multi-second external render plus a database write, unlike the cheap-read routes that use
    # the higher 60/min tier.
    # Raised from 20/min: zooming a phone through 3-4 levels over a never-cached area needs ~40-60
    # fresh renders in well under a minute, so 20/min was 429-ing real users and leaving holes in
    # the contour layer. 150/min still stops a runaway script from hammering USGS.
    await rate_limit(f"contour_miss:{client_ip(request)}", limit=150, window_seconds=60)

    canon_bbox_str = ",".join(f"{v:.2f}" for v in canon_bbox)
    params = {
        "bbox": canon_bbox_str,
        "bboxSR": 3857,
        "imageSR": 3857,
        "size": f"{out_px},{out_px}",
        "format": "png32",
        "transparent": "true",
        "renderingRule": CONTOUR_RENDERING_RULES[rule],
        "f": "image",
    }
    last_error = None
    for attempt in range(3):
        try:
            resp = await http_client.get(USGS_CONTOUR_SERVICE, params=params, timeout=httpx.Timeout(40.0))
            content_type = resp.headers.get("content-type", "")
            if resp.status_code == 200 and content_type.startswith("image/"):
                await _contour_cache_set(cache_key, resp.content)
                return Response(
                    content=resp.content,
                    media_type="image/png",
                    headers={"X-Tile-Source": "contour-direct", "Cache-Control": "public, max-age=604800, immutable"},
                )
            last_error = f"status {resp.status_code}"
        except (httpx.TimeoutException, httpx.HTTPError) as e:
            last_error = str(e)
        if attempt < 2:
            await asyncio.sleep(0.4 * (attempt + 1))
    # Upstream failed after retries -- degrade to a blank tile, uncached, so a transient
    # outage doesn't get stuck serving blank tiles after USGS recovers.
    return Response(
        content=_blank_tile(), media_type="image/png", headers={"X-Tile-Source": "none-error", "X-Tile-Error": last_error or "unknown"}
    )


# ---------------------------------------------------------------------------------------
# Private roads (OpenStreetMap access=private ways) -- the standard Esri road raster layer
# (see escout-roads in app.js) has NO attribute data at all, so it can never distinguish a
# private track from a public one, and Esri's dataset simply omits many private tracks and
# driveways outright (confirmed: the Cedar Grove Rd spur in Starkville, MS, OSM way 13679731,
# renders zero pixels at any zoom in the Esri layer). OSM is the only source in this app with
# real access-tag data, so this is a genuinely new data source, queried live from Overpass
# rather than pre-bundled, since OSM's private-road tagging is edited constantly and a stale
# snapshot would both miss new tags and keep showing roads whose access has since changed.
#
# Overpass has a real fair-use/rate-limit policy, and this app has no control over how many
# concurrent visitors pan the map at once -- so unlike the PAD-US/USACE tile endpoints above
# (which re-query their source on every single request), this endpoint snaps every request to
# a coarse ~0.05-degree grid cell and caches the resulting GeoJSON in memory for several hours.
# That means many different visitors panning around the same county, or one visitor panning
# back and forth, mostly hit the in-process cache instead of Overpass. The cache is plain
# in-memory (not Supabase) on purpose: it's a load-shedding measure, not data of record, so
# losing it on every redeploy is fine -- it just lazily rebuilds.
# ---------------------------------------------------------------------------------------
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
PRIVATE_ROADS_CACHE_TTL = 6 * 3600
PRIVATE_ROADS_CACHE_MAX_ENTRIES = 500
PRIVATE_ROADS_GRID_DEG = 0.05  # ~5.5km at this latitude -- coarse enough for real cache reuse
PRIVATE_ROADS_MAX_SPAN_DEG = 1.0  # refuse absurdly large bbox requests (whole-state, etc.)
_private_roads_cache: dict[str, tuple[float, dict]] = {}  # cell key -> (expires_at, geojson)


def _snap_bbox_to_grid(west: float, south: float, east: float, north: float) -> str:
    g = PRIVATE_ROADS_GRID_DEG
    w = math.floor(west / g) * g
    s = math.floor(south / g) * g
    e = math.ceil(east / g) * g
    n = math.ceil(north / g) * g
    return f"{w:.4f},{s:.4f},{e:.4f},{n:.4f}"


@app.get("/api/private-roads")
async def private_roads(bbox: str):
    """Returns a GeoJSON FeatureCollection of OSM ways tagged access=private within (a grid
    cell covering) the requested lon/lat bbox `west,south,east,north`. Always returns 200 with
    a (possibly empty, possibly stale-cached) FeatureCollection -- an Overpass outage should
    degrade to "no private roads shown this pan", never a broken map or console error, same
    philosophy as the PAD-US/USACE tile endpoints above.

    NOTE (paused): public Overpass instances consistently refuse/timeout requests from this
    host's IP range (verified against overpass-api.de, overpass.kumi.systems, and
    overpass.private.coffee), so this always degrades to an empty FeatureCollection today. Left
    deployed but unused by the frontend -- the "Private Roads & Driveways" layer toggle is
    hidden from LAYER_DEFS in app.js until a reliable data path (paid Overpass tier, or a
    pre-fetched static extract) is in place.
    """
    try:
        west, south, east, north = _parse_bbox(bbox)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid bbox")
    if (east - west) > PRIVATE_ROADS_MAX_SPAN_DEG or (north - south) > PRIVATE_ROADS_MAX_SPAN_DEG:
        raise HTTPException(status_code=400, detail="bbox too large")

    cell_key = _snap_bbox_to_grid(west, south, east, north)
    now = time.time()
    cached = _private_roads_cache.get(cell_key)
    if cached and cached[0] > now:
        return JSONResponse(cached[1])

    w2, s2, e2, n2 = (float(v) for v in cell_key.split(","))
    query = f'[out:json][timeout:15];way["access"="private"]["highway"]({s2},{w2},{n2},{e2});out geom;'
    data = None
    last_exc = None
    for mirror_url in OVERPASS_URLS:
        try:
            resp = await http_client.post(
                mirror_url,
                data={"data": query},
                timeout=httpx.Timeout(15.0),
                headers={
                    "User-Agent": "EScoutHuntingApp/1.0 (https://escouthunt.com; contact via app)",
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
            )
            resp.raise_for_status()
            data = resp.json()
            break
        except Exception as exc:
            last_exc = exc
            continue
    if data is None:
        # Every mirror failed (currently always the case -- see NOTE above). Serve a stale
        # cache entry over a hard failure if we have one; otherwise degrade to empty rather
        # than a 500 that would surface as a map error.
        if cached:
            return JSONResponse(cached[1])
        return JSONResponse({"type": "FeatureCollection", "features": []})

    features = []
    for el in data.get("elements", []):
        if el.get("type") != "way":
            continue
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        coords = [[pt["lon"], pt["lat"]] for pt in geom if pt]
        if len(coords) < 2:
            continue
        tags = el.get("tags", {})
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"name": tags.get("name") or "Private Road", "highway": tags.get("highway", "")},
        })
    geojson = {"type": "FeatureCollection", "features": features}

    if len(_private_roads_cache) >= PRIVATE_ROADS_CACHE_MAX_ENTRIES:
        oldest_key = min(_private_roads_cache, key=lambda k: _private_roads_cache[k][0])
        _private_roads_cache.pop(oldest_key, None)
    _private_roads_cache[cell_key] = (now + PRIVATE_ROADS_CACHE_TTL, geojson)
    return JSONResponse(geojson)



# ---------------------------------------------------------------------------------------
# Crop Fields layer (Premium) -- USDA NASS Cropland Data Layer (CDL).
#
# Colors only agricultural fields, shaded by what was actually planted that year (corn, soy,
# cotton, wheat, ...), the way onX's crop layer reads. Everything that isn't a crop (forest,
# water, towns, pasture/grassland, wetlands) is left fully transparent so the imagery shows
# through untouched.
#
# Data path: CropScape's WCS returns the RAW class codes (one byte per pixel) as an
# uncompressed GeoTIFF, and it accepts an EPSG:3857 bbox directly even though it doesn't
# advertise it -- verified that the returned GeoTIFF origin and pixel size match the requested
# web-mercator tile exactly, so no reprojection is needed on our side. Working from codes
# (rather than the WMS's pre-colored PNG) lets us use our own palette and outline field edges.
#
# Premium is enforced HERE, not just by hiding the toggle client-side: tile and point requests
# must carry a `vid` whose subscription is active. The subscription check is cached per visitor
# for a few minutes because get_subscription() re-verifies against Stripe on every call, and a
# single pan can request a dozen tiles at once.
#
# Rendered tiles are cached twice: an in-process dict for hot tiles, and permanently in the
# existing contour_tile_cache table (namespaced key, so no new table/grant is needed). A CDL
# year never changes after release, so a rendered tile is valid indefinitely; bump
# CROP_TILE_STYLE_VERSION if the palette changes.
# ---------------------------------------------------------------------------------------
CDL_WCS_URL = "https://nassgeodata.gmu.edu/CropScapeService/wms_cdlall.cgi"
CDL_YEARS = (2025, 2024, 2023)  # 2025 is the latest national CDL (released 2026-02-27)
CROP_TILE_STYLE_VERSION = "v1"
CROP_MIN_Z = 10
CROP_MAX_Z = 16
CROP_FILL_ALPHA = 165
CROP_EDGE_ALPHA = 235

# group id -> (RGB, CDL codes). Double-crop classes are colored by their summer crop, since that's
# what's standing in the field during most of hunting season.
CROP_GROUPS: dict[str, tuple[tuple[int, int, int], tuple[int, ...]]] = {
    "corn": ((242, 193, 46), (1, 12, 13, 225, 226, 228, 237, 241)),
    "soybeans": ((88, 178, 72), (5, 26, 240, 254)),
    "cotton": ((222, 96, 160), (2, 232, 238, 239)),
    "rice": ((52, 170, 196), (3,)),
    "sorghum": ((230, 126, 46), (4, 234, 235, 236)),
    "wheat": ((196, 150, 92), (22, 23, 24)),
    "small_grains": ((226, 204, 150), (21, 25, 27, 28, 29, 30, 39, 205)),
    "peanuts": ((166, 110, 70), (10,)),
    "hay": ((170, 214, 110), (36, 37, 58, 59, 60, 224)),
    "fallow": ((176, 166, 146), (61,)),
    "orchards": ((120, 86, 180), tuple(range(66, 78)) + (204, 210, 211, 212, 215, 217, 218, 220, 223, 242, 250)),
}
# Every other agricultural CDL class (vegetables, oilseeds, sugar crops, tobacco, herbs, ...)
# falls into one "other crops" shade. 62-65 and 81-195 are non-agricultural (pasture/grassland,
# forest, shrub, barren, water, developed, wetlands) and stay transparent.
CROP_OTHER_RGB = (205, 92, 92)
_CROP_AG_CODES = set(range(1, 62)) | set(range(66, 78)) | set(range(204, 255))


def _build_crop_lut() -> list[tuple[int, int, int, int]]:
    lut = [(0, 0, 0, 0)] * 256
    for code in _CROP_AG_CODES:
        lut[code] = (*CROP_OTHER_RGB, CROP_FILL_ALPHA)
    for rgb, codes in CROP_GROUPS.values():
        for code in codes:
            lut[code] = (*rgb, CROP_FILL_ALPHA)
    return lut


_CROP_LUT = _build_crop_lut()
_crop_tile_cache: dict[str, tuple[float, bytes, str]] = {}
_crop_render_sem = asyncio.Semaphore(3)  # same ceiling as the other upstream renders on 512 MB
_premium_cache: dict[str, tuple[float, bool]] = {}
_crop_point_cache: dict[str, tuple[float, dict]] = {}


async def _is_premium_cached(request: Request) -> bool:
    vid = request.state.vid
    hit = _premium_cache.get(vid)
    now = time.time()
    if hit and hit[0] > now:
        return hit[1]
    try:
        sub = await get_subscription(request)
        ok = sub.get("tier", "free") != "free"
    except Exception:
        return False  # don't cache a failed lookup either way
    if len(_premium_cache) > 5000:
        _premium_cache.clear()
    _premium_cache[vid] = (now + (300 if ok else 30), ok)
    return ok


def _tile_bbox_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    half = 20037508.342789244  # exact web-mercator half-width (not the padded validation bound)
    size = 2 * half / (2 ** z)
    xmin = -half + x * size
    ymax = half - y * size
    return xmin, ymax - size, xmin + size, ymax


def _crop_fetch_size(z: int) -> int:
    """WCS request size for a tile. Zoomed out (z<=13) one output pixel already covers >=19 m, so
    fetch at full 256 px. Zoomed in, fetch at ~15 m/pixel (half a 30 m CDL cell) instead: the
    majority filter below can then actually remove isolated single-cell misclassifications
    (a lone cell is only 2x2 px at that scale), and the upstream request is smaller/faster."""
    span_m = 2 * 20037508.342789244 / (2 ** z)
    return max(32, min(TILE_SIZE, round(span_m / 15.0)))


def _render_crop_tile(tiff_bytes: bytes, z: int) -> bytes | None:
    """Turn a CDL class-code GeoTIFF into a transparent RGBA PNG with crop-only fills and a
    darker 1px outline wherever one field's crop meets another's (or meets non-crop land).
    Returns None when the tile contains no crop pixels at all."""
    import numpy as np

    img = Image.open(io.BytesIO(tiff_bytes))
    if img.mode != "L":
        img = img.convert("L")
    # 3x3 majority filter at fetch resolution: keeps field shapes, drops salt-and-pepper
    # single-cell noise that otherwise shows up as stray colored specks in woods and towns.
    img = img.filter(ImageFilter.ModeFilter(3))
    if img.size != (TILE_SIZE, TILE_SIZE):
        img = img.resize((TILE_SIZE, TILE_SIZE), Image.NEAREST)
    codes = np.asarray(img, dtype=np.uint8)
    lut = np.array(_CROP_LUT, dtype=np.uint8)
    rgba = lut[codes].copy()
    is_crop = rgba[:, :, 3] > 0
    if not is_crop.any():
        return None
    # Field edges: a crop pixel whose right/left/up/down neighbour has a different code.
    edge = np.zeros_like(is_crop)
    edge[:, :-1] |= codes[:, :-1] != codes[:, 1:]
    edge[:, 1:] |= codes[:, 1:] != codes[:, :-1]
    edge[:-1, :] |= codes[:-1, :] != codes[1:, :]
    edge[1:, :] |= codes[1:, :] != codes[:-1, :]
    edge &= is_crop
    if z >= 12:
        rgba[edge, :3] = (rgba[edge, :3].astype(np.uint16) * 62 // 100).astype(np.uint8)
        rgba[edge, 3] = CROP_EDGE_ALPHA
    out = Image.fromarray(rgba, "RGBA")
    buf = io.BytesIO()
    out.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


@app.get("/api/tiles/crops")
async def crop_tile(request: Request, z: int, x: int, y: int, year: int = CDL_YEARS[0]):
    """Premium-only crop-type tile (XYZ, 256px, EPSG:3857) from the USDA Cropland Data Layer."""
    if year not in CDL_YEARS:
        raise HTTPException(400, "invalid year")
    if not (CROP_MIN_Z <= z <= CROP_MAX_Z) or not (0 <= x < 2 ** z) or not (0 <= y < 2 ** z):
        raise HTTPException(400, "invalid tile")
    if not await _is_premium_cached(request):
        raise HTTPException(402, "Crop fields are a Premium feature")

    key = f"crops|{CROP_TILE_STYLE_VERSION}|{year}|{z}|{x}|{y}"
    headers = {"Cache-Control": "private, max-age=604800"}
    hot = _tile_cache_get(_crop_tile_cache, key)
    if hot is not None:
        data, source = hot
        return Response(content=data, media_type="image/png", headers={**headers, "X-Tile-Source": f"{source}-mem"})
    db_key = hashlib.sha256(key.encode()).hexdigest()
    cached = await _contour_cache_get(db_key)
    if cached is not None:
        _tile_cache_set(_crop_tile_cache, key, cached, "crops-db")
        return Response(content=cached, media_type="image/png", headers={**headers, "X-Tile-Source": "crops-db"})

    await rate_limit(f"crops_miss:{client_ip(request)}", limit=120, window_seconds=60)
    xmin, ymin, xmax, ymax = _tile_bbox_3857(z, x, y)
    params = {
        "service": "WCS",
        "version": "1.0.0",
        "request": "GetCoverage",
        "coverage": f"cdl_{year}",
        "crs": "EPSG:3857",
        "bbox": f"{xmin:.3f},{ymin:.3f},{xmax:.3f},{ymax:.3f}",
        "width": _crop_fetch_size(z),
        "height": _crop_fetch_size(z),
        "format": "GTiff",
    }
    last_error = "unknown"
    async with _crop_render_sem:
        for attempt in range(2):
            try:
                resp = await http_client.get(CDL_WCS_URL, params=params, timeout=httpx.Timeout(25.0))
                ctype = resp.headers.get("content-type", "")
                if resp.status_code == 200 and ctype.startswith("image/tiff"):
                    png = await asyncio.to_thread(_render_crop_tile, resp.content, z)
                    data = png if png is not None else _blank_tile()
                    source = "crops-direct" if png is not None else "crops-empty"
                    _tile_cache_set(_crop_tile_cache, key, data, source)
                    await _contour_cache_set(db_key, data)
                    return Response(content=data, media_type="image/png", headers={**headers, "X-Tile-Source": source})
                last_error = f"status {resp.status_code} {ctype}"
            except (httpx.TimeoutException, httpx.HTTPError) as e:
                last_error = type(e).__name__
            except Exception as e:  # corrupt TIFF etc. -- degrade, never 500 a map tile
                last_error = type(e).__name__
            if attempt == 0:
                await asyncio.sleep(0.5)
    # Upstream failed: blank, uncached, so it retries after CropScape recovers.
    return Response(content=_blank_tile(), media_type="image/png", headers={"X-Tile-Source": "none-error", "X-Tile-Error": last_error})


# Display names for the tap readout (from the 2025 CDL metadata's attribute domain; double-crop
# classes shortened to "Winter Wheat / Soybeans" style).
CDL_NAMES: dict[int, str] = {
    1: "Corn",
    2: "Cotton",
    3: "Rice",
    4: "Sorghum",
    5: "Soybeans",
    6: "Sunflower",
    10: "Peanuts",
    11: "Tobacco",
    12: "Sweet Corn",
    13: "Popcorn",
    14: "Mint",
    21: "Barley",
    22: "Durum Wheat",
    23: "Spring Wheat",
    24: "Winter Wheat",
    25: "Other Small Grains",
    26: "Winter Wheat / Soybeans",
    27: "Rye",
    28: "Oats",
    29: "Millet",
    30: "Speltz",
    31: "Canola",
    32: "Flaxseed",
    33: "Safflower",
    34: "Rapeseed",
    35: "Mustard",
    36: "Alfalfa",
    37: "Hay",
    38: "Camelina",
    39: "Buckwheat",
    41: "Sugarbeets",
    42: "Dry Beans",
    43: "Potatoes",
    44: "Other Crops",
    45: "Sugarcane",
    46: "Sweet Potatoes",
    47: "Vegetables & Fruit",
    48: "Watermelons",
    49: "Onions",
    50: "Cucumbers",
    51: "Chickpeas",
    52: "Lentils",
    53: "Peas",
    54: "Tomatoes",
    55: "Caneberries",
    56: "Hops",
    57: "Herbs",
    58: "Clover / Wildflowers",
    59: "Sod / Grass Seed",
    60: "Switchgrass",
    61: "Fallow / Idle",
    62: "Pasture / Grass",
    63: "Forest",
    64: "Shrubland",
    65: "Barren",
    66: "Cherries",
    67: "Peaches",
    68: "Apples",
    69: "Grapes",
    70: "Christmas Trees",
    71: "Other Tree Crops",
    72: "Citrus",
    74: "Pecans",
    75: "Almonds",
    76: "Walnuts",
    77: "Pears",
    92: "Aquaculture",
    111: "Open Water",
    121: "Developed",
    122: "Developed",
    123: "Developed",
    124: "Developed",
    131: "Barren",
    141: "Hardwood Forest",
    142: "Evergreen Forest",
    143: "Mixed Forest",
    152: "Shrubland",
    176: "Grassland / Pasture",
    190: "Woody Wetlands",
    195: "Herbaceous Wetlands",
    204: "Pistachios",
    205: "Triticale",
    206: "Carrots",
    207: "Asparagus",
    208: "Garlic",
    209: "Cantaloupes",
    210: "Prunes",
    211: "Olives",
    212: "Oranges",
    213: "Honeydew",
    214: "Broccoli",
    215: "Avocados",
    216: "Peppers",
    217: "Pomegranates",
    218: "Nectarines",
    219: "Greens",
    220: "Plums",
    221: "Strawberries",
    222: "Squash",
    223: "Apricots",
    224: "Vetch",
    225: "Winter Wheat / Corn",
    226: "Oats / Corn",
    227: "Lettuce",
    228: "Triticale / Corn",
    229: "Pumpkins",
    230: "Lettuce / Durum Wheat",
    231: "Lettuce / Cantaloupe",
    232: "Lettuce / Cotton",
    233: "Lettuce / Barley",
    234: "Durum Wheat / Sorghum",
    235: "Barley / Sorghum",
    236: "Winter Wheat / Sorghum",
    237: "Barley / Corn",
    238: "Winter Wheat / Cotton",
    239: "Soybeans / Cotton",
    240: "Soybeans / Oats",
    241: "Corn / Soybeans",
    242: "Blueberries",
    243: "Cabbage",
    244: "Cauliflower",
    245: "Celery",
    246: "Radishes",
    247: "Turnips",
    248: "Eggplants",
    249: "Gourds",
    250: "Cranberries",
    254: "Barley / Soybeans"
}


async def _cdl_point(year: int, lng: float, lat: float) -> dict | None:
    """Majority class in a ~3x3-cell (~90 m) window around the point, so a tap on a field edge
    or a single misclassified 30 m cell reports what the field actually is -- matching what the
    majority-filtered tile shows -- instead of a one-pixel artifact."""
    d = 0.00045
    params = {
        "service": "WCS",
        "version": "1.0.0",
        "request": "GetCoverage",
        "coverage": f"cdl_{year}",
        "crs": "EPSG:4326",
        "bbox": f"{lng - d:.6f},{lat - d:.6f},{lng + d:.6f},{lat + d:.6f}",
        "width": 3,
        "height": 3,
        "format": "GTiff",
    }
    try:
        resp = await http_client.get(CDL_WCS_URL, params=params, timeout=httpx.Timeout(12.0))
        if resp.status_code != 200 or not resp.headers.get("content-type", "").startswith("image/tiff"):
            return None
        img = Image.open(io.BytesIO(resp.content)).convert("L")
        vals = list(img.tobytes())
        center = vals[len(vals) // 2]
        counts = collections.Counter(vals)
        best = max(counts.values())
        code = center if counts[center] == best else counts.most_common(1)[0][0]
        if code == 0:
            return None
        return {"year": year, "code": code, "crop": CDL_NAMES.get(code, "Other"), "isCrop": code in _CROP_AG_CODES}
    except Exception:
        return None


@app.get("/api/crops/point")
async def crop_point(request: Request, lng: float, lat: float):
    """Premium-only crop readout for a tapped point: what was planted there in each CDL year."""
    if not (-125.0 <= lng <= -66.0 and 24.0 <= lat <= 50.0):
        return {"history": [], "covered": False}  # CDL covers the lower 48 only
    if not await _is_premium_cached(request):
        raise HTTPException(402, "Crop fields are a Premium feature")
    await rate_limit(f"crops_point:{client_ip(request)}", limit=40, window_seconds=60)
    key = f"{lng:.4f},{lat:.4f}"
    hit = _crop_point_cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    results = await asyncio.gather(*[_cdl_point(yr, lng, lat) for yr in CDL_YEARS])
    history = [r for r in results if r]
    out = {"history": history, "covered": True}
    if history:
        if len(_crop_point_cache) > 2000:
            _crop_point_cache.clear()
        _crop_point_cache[key] = (time.time() + 24 * 3600, out)
    return out


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
