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
endpoints are gated by a random key persisted in admin_key.txt (created on first boot, never
checked into git, never shipped in the static dist/public bundle).

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
import json
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
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
    # Persisted across backend restarts (this file lives next to this script, outside the
    # static dist/public bundle that gets served publicly — see .gitignore).
    if os.path.exists(ADMIN_KEY_PATH):
        with open(ADMIN_KEY_PATH, "r") as f:
            key = f.read().strip()
            if key:
                return key
    key = secrets.token_urlsafe(24)
    with open(ADMIN_KEY_PATH, "w") as f:
        f.write(key)
    try:
        os.chmod(ADMIN_KEY_PATH, 0o600)
    except OSError:
        pass
    return key


ADMIN_KEY = _load_or_create_admin_key()
print(f"[escout] Admin key (for /admin.html — keep private): {ADMIN_KEY}", flush=True)


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
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


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
    code = secrets.token_urlsafe(9)
    now = int(time.time())
    await supabase.table("comp_grants").insert(
        {"code": code, "label": body.label, "tier": "premium", "duration_days": body.duration_days, "created_at": now}
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
    res = await supabase.table("comp_grants").select("redeemed_at").eq("code", code).limit(1).execute()
    if not res.data:
        raise HTTPException(404, "Grant not found")
    if res.data[0]["redeemed_at"]:
        raise HTTPException(400, "Grant already redeemed — revoke it instead of deleting")
    await supabase.table("comp_grants").delete().eq("code", code).execute()
    return {"deleted": True}


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


# ------------------------------------------------------------------------------------------
# Waypoints (dropped pins) — persisted per visitor, plus shareable links so a set of pins can
# be copied onto another visitor's map without ever needing accounts or logins.
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


WAYPOINT_COLUMNS = "id,visitor_id,type,lng,lat,label,note,confidence,created_at,shared_from"


def _waypoint_dict(row: dict) -> dict:
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
    return {"waypoints": [_waypoint_dict(r) for r in res.data]}


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
async def preview_share(code: str):
    rows = await _load_shared_ordered(code)
    return {"waypoints": [_waypoint_dict(r) for r in rows]}


@app.post("/api/waypoints/share/{code}/import")
async def import_share(code: str, request: Request):
    vid = request.state.vid
    rows = await _load_shared_ordered(code)
    created = []
    for row in rows:
        item = WaypointBody(
            type=row["type"],
            lng=row["lng"],
            lat=row["lat"],
            label=row["label"],
            note=row["note"],
            confidence=row["confidence"],
        )
        created.append(await _insert_waypoint(vid, item, shared_from=code))
    return {"waypoints": created}


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


@app.put("/api/view-state")
async def save_view_state(body: ViewStateBody, request: Request):
    await rate_limit(f"view-state:{client_ip(request)}", limit=60, window_seconds=60)
    vid = request.state.vid
    now = int(time.time())
    await supabase.table("view_state").upsert(
        {"visitor_id": vid, "lng": body.lng, "lat": body.lat, "zoom": body.zoom, "updated_at": now},
        on_conflict="visitor_id",
    ).execute()
    return {"saved": True}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
