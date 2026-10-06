"""A single Firefox UI follow, confirmed by the authenticated relationship.

The API bridge here only performs GETs. The sole follow write is one exact
button click in the target's profile header. Optional-cookie consent may be
declined before navigation. A follow click timeout is ambiguous and must never
trigger a second click, an HTTP write, or an automatic retry.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from typing import Any
from urllib.parse import urlparse

from .browser_pool import BrowserSession, browser_pool, fingerprint
from .identity import ensure_supported_identity
from .instagram import (
    IG_ORIGIN,
    _WireMeter,
    _dismiss_cookie_consent,
    _export_read_storage_state,
    browser_fetch_headers,
    cookie_values,
    proxy_url,
)
from .models import InstagramFollowRequest, InstagramFollowResponse, InstagramRequest, TransportRequest

_MARKER = "data-cheaterfinder-follow-friendship"
# Anchors are intentional: Following, Requested and Unfollow can never match.
_FOLLOW_LABEL = re.compile(r"^(Follow|Follow back|Seguir|Seguir de volta|Folgen|Zurückfolgen|S’abonner|S'abonner|Suivre|Segui)$", re.IGNORECASE)


def _friendship_bridge_script(payload: InstagramFollowRequest) -> str:
    headers = browser_fetch_headers(TransportRequest(
        identity=payload.identity,
        storage_state=payload.storage_state,
        proxy=payload.proxy,
        request=InstagramRequest(path=f"/api/v1/friendships/show/{payload.target_user_id}/"),
    ))
    config = json.dumps({
        "url": f"{IG_ORIGIN}/api/v1/friendships/show/{payload.target_user_id}/",
        "path": f"/{payload.target_username}/".lower(),
        "headers": headers,
        "csrf": cookie_values(payload.storage_state).get("csrftoken", ""),
        "marker": _MARKER,
    }, separators=(",", ":"))
    return f"""(() => {{
      const config = {config};
      if (window.top !== window || location.origin !== "{IG_ORIGIN}" ||
          location.pathname.toLowerCase() !== config.path) return;
      const run = async () => {{
        let result;
        try {{
          const token = document.cookie.split(";").map(v => v.trim())
            .find(v => v.startsWith("csrftoken="));
          const csrf = token ? decodeURIComponent(token.slice(10)) : config.csrf;
          const response = await fetch(config.url, {{
            method: "GET", credentials: "include", cache: "no-store", redirect: "error",
            headers: {{...config.headers, "x-csrftoken": csrf}},
            signal: AbortSignal.timeout(15000),
          }});
          result = {{status: response.status, body: await response.text()}};
        }} catch {{ result = {{status: 0, body: ""}}; }}
        document.documentElement.setAttribute(config.marker,
          btoa(unescape(encodeURIComponent(JSON.stringify(result)))));
      }};
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", run, {{once: true}});
      else void run();
    }})();"""


def _parse_friendship(result: dict[str, Any]) -> tuple[bool, bool] | None:
    if result.get("status") != 200:
        return None
    try:
        body = json.loads(result.get("body", ""))
    except (TypeError, ValueError):
        return None
    if not isinstance(body, dict) or body.get("status", "ok") != "ok":
        return None
    following, outgoing = body.get("following"), body.get("outgoing_request")
    if type(following) is not bool or type(outgoing) is not bool:
        return None
    return following, outgoing


async def _page_block_reason(page: Any, username: str) -> str | None:
    parsed = urlparse(page.url)
    path = parsed.path.lower()
    if "/accounts/login" in path:
        return "login_required"
    if any(value in path for value in ("/challenge", "/checkpoint", "/accounts/suspended", "/accounts/disabled")):
        return "challenge_required"
    if parsed.scheme != "https" or parsed.netloc != "www.instagram.com" or path.rstrip("/") != f"/{username.lower()}":
        return "target_navigation_mismatch"
    for selector, reason in (
        ('input[type="password"]', "login_required"),
        ('input[name="verificationCode"], input[name="security_code"], iframe[src*="recaptcha"]', "challenge_required"),
    ):
        controls = page.locator(selector)
        for index in range(min(await controls.count(), 5)):
            if await controls.nth(index).is_visible():
                return reason
    return None


async def _read_friendship(page: Any, target_url: str, username: str) -> tuple[tuple[bool, bool] | None, str | None]:
    # The page's init script runs a GET on each full navigation. It contains no
    # write, so verification cannot accidentally replay the clicked action.
    await page.goto(target_url, wait_until="domcontentloaded", timeout=20_000)
    location = urlparse(getattr(page, "url", ""))
    if location.scheme == "https" and location.netloc == "www.instagram.com" and location.path.rstrip("/") == "/consent":
        # A routine cookie preference is not a failed login. Decline only the
        # optional cookies, then verify the intended profile again. One bounded
        # navigation: an unresolved consent page, login or challenge still
        # fails closed before any follow button can be located.
        await _dismiss_cookie_consent(page, timeout_ms=8_000)
        # Consent saving redirects asynchronously to the home page. Starting
        # the profile navigation before that redirect completes lets it win
        # the race and leaves us at '/'. Observe completion first.
        await page.wait_for_url(
            lambda url: (urlparse(url).scheme == "https"
                and urlparse(url).netloc == "www.instagram.com"
                and urlparse(url).path.lower().rstrip("/") in ("", f"/{username.lower()}")),
            wait_until="domcontentloaded", timeout=15_000,
        )
        await page.goto(target_url, wait_until="domcontentloaded", timeout=20_000)
    blocked = await _page_block_reason(page, username)
    if blocked:
        return None, blocked
    root = page.locator(f"html[{_MARKER}]")
    await root.wait_for(state="attached", timeout=18_000)
    encoded = await root.get_attribute(_MARKER)
    try:
        result = json.loads(base64.b64decode(encoded or "", validate=True).decode("utf-8"))
    except (TypeError, ValueError):
        return None, "friendship_unavailable"
    if not isinstance(result, dict):
        return None, "friendship_unavailable"
    status = _parse_friendship(result)
    if status is None:
        return None, "rate_limited" if result.get("status") == 429 else "friendship_unavailable"
    return status, None


async def _target_follow_button(page: Any) -> Any | None:
    header = page.locator("main header")
    try:
        await header.first.wait_for(state="visible", timeout=15_000)
    except Exception:
        return None
    if await header.count() != 1:
        return None
    buttons = header.get_by_role("button", name=_FOLLOW_LABEL)
    # Wait for hydration but never substitute a page-wide suggested-account
    # Follow button or an already-following control.
    try:
        await buttons.first.wait_for(state="visible", timeout=15_000)
    except Exception:
        return None
    visible = []
    count = await buttons.count()
    if count > 8:
        return None
    for index in range(count):
        button = buttons.nth(index)
        if await button.is_visible() and await button.is_enabled():
            visible.append(button)
    return visible[0] if len(visible) == 1 else None


def _apply_confirmed(response: InstagramFollowResponse, status: tuple[bool, bool]) -> bool:
    response.following, response.outgoing_request = status
    if not any(status):
        return False
    response.confirmed = True
    response.status = "pending" if response.outgoing_request else "accepted"
    response.reason = None
    return True


async def _follow_on_page(page: Any, payload: InstagramFollowRequest, response: InstagramFollowResponse, *, deadline_at: float | None = None) -> None:
    target_url = f"{IG_ORIGIN}/{payload.target_username}/"
    await page.add_init_script(script=_friendship_bridge_script(payload))
    before, reason = await _read_friendship(page, target_url, payload.target_username)
    if before is None:
        response.reason = reason
        return
    if _apply_confirmed(response, before):
        return
    button = await _target_follow_button(page)
    if button is None:
        response.reason = "follow_control_unavailable"
        return
    blocked = await _page_block_reason(page, payload.target_username)
    if blocked:
        response.reason = blocked
        return
    if deadline_at is not None and deadline_at - time.monotonic() < 12:
        # Leave room to observe the write. A slow startup/navigation should
        # consume a read attempt, not cause a last-second ambiguous click.
        response.reason = "insufficient_confirmation_time"
        return
    # The locator remains exact-name scoped at action time. If React changes
    # it to Requested/Following while we wait, this action times out safely.
    response.clicked = True
    response.status = "unknown"
    response.reason = "follow_not_confirmed"
    await button.click(timeout=8_000)
    await page.wait_for_timeout(1_500)
    after, reason = await _read_friendship(page, target_url, payload.target_username)
    if after is not None and _apply_confirmed(response, after):
        return
    response.reason = reason or "follow_not_confirmed"


async def follow_via_browser(payload: InstagramFollowRequest) -> InstagramFollowResponse:
    """Use the saved identity, proxy and session; never log in or retry a write."""
    from invisible_playwright.async_api import InvisiblePlaywright

    ensure_supported_identity(payload.identity)
    # Required at both the model and runtime boundaries; no direct transport.
    if payload.proxy is None or not proxy_url(payload.proxy):
        raise ValueError("follow requires a proxy")
    response = InstagramFollowResponse(status="not_sent", operation_id=payload.operation_id)
    cookies = cookie_values(payload.storage_state)
    if not cookies.get("sessionid") or not cookies.get("csrftoken"):
        response.reason = "saved_session_unavailable"
        return response
    proxy = payload.proxy.model_dump(exclude_none=True)
    identity_key = fingerprint({"identity": payload.identity.model_dump(), "proxy": proxy, "purpose": "follow"})
    session_key = fingerprint(payload.storage_state)
    meter = _WireMeter()
    deadline_at = time.monotonic() + payload.deadline_ms / 1_000

    async def create_session() -> BrowserSession:
        driver = InvisiblePlaywright(
            seed=payload.identity.browser_seed, headless=True, proxy=proxy,
            locale=payload.identity.locale, timezone=payload.identity.timezone,
        )
        try:
            browser = await driver.__aenter__()
            context = await browser.new_context(storage_state=payload.storage_state)
            meter.attach(context)
            return BrowserSession(driver, browser, context, meter, identity_key, {session_key}, time.monotonic())
        except BaseException:
            try:
                await asyncio.wait_for(driver.__aexit__(None, None, None), timeout=2.0)
            except Exception:
                pass
            raise

    try:
        async with asyncio.timeout(payload.deadline_ms / 1_000):
            async with browser_pool.borrow(payload.identity.bot_id, identity_key, session_key, create_session, reuse=False) as (entry, _):
                try:
                    page = await entry.context.new_page()
                    await _follow_on_page(page, payload, response, deadline_at=deadline_at)
                finally:
                    response.storage_state, _ = await _export_read_storage_state(entry.context, payload.storage_state)
                    await meter.settle(timeout_s=0.2)
    except asyncio.CancelledError:
        # A disconnected owner must stop the operation; never resume/retry it.
        raise
    except TimeoutError:
        if not response.confirmed:
            response.reason = "deadline_exceeded"
            response.status = "unknown" if response.clicked else "not_sent"
    except Exception:
        if not response.confirmed:
            response.reason = "browser_operation_failed"
            response.status = "unknown" if response.clicked else "not_sent"
    finally:
        response.wire_bytes_in = max(0, meter.bytes_in)
        response.wire_bytes_out = max(0, meter.bytes_out)
    return response
