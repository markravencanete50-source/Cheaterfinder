"""Bounded reads from the normal public profile UI.

Only naturally emitted page responses are consumed. No GraphQL document IDs,
copied request tokens, HTTP fallback, account rotation or login are involved.
"""
from __future__ import annotations

import asyncio
import json
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

from .browser_pool import BrowserSession, browser_pool, fingerprint
from .identity import ensure_supported_identity
from .instagram import IG_ORIGIN, _WireMeter, _export_read_storage_state, _has_authenticated_navigation
from .models import NativePublicReadRequest, TransportResponse

PROFILE_OPERATION = "PolarisProfilePageContentQuery"
POSTS_OPERATION = "PolarisProfilePostsQuery"
POSTS_PAGE_OPERATION = "PolarisProfilePostsTabContentQuery_connection"
HIGHLIGHTS_OPERATION = "PolarisProfileStoryHighlightsTrayContentQuery"
FEED_KEY = "xdt_api__v1__feed__user_timeline_graphql_connection"


class NativeReadFailure(Exception):
    def __init__(self, reason: str, status: int = 502):
        self.reason, self.status = reason, status


def instagram_page_path(url: str) -> str:
    location = urlparse(url)
    if location.scheme != 'https' or location.netloc != 'www.instagram.com':
        raise NativeReadFailure('native_navigation_origin_mismatch')
    return location.path


class PublicCapture:
    def __init__(self, username: str, user_id: str | None):
        self.username, self.user_id = username.lower(), user_id
        self.profile: dict[str, Any] | None = None
        self.posts: dict[str, dict[str, Any]] = {}
        self.feed_seen = False
        self.more = False
        self.highlights: list[dict[str, Any]] | None = None
        self.latest_story: int | None = None
        self.failure: NativeReadFailure | None = None

    def accept(self, operation: str, status: int, body: Any) -> None:
        if operation not in (PROFILE_OPERATION, POSTS_OPERATION, POSTS_PAGE_OPERATION, HIGHLIGHTS_OPERATION):
            return
        if status == 429:
            self.failure = NativeReadFailure("rate_limited", status)
            return
        if status in (401, 403):
            message = body.get('message') if isinstance(body, dict) else None
            reason = message if message in {'login_required', 'challenge_required', 'checkpoint_required', 'feedback_required'} else 'request_rejected'
            self.failure = NativeReadFailure(reason, status)
            return
        if status != 200 or not isinstance(body, dict):
            self.failure = NativeReadFailure("native_page_response_failed", status if status >= 400 else 502)
            return
        if body.get("errors") or body.get("status") == "fail":
            reason = str(body.get("message", "native_page_query_failed"))
            allowed = {"login_required", "challenge_required", "checkpoint_required", "feedback_required"}
            self.failure = NativeReadFailure(reason if reason in allowed else "native_page_query_failed", 403 if reason in allowed else 502)
            return
        data = body.get("data")
        if not isinstance(data, dict):
            self.failure = NativeReadFailure("native_page_schema_changed")
            return
        if operation == PROFILE_OPERATION:
            user = data.get("user")
            if user is None:
                self.failure = NativeReadFailure("profile_not_found", 404)
                return
            if not isinstance(user, dict) or str(user.get("username", "")).lower() != self.username:
                self.failure = NativeReadFailure("profile_identity_mismatch")
                return
            pk = str(user.get("pk") or user.get("id") or "")
            if not pk.isdigit() or self.user_id and pk != self.user_id:
                self.failure = NativeReadFailure("profile_identity_mismatch")
                return
            if type(user.get("is_private")) is not bool or any(type(user.get(k)) is not int or user[k] < 0 for k in ("follower_count", "following_count", "media_count")):
                self.failure = NativeReadFailure("native_page_schema_changed")
                return
            # Discard viewer and unrelated navigation data at the boundary.
            self.profile = {k: user[k] for k in ("pk", "id", "username", "full_name", "biography", "is_private", "is_verified", "follower_count", "following_count", "media_count", "profile_pic_url", "hd_profile_pic_url_info", "external_url", "bio_links", "friendship_status") if k in user}
            # Preserve explicit web relationship evidence in the normalized
            # profile-info shape. Missing flags must remain unknown.
            friendship = self.profile.get("friendship_status")
            relationship = dict(friendship) if isinstance(friendship, dict) else {}
            for field, normalized in (("followed_by_viewer", "following"), ("requested_by_viewer", "outgoing_request")):
                if type(user.get(field)) is bool:
                    if type(relationship.get(normalized)) is bool and relationship[normalized] != user[field]:
                        self.failure = NativeReadFailure("native_relationship_conflict")
                        return
                    relationship[normalized] = user[field]
            if relationship:
                self.profile["friendship_status"] = relationship
            self.user_id = pk
            self.latest_story = user.get("latest_reel_media") if type(user.get("latest_reel_media")) is int else None
        elif operation == HIGHLIGHTS_OPERATION:
            connection = data.get("highlights")
            if not isinstance(connection, dict) or not isinstance(connection.get("edges"), list) or connection.get("page_info", {}).get("has_next_page") is not False:
                self.failure = NativeReadFailure("native_highlights_incomplete")
                return
            highlights = []
            for edge in connection["edges"]:
                node = edge.get("node") if isinstance(edge, dict) else None
                if not isinstance(node, dict) or not str(node.get("id", "")).startswith("highlight:") or str(node.get("user", {}).get("username", "")).lower() != self.username:
                    self.failure = NativeReadFailure("highlight_owner_mismatch")
                    return
                highlights.append({k: node[k] for k in ("id", "title", "cover_media") if k in node})
            self.highlights = highlights
        else:
            connection = data.get(FEED_KEY)
            if not isinstance(connection, dict) or not isinstance(connection.get("edges"), list) or type(connection.get("page_info", {}).get("has_next_page")) is not bool:
                self.failure = NativeReadFailure("native_page_schema_changed")
                return
            for edge in connection["edges"]:
                item = edge.get("node") if isinstance(edge, dict) else None
                if not isinstance(item, dict) or not item.get("code") or not (item.get("pk") or item.get("id")):
                    self.failure = NativeReadFailure("native_post_schema_changed")
                    return
                if item.get("media_type") not in (1, 2, 8) or any(type(item.get(k)) is not int or item[k] < 0 for k in ("taken_at", "like_count", "comment_count")):
                    # Missing values must not become fabricated zero counts in
                    # the older domain parser's permissive defaults.
                    self.failure = NativeReadFailure("native_post_metrics_missing")
                    return
                owner = item.get("user") or {}
                if str(owner.get("username", "")).lower() != self.username:
                    # Collaborative posts are valid only when the requested
                    # profile is explicitly listed as a co-author.
                    authors = item.get("coauthor_producers") or []
                    if not any(str(u.get("username", "")).lower() == self.username for u in authors if isinstance(u, dict)):
                        self.failure = NativeReadFailure("post_owner_mismatch")
                        return
                self.posts[str(item.get("pk") or item["id"])] = item
            self.feed_seen = True
            self.more = connection["page_info"]["has_next_page"]

    def result(self, kind: str, limit: int) -> dict[str, Any]:
        if self.failure:
            raise self.failure
        if self.profile is None:
            raise NativeReadFailure("native_profile_response_missing")
        if kind == "profile":
            return {"status": "ok", "user": self.profile}
        if self.profile["is_private"]:
            raise NativeReadFailure("private_profile_not_supported", 403)
        if not self.feed_seen:
            raise NativeReadFailure("native_posts_response_missing")
        if len(self.posts) < limit and self.more:
            raise NativeReadFailure("native_posts_incomplete")
        if self.profile["media_count"] > 0 and not self.posts:
            raise NativeReadFailure("native_posts_empty_despite_profile")
        return {"status": "ok", "items": list(self.posts.values())[:limit], "more_available": self.more or len(self.posts) > limit, "next_max_id": None,
                "num_results": min(limit, len(self.posts)), "native_page": True}


def embedded_reels(value: Any, depth: int = 0):
    """Only story/highlight data nodes from JSON emitted by the rendered page."""
    if depth > 35:
        return
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "xdt_api__v1__feed__reels_media__connection" and isinstance(child, dict):
                if child.get("page_info", {}).get("has_next_page") is True:
                    raise NativeReadFailure("native_reels_incomplete")
                for edge in child.get("edges", []):
                    if isinstance(edge, dict) and isinstance(edge.get("node"), dict):
                        yield edge["node"]
            elif key == "xdt_api__v1__feed__reels_media" and isinstance(child, dict):
                yield from child.get("reels_media", [])
            elif isinstance(child, (dict, list)):
                yield from embedded_reels(child, depth + 1)
    elif isinstance(value, list):
        for child in value:
            yield from embedded_reels(child, depth + 1)


def validate_reel(reel: Any, expected_id: str, username: str, user_id: str) -> dict[str, Any] | None:
    if not isinstance(reel, dict) or reel.get("id") != expected_id:
        return None
    owner = reel.get("user") or {}
    if str(owner.get("username", "")).lower() != username.lower() or str(owner.get("pk") or owner.get("id")) != user_id or owner.get("is_private") is not False:
        raise NativeReadFailure("reel_owner_mismatch")
    items = reel.get("items")
    if not isinstance(items, list) or any(not isinstance(item, dict) or not item.get("id") or item.get("media_type") not in (1, 2) for item in items):
        raise NativeReadFailure("native_reel_schema_changed")
    fields = ("id", "pk", "media_type", "image_versions2", "video_versions", "taken_at", "expiring_at")
    return {"id": expected_id, "items": [{k: item[k] for k in fields if k in item} for item in items]}


async def read_reel_page(page: Any, capture: PublicCapture, reel_id: str) -> dict[str, Any]:
    path = f"/stories/highlights/{reel_id.split(':')[1]}/" if reel_id.startswith("highlight:") else f"/stories/{capture.username}/"
    document = await page.goto(f"{IG_ORIGIN}{path}", wait_until="domcontentloaded", timeout=25_000)
    if document and document.status >= 400:
        raise NativeReadFailure("native_reel_navigation_failed", document.status)
    await page.wait_for_timeout(1200)
    current = instagram_page_path(page.url)
    if current.startswith(("/accounts/login", "/challenge", "/checkpoint")):
        raise NativeReadFailure("login_required" if current.startswith("/accounts/login") else "challenge_required", 403)
    if not current.startswith(path):
        raise NativeReadFailure("native_reel_navigation_mismatch")
    # The native viewer includes the complete reel in its JSON bootstrap.
    # Do not traverse the home feed, inbox, or another account's data.
    for _ in range(8):
        scripts = page.locator('script[type="application/json"]')
        for index in range(min(await scripts.count(), 250)):
            raw = await scripts.nth(index).inner_text(timeout=1500)
            if "xdt_api__v1__feed__reels_media" not in raw or len(raw) > 5_000_000:
                continue
            try:
                value = json.loads(raw)
            except ValueError:
                continue
            for candidate in embedded_reels(value):
                result = validate_reel(candidate, reel_id, capture.username, capture.user_id or "")
                if result is not None:
                    if reel_id == capture.user_id and (capture.latest_story or 0) > 0 and not result['items']:
                        raise NativeReadFailure('native_stories_empty_despite_profile')
                    return result
        await page.wait_for_timeout(250)
    raise NativeReadFailure("native_reel_response_missing")


async def read_native_public(payload: NativePublicReadRequest) -> TransportResponse:
    from invisible_playwright.async_api import InvisiblePlaywright

    ensure_supported_identity(payload.identity)
    capture = PublicCapture(payload.target_username, payload.target_user_id)
    meter = _WireMeter()
    tasks: set[asyncio.Task] = set()
    storage = None
    allowed_operations = {PROFILE_OPERATION}
    if payload.kind == "posts":
        allowed_operations.update((POSTS_OPERATION, POSTS_PAGE_OPERATION))
    elif payload.kind == "highlights":
        allowed_operations.add(HIGHLIGHTS_OPERATION)
    proxy = payload.proxy.model_dump(exclude_none=True)
    key = fingerprint({"identity": payload.identity.model_dump(), "proxy": proxy, "purpose": "native_public"})

    async def create_session() -> BrowserSession:
        driver = InvisiblePlaywright(seed=payload.identity.browser_seed, headless=True, proxy=proxy,
                                     locale=payload.identity.locale, timezone=payload.identity.timezone)
        try:
            browser = await driver.__aenter__()
            context = await browser.new_context(storage_state=payload.storage_state)
            meter.attach(context)
            return BrowserSession(driver, browser, context, meter, key, {fingerprint(payload.storage_state)}, time.monotonic())
        except BaseException:
            try:
                await asyncio.wait_for(driver.__aexit__(None, None, None), timeout=2)
            except Exception:
                pass
            raise

    async def response_received(response: Any) -> None:
        parsed = urlparse(response.url)
        if parsed.hostname != "www.instagram.com" or parsed.path not in ("/api/graphql", "/graphql/query"):
            return
        operation = (parse_qs(response.request.post_data or "").get("fb_api_req_friendly_name") or [""])[0]
        if operation not in allowed_operations:
            return
        # Refusals remain refusals even when the provider returns HTML or an
        # empty body. A JSON parsing error must not hide rate/login state.
        if response.status == 429:
            capture.accept(operation, response.status, None)
            return
        try:
            data = await asyncio.wait_for(response.json(), timeout=5)
            capture.accept(operation, response.status, data)
        except Exception:
            if response.status in (401, 403):
                capture.accept(operation, response.status, None)
            else:
                capture.failure = NativeReadFailure("native_response_unreadable")

    def observe(response: Any) -> None:
        task = asyncio.create_task(response_received(response))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    status, body = 502, {"status": "fail", "message": "native_read_failed"}
    try:
        async with asyncio.timeout(payload.deadline_ms / 1000):
            async with browser_pool.borrow(payload.identity.bot_id, key, fingerprint(payload.storage_state), create_session, reuse=False) as (entry, _):
                page = await entry.context.new_page()
                page.on("response", observe)
                document = await page.goto(f"{IG_ORIGIN}/{payload.target_username}/", wait_until="domcontentloaded", timeout=35_000)
                if document and document.status >= 400:
                    raise NativeReadFailure("native_navigation_failed", document.status)
                # Wait for the rendered profile and its normal data requests.
                for _ in range(40):
                    if capture.failure:
                        raise capture.failure
                    if capture.profile is not None and (payload.kind in ("profile", "stories") or payload.kind == "posts" and capture.feed_seen or payload.kind == "highlights" and capture.highlights is not None):
                        break
                    path = instagram_page_path(page.url)
                    if path.startswith(("/accounts/login", "/challenge", "/checkpoint", "/accounts/suspended")):
                        raise NativeReadFailure("login_required" if path.startswith("/accounts/login") else "challenge_required", 403)
                    await page.wait_for_timeout(250)
                if instagram_page_path(page.url).rstrip("/").lower() != f"/{payload.target_username.lower()}":
                    raise NativeReadFailure("native_navigation_mismatch")
                authenticated = False
                for _ in range(20):
                    if await _has_authenticated_navigation(page):
                        authenticated = True
                        break
                    if instagram_page_path(page.url).startswith("/accounts/login"):
                        raise NativeReadFailure("login_required", 401)
                    await page.wait_for_timeout(250)
                if not authenticated:
                    # A selector/hydration failure is not evidence that the
                    # saved session expired. Never retire a bot on this alone.
                    raise NativeReadFailure("native_authentication_unverified")
                if payload.kind != "profile" and capture.profile and capture.profile["is_private"]:
                    raise NativeReadFailure("private_profile_not_supported", 403)
                # Bounded normal scrolling; no replay of GraphQL cursors through
                # a different API. Failure to reach the requested window is explicit.
                if payload.kind == "posts":
                    for _ in range(4):
                        if capture.failure or len(capture.posts) >= payload.max_items or not capture.more:
                            break
                        before = len(capture.posts)
                        # The grid's scroll container does not reliably react
                        # to End. Native wheel input also avoids CSP-blocked
                        # page evaluation or injected scrolling scripts.
                        await page.mouse.move(500, 500)
                        await page.mouse.wheel(0, 1600)
                        for _ in range(24):
                            if capture.failure or len(capture.posts) > before or not capture.more:
                                break
                            await page.wait_for_timeout(250)
                # Include responses already observed by the page before
                # deciding completeness; a late error cannot become empty success.
                if tasks:
                    await asyncio.gather(*tuple(tasks))
                if capture.failure:
                    raise capture.failure
                if capture.profile is None:
                    raise NativeReadFailure("native_profile_response_missing")
                if payload.kind == "stories":
                    if capture.latest_story == 0:
                        body = {"status": "ok", "reels_media": [{"id": capture.user_id, "items": []}]}
                    else:
                        body = {"status": "ok", "reels_media": [await read_reel_page(page, capture, capture.user_id or "")]}
                elif payload.kind == "highlights":
                    if capture.highlights is None:
                        raise NativeReadFailure("native_highlights_response_missing")
                    body = {"status": "ok", "tray": capture.highlights, "reels_media": [], "counts_known": False}
                    if payload.with_items:
                        if len(capture.highlights) > 12:
                            raise NativeReadFailure("native_highlights_window_exceeded")
                        for entry_highlight in capture.highlights:
                            reel = await read_reel_page(page, capture, entry_highlight["id"])
                            body["reels_media"].append(reel)
                            entry_highlight["media_count"] = len(reel["items"])
                        body["counts_known"] = True
                else:
                    body = capture.result(payload.kind, payload.max_items)
                storage, _ = await _export_read_storage_state(entry.context, payload.storage_state)
                status = 200
    except NativeReadFailure as exc:
        status, body = exc.status, {"status": "fail", "message": exc.reason}
    except TimeoutError:
        status, body = 504, {"status": "fail", "message": "native_read_deadline"}
    except asyncio.CancelledError:
        raise
    except Exception:
        status, body = 502, {"status": "fail", "message": "native_browser_failed"}
    finally:
        for task in tuple(tasks):
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await meter.settle(timeout_s=0.2)
    return TransportResponse(status=status, headers={}, body=json.dumps(body), storage_state=storage if status == 200 else None,
        wire_bytes_in=meter.bytes_in, wire_bytes_out=meter.bytes_out, wire_breakdown=meter.snapshot(), operation_id=payload.operation_id)
