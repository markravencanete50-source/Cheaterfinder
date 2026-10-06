"""Instagram-only automation adapters.

This module intentionally owns the libraries that determine the network and
browser identity. It returns raw response envelopes; the existing TypeScript
schema parsers can stay in place during the migration.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote, urlparse, urlunparse

from fastapi import HTTPException, status

from .identity import ensure_supported_identity, httpz_options
from .browser_pool import BrowserSession, browser_pool, canary_enabled, fingerprint
from .session_state import http_response_storage_state, instagram_cookie_domain
from .models import (
    InstagramLoginCompleteRequest,
    InstagramLoginProbeRequest,
    InstagramLoginProbeResponse,
    InstagramLoginResponse,
    InstagramLoginStartRequest,
    ProxyConfig,
    ResponseUrlClass,
    TransportRequest,
    TransportResponse,
)

IG_ORIGIN = "https://www.instagram.com"
IG_APP_ID = "936619743392459"
MAX_RESPONSE_BYTES = 10 * 1024 * 1024

# Wire accounting is advisory: it must never delay the browser response, so
# outstanding size lookups are abandoned after this budget.
_WIRE_SETTLE_TIMEOUT_S = 2.0
_WIRE_TOP_TYPES = 3
_WIRE_UNKNOWN_RESOURCE_TYPE = "other"
_WIRE_RESOURCE_TYPE_MAX_LEN = 32

# These describe the browser, its network stack, or ambient request state. The
# Express caller must never supply them: doing so is how an old Chrome pool can
# leak into a Firefox/pyhttpz session.
_IDENTITY_OWNED_HEADERS = frozenset(
    {
        "accept",
        "accept-encoding",
        "accept-language",
        "connection",
        "content-type",
        "content-length",
        "cookie",
        "host",
        "origin",
        "priority",
        "referer",
        "te",
        "user-agent",
        "x-asbd-id",
        "x-ig-app-id",
        "x-requested-with",
    }
)

# A real browser assigns these from its context/navigation. Passing them to
# ``fetch`` either has no effect or can create a contradictory request. The
# HTTP adapter needs the full set above; the browser adapter intentionally lets
# invisible-playwright's Firefox session emit these itself.
_BROWSER_OWNED_HEADERS = frozenset(
    {
        "accept",
        "accept-encoding",
        "accept-language",
        "origin",
        "priority",
        "referer",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "te",
        "user-agent",
    }
)

LOGIN_URL = f"{IG_ORIGIN}/accounts/login/"
PENDING_LOGIN_TTL_SECONDS = 5 * 60
BROWSER_LAUNCH_TIMEOUT_MS = 45_000
LOGIN_NAVIGATION_TIMEOUT_MS = 45_000
LOGIN_CLEANUP_TIMEOUT_SECONDS = 3.0
LOGIN_STATE_TIMEOUT_SECONDS = 5.0

logger = logging.getLogger(__name__)

# Request tracing is deliberately opt-in.  It is for local diagnosis only and
# retains enough detail to reproduce a transport issue without writing session
# cookies, proxy credentials, or login material to disk.
TRACE_ENV = "AUTOMATION_TRACE_REQUESTS"
TRACE_PATH_ENV = "AUTOMATION_TRACE_LOG_PATH"
TRACE_BODY_LIMIT_ENV = "AUTOMATION_TRACE_BODY_MAX_BYTES"
TRACE_FILE_LIMIT_ENV = "AUTOMATION_TRACE_FILE_MAX_BYTES"
LOGIN_DEBUG_SCREENSHOTS_ENV = "AUTOMATION_LOGIN_DEBUG_SCREENSHOTS"
LOGIN_DEBUG_SCREENSHOTS_DIR_ENV = "AUTOMATION_LOGIN_DEBUG_SCREENSHOTS_DIR"
DEFAULT_TRACE_BODY_LIMIT = 64 * 1024
MAX_TRACE_BODY_LIMIT = 512 * 1024
DEFAULT_TRACE_FILE_LIMIT = 10 * 1024 * 1024
MAX_TRACE_FILE_LIMIT = 100 * 1024 * 1024
_TRACE_SENSITIVE_HEADERS = frozenset(
    {
        "authorization",
        "cookie",
        "x-fb-lsd",
        "set-cookie",
        "proxy-authorization",
        # Meta packs opaque proxy/client-address diagnostic tokens into this
        # response header. They are useful to Meta, not to a local trace.
        "proxy-status",
        "x-csrftoken",
        "x-ig-www-claim",
        "x-mid",
    }
)
_TRACE_SENSITIVE_FIELD_RE = re.compile(
    r"(?:authorization|cookie|csrf|claim|password|secret|session|token)",
    re.IGNORECASE,
)
_trace_lock = threading.Lock()


@dataclass
class _PendingLogin:
    driver: Any
    context: Any
    page: Any
    created_at: float
    code_kind: Literal["email", "totp"]


_pending_logins: dict[str, _PendingLogin] = {}
_pending_login_lock = asyncio.Lock()


def _login_debug_screenshots_enabled() -> bool:
    return os.getenv(LOGIN_DEBUG_SCREENSHOTS_ENV, "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _login_debug_screenshots_dir() -> Path:
    configured = os.getenv(LOGIN_DEBUG_SCREENSHOTS_DIR_ENV, "").strip()
    return Path(configured) if configured else Path(__file__).parent.parent / "logs" / "login-debug"


async def _capture_login_debug_screenshot(page: Any, stage: str) -> None:
    """Save a protected, temporary local screenshot for login diagnosis only.

    This is explicitly opt-in because an account page can contain identifying
    content. The directory and file are owner-only, no file path is returned
    through the API, and failures here never affect the login flow.
    """
    if not _login_debug_screenshots_enabled():
        return
    try:
        directory = _login_debug_screenshots_dir()
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        target = directory / f"{stamp}-{stage}.png"
        # Playwright determines the screenshot encoder from the file suffix;
        # retain .png on the atomic temporary name as well.
        temp = directory / f".{stamp}-{stage}.tmp.png"
        await page.screenshot(path=str(temp), full_page=True, timeout=10_000)
        os.chmod(temp, 0o600)
        temp.replace(target)
        logger.info("instagram_login_debug_screenshot_saved stage=%s", stage)
    except Exception as exc:
        logger.warning(
            "instagram_login_debug_screenshot_failed stage=%s exception_type=%s",
            stage,
            type(exc).__name__,
        )


def _locale_header(locale: str) -> str:
    language = locale.split("-", 1)[0]
    return f"{locale},{language};q=0.5"


def _referer(value: str | None) -> str:
    if value is None:
        return f"{IG_ORIGIN}/"
    referer = instagram_url(value)
    return referer


def instagram_api_headers(payload: TransportRequest) -> dict[str, str]:
    """Build an Instagram XHR header set from the persisted Firefox identity.

    Endpoint-specific headers such as a current ``X-IG-WWW-Claim`` can be
    added by Express.  Identity headers are deliberately owned here, so callers
    cannot introduce Chrome client hints, a pooled UA, or a hand-built Cookie
    header after the browser/TLS profile has already been selected.
    """
    identity = payload.identity
    ensure_supported_identity(identity)
    extra: dict[str, str] = {}
    for name, value in payload.request.headers.items():
        normalized = name.lower()
        if (
            normalized in _IDENTITY_OWNED_HEADERS
            or normalized.startswith("sec-ch-")
            or normalized.startswith("sec-fetch-")
        ):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=f"{name} is owned by the Firefox automation identity",
            )
        extra[normalized] = value

    # Keep keys normalised so an endpoint-specific override cannot create a
    # second differently-cased copy of an identity header.
    headers = {
        "user-agent": identity.user_agent,
        "accept": "*/*",
        "accept-language": _locale_header(identity.locale),
        "accept-encoding": "gzip, deflate, br, zstd",
        "origin": IG_ORIGIN,
        "referer": _referer(payload.request.referer),
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "priority": "u=0",
        "te": "trailers",
        "x-ig-app-id": IG_APP_ID,
        "x-asbd-id": "129477",
        "x-requested-with": "XMLHttpRequest",
    }
    if payload.request.method == "POST":
        headers["content-type"] = "application/x-www-form-urlencoded;charset=UTF-8"
    headers.update(extra)
    # A previous response may have refreshed the saved jar. Never send the
    # constructor's old CSRF header alongside a newer cookie.
    csrf = cookie_values(payload.storage_state).get("csrftoken")
    if csrf:
        headers["x-csrftoken"] = csrf
    return headers


def browser_fetch_headers(payload: TransportRequest) -> dict[str, str]:
    """Return only application headers that JavaScript fetch may set safely."""
    return {
        name: value
        for name, value in instagram_api_headers(payload).items()
        if name not in _BROWSER_OWNED_HEADERS
    }


def instagram_url(path: str) -> str:
    """Resolve a request path and reject every non-Instagram destination."""
    if path.startswith("/"):
        return f"{IG_ORIGIN}{path}"
    parsed = urlparse(path)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "www.instagram.com"
        or parsed.port is not None
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="automation requests may only target https://www.instagram.com",
        )
    return path


def proxy_url(proxy: ProxyConfig | None) -> str | None:
    """Convert the structured proxy to the URI format expected by pyhttpz."""
    if proxy is None:
        return None
    parsed = urlparse(proxy.server)
    if parsed.scheme not in {"http", "https", "socks5"} or not parsed.hostname:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="proxy server must use http, https, or socks5 with a hostname",
        )
    if proxy.username is None:
        return proxy.server
    auth = quote(proxy.username, safe="")
    if proxy.password is not None:
        auth = f"{auth}:{quote(proxy.password, safe='')}"
    host = parsed.hostname
    if parsed.port is not None:
        host = f"{host}:{parsed.port}"
    return urlunparse((parsed.scheme, f"{auth}@{host}", "", "", "", ""))


def cookie_values(storage_state: dict[str, Any]) -> dict[str, str]:
    """Extract live cookie values from a Playwright storage-state payload."""
    raw_cookies = storage_state.get("cookies", [])
    if not isinstance(raw_cookies, list):
        return {}
    cookies: dict[str, str] = {}
    for raw in raw_cookies:
        if not isinstance(raw, dict):
            continue
        name = raw.get("name")
        value = raw.get("value")
        domain = str(raw.get("domain", ""))
        expires = raw.get("expires")
        if isinstance(expires, (int, float)) and expires > 0 and expires <= time.time():
            continue
        if isinstance(name, str) and isinstance(value, str) and instagram_cookie_domain(domain):
            cookies[name] = value
    return cookies


def _headers(response_headers: Any) -> dict[str, str]:
    # The httpz and browser implementations both expose iterable header pairs.
    if hasattr(response_headers, "multi_items"):
        return {str(k).lower(): str(v) for k, v in response_headers.multi_items()}
    if isinstance(response_headers, dict):
        return {str(k).lower(): str(v) for k, v in response_headers.items()}
    return {}


def _has_session(storage_state: dict[str, Any]) -> bool:
    return bool(cookie_values(storage_state).get("sessionid"))


async def _close_login_resources(context: Any | None, driver: Any) -> None:
    """Return an already-known login result even when browser teardown hangs."""
    if context is not None:
        try:
            await asyncio.wait_for(context.close(), timeout=LOGIN_CLEANUP_TIMEOUT_SECONDS)
        except Exception as exc:
            logger.warning("instagram_login_cleanup_failed resource=context exception_type=%s", type(exc).__name__)
    try:
        await asyncio.wait_for(driver.__aexit__(None, None, None), timeout=LOGIN_CLEANUP_TIMEOUT_SECONDS)
    except Exception as exc:
        logger.warning("instagram_login_cleanup_failed resource=driver exception_type=%s", type(exc).__name__)


async def _close_pending(pending: _PendingLogin) -> None:
    await _close_login_resources(pending.context, pending.driver)


async def _cleanup_expired_logins() -> None:
    now = time.monotonic()
    expired: list[_PendingLogin] = []
    async with _pending_login_lock:
        for login_id, pending in list(_pending_logins.items()):
            if now - pending.created_at > PENDING_LOGIN_TTL_SECONDS:
                expired.append(_pending_logins.pop(login_id))
    for pending in expired:
        await _close_pending(pending)


async def _visible_body(page: Any) -> str:
    try:
        return (await page.locator("body").inner_text(timeout=4_000)).lower()
    except Exception:
        return ""


async def _input_shape(page: Any) -> str:
    """Return safe form metadata for operator diagnostics (never input values)."""
    try:
        raw = await page.locator("input").evaluate_all(
            """inputs => inputs.slice(0, 8).map(input => ({
              name: input.getAttribute('name') || '',
              type: input.getAttribute('type') || '',
              autocomplete: input.getAttribute('autocomplete') || '',
              inputmode: input.getAttribute('inputmode') || '',
              maxlength: input.getAttribute('maxlength') || '',
            }))"""
        )
        if not isinstance(raw, list):
            return "inputs=unknown"
        parts = [
            "/".join(
                filter(
                    None,
                    [
                        str(item.get("name", "")),
                        str(item.get("type", "")),
                        str(item.get("autocomplete", "")),
                        str(item.get("inputmode", "")),
                        str(item.get("maxlength", "")),
                    ],
                )
            )
            for item in raw
            if isinstance(item, dict)
        ]
        return f"inputs={','.join(parts) or 'none'}"
    except Exception:
        return "inputs=unavailable"


async def _safe_login_surface(page: Any) -> str:
    """Return diagnostic form metadata without exposing page text or values."""
    try:
        path = urlparse(page.url).path or "/"
    except Exception:
        path = "unavailable"
    return f"path={path[:160]} {await _input_shape(page)}"


def _browser_failure_code(exc: Exception) -> str:
    """Classify browser failures without logging request payloads or proxy data."""
    if isinstance(exc, asyncio.TimeoutError):
        return "timeout"
    text = str(exc).lower()
    if "storage_state" in text or "storage state" in text:
        return "storage_state"
    if "new_context" in text or "new context" in text:
        return "context_creation"
    if "goto" in text or "navigate" in text or "navigation" in text:
        return "navigation"
    if "evaluate" in text or "execution context" in text:
        return "page_evaluate"
    if "proxy" in text:
        return "proxy"
    return "browser_error"


def _safe_browser_failure_detail(exc: Exception) -> str:
    """Short diagnostic text with cookie/proxy credential patterns removed."""
    detail = " ".join(str(exc).split())
    detail = re.sub(
        r"(?i)(sessionid|csrftoken|cookie|password)=([^\s,;]+)",
        r"\1=<redacted>",
        detail,
    )
    detail = re.sub(r"(https?://)[^\s/@:]+:[^\s/@]+@", r"\1<redacted>@", detail)
    return detail[:300] or type(exc).__name__


def _safe_httpz_failure_detail(exc: Exception) -> str:
    """Short httpz diagnostic with URL credentials and cookies removed.

    pyhttpz's Go bridge returns useful proxy/TLS error strings, but it may
    include the proxy URL.  Retain only a compact, scrubbed reason so ops can
    distinguish an unavailable lane from a client configuration failure.
    """
    detail = " ".join(str(exc).split())
    detail = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1<redacted>@", detail)
    detail = re.sub(
        r"(?i)(sessionid|csrftoken|cookie|password)=([^\s,;]+)",
        r"\1=<redacted>",
        detail,
    )
    return detail[:300] or type(exc).__name__


def _safe_request_path(url: str) -> str:
    """Return a log-safe Instagram endpoint path without query values."""
    try:
        path = urlparse(url).path or "/"
    except Exception:
        return "/"
    return path[:160]


def _response_url_class(url: Any) -> ResponseUrlClass:
    """Classify a final response URL without retaining any path/query values."""
    if not isinstance(url, str) or not url:
        return "unknown"
    try:
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return "unknown"
        if parsed.hostname not in {"instagram.com", "www.instagram.com"}:
            return "external"
        path = parsed.path.rstrip("/") or "/"
        if path == "/accounts/login":
            return "login"
        if path in {"/challenge", "/checkpoint"} or path.startswith(("/challenge/", "/checkpoint/")):
            return "challenge"
        if path == "/accounts/suspended":
            return "suspended"
        if path.startswith(("/api/", "/graphql/")) or path == "/graphql":
            return "instagram_api"
        return "instagram_home" if path == "/" else "instagram_other"
    except (TypeError, ValueError):
        return "unknown"


def _trace_enabled() -> bool:
    return os.getenv(TRACE_ENV, "").strip().lower() in {"1", "true", "yes"}


def _trace_body_limit() -> int:
    try:
        configured = int(os.getenv(TRACE_BODY_LIMIT_ENV, str(DEFAULT_TRACE_BODY_LIMIT)))
    except ValueError:
        configured = DEFAULT_TRACE_BODY_LIMIT
    return min(MAX_TRACE_BODY_LIMIT, max(1_024, configured))


def _trace_file_limit() -> int:
    try:
        configured = int(os.getenv(TRACE_FILE_LIMIT_ENV, str(DEFAULT_TRACE_FILE_LIMIT)))
    except ValueError:
        configured = DEFAULT_TRACE_FILE_LIMIT
    return min(MAX_TRACE_FILE_LIMIT, max(1_024 * 1_024, configured))


def _redact_trace_data(value: Any, *, key: str | None = None) -> Any:
    """Recursively remove credential-bearing fields from JSON trace data."""
    if key and _TRACE_SENSITIVE_FIELD_RE.search(key):
        return "<redacted>"
    if isinstance(value, dict):
        return {
            str(item_key): _redact_trace_data(item_value, key=str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, list):
        return [_redact_trace_data(item) for item in value]
    return value


def _redact_trace_text(value: str) -> str:
    """Strip credential-shaped data from a non-JSON trace value."""
    redacted = re.sub(r"(https?://)[^\s/@:]+:[^\s/@]+@", r"\1<redacted>@", value)
    return re.sub(
        r'(?i)(authorization|cookie|csrftoken|x-ig-www-claim|password|sessionid|token)(["\'=: ]+)([^\s,;"\'}]+)',
        r"\1\2<redacted>",
        redacted,
    )


def _trace_headers(headers: dict[str, str]) -> dict[str, str]:
    """Keep header names and non-secret values in a stable display order."""
    shown: dict[str, str] = {}
    for name, value in sorted(headers.items(), key=lambda item: item[0].lower()):
        normalized = name.lower()
        shown[name] = (
            "<redacted>"
            if (
                normalized in _TRACE_SENSITIVE_HEADERS
                or _TRACE_SENSITIVE_FIELD_RE.search(normalized)
            )
            else _redact_trace_text(str(value))
        )
    return shown


def _format_trace_body(body: str | None) -> str:
    if not body:
        return "<empty>"
    try:
        parsed = json.loads(body)
        formatted = json.dumps(
            _redact_trace_data(parsed),
            indent=2,
            ensure_ascii=False,
            sort_keys=True,
        )
    except Exception:
        formatted = _redact_trace_text(body)
    encoded = formatted.encode("utf-8")
    limit = _trace_body_limit()
    if len(encoded) > limit:
        formatted = encoded[:limit].decode("utf-8", errors="replace")
        formatted += f"\n<truncated at {limit} bytes>"
    return formatted


def _trace_path() -> Path:
    configured = os.getenv(TRACE_PATH_ENV)
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parents[1] / "logs" / "instagram-trace.log"


def _rotate_trace_file(path: Path) -> None:
    """Keep one bounded previous trace, then start a fresh local transcript."""
    try:
        if not path.exists() or path.stat().st_size < _trace_file_limit():
            return
        previous = path.with_name(f"{path.name}.1")
        previous.unlink(missing_ok=True)
        path.replace(previous)
        os.chmod(previous, 0o600)
    except Exception as exc:
        # Trace rotation must never block or fail an Instagram request.
        logger.warning(
            "instagram_transport_trace_rotate_failed exception_type=%s",
            type(exc).__name__,
        )


def _write_transport_trace(
    *,
    transport: str,
    method: str,
    url: str,
    request_headers: dict[str, str],
    request_body: str | None,
    response_status: int | None = None,
    response_headers: dict[str, str] | None = None,
    response_body: str | None = None,
    error: str | None = None,
) -> None:
    """Append one operator-readable, redacted Instagram request transcript."""
    if not _trace_enabled():
        return

    timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    lines = [
        f"[{timestamp}] transport={transport}",
        f"REQUEST {method.upper()} {_redact_trace_text(url)}",
        "Request headers:",
    ]
    lines.extend(f"  {name}: {value}" for name, value in _trace_headers(request_headers).items())
    lines.extend(("Request body:", _format_trace_body(request_body)))

    if error is not None:
        lines.extend(("RESULT error:", f"  {_redact_trace_text(error)}"))
    else:
        lines.extend((f"RESPONSE status={response_status}", "Response headers:"))
        lines.extend(
            f"  {name}: {value}"
            for name, value in _trace_headers(response_headers or {}).items()
        )
        lines.extend(("Response body:", _format_trace_body(response_body)))
    lines.extend(("=" * 96, ""))

    try:
        path = _trace_path()
        with _trace_lock:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            os.chmod(path.parent, 0o700)
            _rotate_trace_file(path)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as handle:
                os.chmod(path, 0o600)
                handle.write("\n".join(lines))
        logger.info(
            "instagram_transport_trace_written transport=%s path=%s status=%s",
            transport,
            path,
            response_status if error is None else "error",
        )
    except Exception as exc:
        # Diagnostics must never affect the request path.
        logger.warning(
            "instagram_transport_trace_write_failed exception_type=%s",
            type(exc).__name__,
        )


def _in_page_fetch_script(request: dict[str, Any]) -> str:
    """Build a document-start fetch bridge without Playwright ``evaluate``.

    The sealed Firefox engine correctly enforces Instagram's CSP, which blocks
    Playwright's normal ``page.evaluate`` implementation (it internally uses
    ``eval``).  An init script is installed by the browser before the page's
    CSP and then performs the same-origin fetch after DOMContentLoaded.  The
    result is written as an encoded attribute and read through Playwright's
    normal DOM protocol methods, which do not require eval.
    """
    payload = json.dumps(request, separators=(",", ":"))
    return f"""(() => {{
      const request = {payload};
      const marker = "data-cheaterfinder-fetch-result";
      if (window.top !== window || location.origin !== "https://www.instagram.com") return;
      const finish = (value) => {{
        const write = () => {{
          const root = document.documentElement;
          if (!root) return;
          const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(value))));
          root.setAttribute(marker, encoded);
        }};
        if (document.documentElement) write();
        else document.addEventListener("DOMContentLoaded", write, {{ once: true }});
      }};
      const run = async () => {{
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), request.timeoutMs);
        try {{
          const headers = {{...request.headers}};
          // Navigation may refresh csrftoken after the request was queued in
          // Node. Match the live cookie Firefox will attach to this fetch.
          const csrfCookie = document.cookie.split(";").map(v => v.trim())
            .find(v => v.startsWith("csrftoken="));
          if (csrfCookie) headers["x-csrftoken"] = decodeURIComponent(csrfCookie.slice(10));
          const response = await fetch(request.url, {{
            method: request.method,
            headers,
            body: request.method === "POST" ? request.body || "" : undefined,
            credentials: "include",
            cache: "no-store",
            signal: controller.signal,
          }});
          finish({{
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            body: await response.text(),
            // Internal bridge only. Python reduces this to a fixed class
            // before returning the transport response to Express.
            response_url: response.url,
            redirected: response.redirected,
          }});
        }} catch (error) {{
          finish({{
            status: 0,
            headers: {{}},
            body: "",
            error: error instanceof Error ? error.name : "browser_fetch_error",
          }});
        }} finally {{
          window.clearTimeout(timer);
        }}
      }};
      if (document.readyState === "loading") {{
        document.addEventListener("DOMContentLoaded", run, {{ once: true }});
      }} else {{
        void run();
      }}
    }})();"""


async def _fetch_with_document_bridge(
    context: Any,
    referer: str,
    request: dict[str, Any],
    timeout_ms: int,
    meter: Any = None,
    on_read: Any = None,
) -> tuple[dict[str, Any], dict[str, str] | None]:
    """Navigate, capture browser-emitted headers, then read the fetch result.

    The document bridge is needed because Instagram's CSP blocks Playwright's
    usual ``evaluate`` transport.  The context request event lets the local
    diagnostic trace see the actual Firefox request headers, including headers
    the browser itself adds, without exposing their cookie values.
    """
    target_url = str(request["url"])
    target_method = str(request["method"]).upper()
    captured_headers: asyncio.Future[dict[str, str]] = asyncio.get_running_loop().create_future()

    def on_request(browser_request: Any) -> None:
        try:
            if (
                browser_request.url != target_url
                or str(browser_request.method).upper() != target_method
                or captured_headers.done()
            ):
                return

            async def capture() -> None:
                try:
                    raw = await browser_request.all_headers()
                except Exception:
                    raw = getattr(browser_request, "headers", {})
                if isinstance(raw, dict) and not captured_headers.done():
                    captured_headers.set_result(
                        {str(name): str(value) for name, value in raw.items()}
                    )

            asyncio.create_task(capture())
        except Exception:
            # Trace capture is strictly best-effort; the browser request still
            # proceeds even if a library version lacks an event detail.
            return

    page = await context.new_page()
    # Scope the bridge and request listener to this PAGE, not the reusable
    # context. Closing the page removes both; old API requests cannot replay.
    page.on("request", on_request)
    await page.add_init_script(script=_in_page_fetch_script(request))
    try:
        result = await _read_document_bridge(page, referer, timeout_ms, captured_headers)
        if on_read is not None:
            await on_read()
        return result
    finally:
        if meter is not None:
            await meter.settle(timeout_s=0.2)
        await asyncio.wait_for(page.close(), timeout=1.0)


async def _read_document_bridge(page: Any, referer: str, timeout_ms: int, captured_headers: Any):
    await page.goto(referer, wait_until="domcontentloaded", timeout=timeout_ms)
    marker = "data-cheaterfinder-fetch-result"
    root = page.locator(f"html[{marker}]").first
    await root.wait_for(state="attached", timeout=timeout_ms)
    encoded = await page.locator("html").first.get_attribute(marker)
    if not encoded:
        raise RuntimeError("browser fetch bridge did not publish a result")
    try:
        decoded = base64.b64decode(encoded).decode("utf-8")
        result = json.loads(decoded)
    except Exception as exc:
        raise RuntimeError("browser fetch bridge returned invalid data") from exc
    if not isinstance(result, dict):
        raise RuntimeError("browser fetch bridge returned an invalid envelope")
    try:
        emitted_headers = await asyncio.wait_for(
            asyncio.shield(captured_headers), timeout=500 / 1_000
        )
    except asyncio.TimeoutError:
        emitted_headers = None
    return result, emitted_headers


async def _export_read_storage_state(context: Any, fallback: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Export while the read page is alive; never discard data for export failure.

    Some engine versions hang exporting a reused context with no open page.
    Session continuity is best effort, not a reason to repeat a completed IG read.
    The caller evicts the context if export failed and keeps the original jar.
    """
    try:
        return await asyncio.wait_for(context.storage_state(), timeout=2.0), True
    except Exception as exc:
        logger.warning("instagram_browser_state_export_failed exception_type=%s", type(exc).__name__)
        return fallback, False


async def _has_login_error_alert(page: Any) -> bool:
    """Detect IG's locale-independent inline login-error surface.

    Instagram localises the wrong-password copy, so English substring matching
    alone makes a Hindi/Arabic/etc. failure look like a hung form.  The form
    alert roles/IDs are stable across those locales and expose no sensitive
    text to the service logs.
    """
    selector = 'p[role="alert"], div[role="alert"], #slfErrorAlert, [aria-live="assertive"]'
    try:
        alerts = page.locator(selector)
        count = min(await alerts.count(), 12)
        # Instagram often keeps an earlier, hidden aria-live node mounted.
        # Checking only `.first` misses the visible invalid-login alert.
        for index in range(count):
            if await alerts.nth(index).is_visible(timeout=500):
                return True
        return False
    except Exception:
        return False


def _has_bad_credentials_copy(body: str) -> bool:
    """Recognise stable wrong-login copy across old and current IG layouts."""
    body = body.lower()
    return any(
        marker in body
        for marker in (
            "login information you entered is incorrect",
            "password was incorrect",
            "incorrect password",
        )
    )


async def _dismiss_cookie_consent(page: Any, *, timeout_ms: int = 3_000) -> None:
    """Dismiss Instagram's optional-cookie modal before interacting with login.

    The dialog can overlay the form and prevent its controls from receiving
    the submit event. Prefer declining optional cookies; this does not alter
    authentication semantics and keeps the browser state minimal.
    """
    # is_visible() returns immediately; its timeout does not wait for React
    # hydration. Wait for the exact control, whether button or role=button.
    try:
        button = page.get_by_role("button", name="Decline optional cookies", exact=True).first
        await button.wait_for(state="visible", timeout=timeout_ms)
        await button.click(timeout=5_000)
        await page.wait_for_timeout(500)
    except Exception:
        return


async def _login_page_rate_limited(page: Any) -> bool:
    """Detect a throttled login surface without returning its page contents."""
    body = await _visible_body(page)
    return any(
        marker in body
        for marker in (
            "429 too many requests",
            "too many requests",
            "please wait a few minutes",
            "rate limit",
        )
    )


async def _navigate_to_login(page: Any, timeout_ms: int) -> None:
    """Use Instagram's normal home form if its older login entry drops the connection.

    This precedes all form input. A challenge, HTTP refusal or rate limit must
    never cause another navigation or a second credential submission.
    """
    timeout = min(timeout_ms, LOGIN_NAVIGATION_TIMEOUT_MS)
    try:
        await page.goto(LOGIN_URL, wait_until="commit", timeout=timeout)
    except Exception as exc:
        if "NS_ERROR_NET_EMPTY_RESPONSE" not in str(exc):
            raise
        if _response_url_class(getattr(page, "url", "")) in {"challenge", "suspended"}:
            raise
        if await _login_page_rate_limited(page):
            raise
        logger.info("instagram_login_entry_fallback reason=empty_response")
        await page.goto(f"{IG_ORIGIN}/", wait_until="commit", timeout=timeout)


async def _click_or_submit(button: Any, fallback_input: Any) -> None:
    """Submit a login/challenge form without letting a decorative control hang it.

    Instagram periodically swaps a native ``button`` for a div role button
    while hydration is still in progress.  Its visibility query can time out
    even though the focused password/code input can submit the same form.
    Treat the explicit click as an optimisation and use Enter as the robust
    fallback rather than failing the whole login attempt at that UI detail.
    """
    try:
        if await button.is_visible(timeout=2_000):
            await button.click(timeout=5_000)
            return
    except Exception:
        pass
    await fallback_input.press("Enter")


async def _has_authenticated_navigation(page: Any) -> bool:
    """A cookie alone can also exist on the saved-account/login screen."""
    for selector in ('input[type="password"]', 'input[name="verificationCode"], input[name="security_code"]'):
        controls = page.locator(selector)
        for index in range(min(await controls.count(), 5)):
            if await controls.nth(index).is_visible(timeout=500):
                return False
    navigation = page.locator('a[href^="/direct/inbox"], a[href^="/accounts/edit"]')
    for index in range(min(await navigation.count(), 8)):
        if await navigation.nth(index).is_visible(timeout=500):
            return True
    return False


async def _login_outcome(page: Any) -> tuple[str, str | None]:
    """Classify a post-login surface without returning IG page contents.

    The classifier deliberately keeps only stable outcome names.  Raw HTML and
    account-specific page copy must not cross the local automation boundary.
    """
    body = await _visible_body(page)
    url = page.url.lower()
    if (
        "suspended" in url
        or "disabled" in url
        or "account has been suspended" in body
        or "account is disabled" in body
    ):
        return "suspended", "Instagram reported this account as suspended"
    if "captcha" in body or "recaptcha" in body or "challenge/recaptcha" in url:
        return "captcha_required", "Instagram requires an interactive CAPTCHA"
    if "please wait a few minutes" in body or "rate limit" in body:
        return "rate_limited", "Instagram throttled this login"
    if _has_bad_credentials_copy(body):
        return (
            "bad_credentials",
            "Instagram showed explicit invalid-login copy",
        )
    if (
        "code you entered is incorrect" in body
        or "code you entered isn't correct" in body
        or "invalid security code" in body
        or "invalid verification code" in body
    ):
        return "error", "Instagram rejected the verification code"
    if (
        ("text message" in body or "sms" in body)
        and ("security code" in body or "verification code" in body)
    ):
        return "error", "Instagram requires SMS verification"
    if (
        "authentication app" in body
        or "two-factor" in body
        or "two factor" in body
        or "two_factor" in url
    ):
        return "code_required:totp", None
    if (
        "security code" in body
        or "verification code" in body
        or "we sent" in body
        or "codeentry" in url
    ) and ("email" in body or "e-mail" in body):
        return "code_required:email", None
    if "/challenge/" in url or "/checkpoint/" in url:
        return "error", "Instagram checkpoint requires interactive verification"

    # A session cookie is necessary but not sufficient: Instagram also sets
    # one before redirecting a locked account to /accounts/suspended/. All
    # terminal/challenge surfaces above therefore take precedence. This order
    # prevents a suspended bot from being promoted as a healthy worker.
    storage = await asyncio.wait_for(page.context.storage_state(), timeout=LOGIN_STATE_TIMEOUT_SECONDS)
    if _has_session(storage) and await _has_authenticated_navigation(page):
        return "authenticated", None

    if await _has_login_error_alert(page):
        # Keep this distinct from explicit wrong-password copy. Instagram also
        # uses the same alert surface for generic submission/proxy failures;
        # callers need to know which signal fired without receiving page text.
        return (
            "error",
            "Instagram showed a generic visible login alert",
        )
    return "pending", None


async def _wait_for_login_outcome(page: Any, timeout_ms: int) -> tuple[str, str | None]:
    deadline = time.monotonic() + timeout_ms / 1_000
    while time.monotonic() < deadline:
        outcome, message = await _login_outcome(page)
        if outcome != "pending":
            return outcome, message
        await page.wait_for_timeout(750)
    surface = await _safe_login_surface(page)
    return "error", f"Instagram login did not reach a recognised result ({surface})"


def _login_response(
    outcome: str,
    message: str | None,
    storage_state: dict[str, Any] | None = None,
    login_id: str | None = None,
) -> InstagramLoginResponse:
    if outcome.startswith("code_required:"):
        return InstagramLoginResponse(
            status="code_required",
            login_id=login_id,
            code_kind=outcome.split(":", 1)[1],  # type: ignore[arg-type]
        )
    if outcome == "authenticated":
        return InstagramLoginResponse(status="authenticated", storage_state=storage_state)
    if outcome in {
        "bad_credentials",
        "captcha_required",
        "rate_limited",
        "suspended",
    }:
        return InstagramLoginResponse(status=outcome, message=message)
    return InstagramLoginResponse(status="error", message=message or "login failed")


async def probe_instagram_login(
    payload: InstagramLoginProbeRequest,
) -> InstagramLoginProbeResponse:
    """Render Instagram's login form without ever receiving credentials.

    Proxy selection uses this endpoint before the account login begins.  A
    candidate is accepted only when the same invisible Firefox stack can see
    both login fields; proxy failures and Instagram throttling therefore do
    not consume an account authentication attempt.
    """
    from invisible_playwright.async_api import InvisiblePlaywright

    ensure_supported_identity(payload.identity)
    invisible_proxy = payload.proxy.model_dump(exclude_none=True) if payload.proxy else None
    driver = InvisiblePlaywright(
        seed=payload.identity.browser_seed,
        headless=True,
        proxy=invisible_proxy,
        locale=payload.identity.locale,
        timezone=payload.identity.timezone,
    )
    context: Any | None = None
    page: Any | None = None
    stage = "browser_launch"
    try:
        browser = await asyncio.wait_for(
            driver.__aenter__(),
            timeout=min(payload.timeout_ms, BROWSER_LAUNCH_TIMEOUT_MS) / 1_000,
        )
        if not hasattr(browser, "new_context"):
            raise RuntimeError("automation browser did not expose new_context")
        stage = "context_creation"
        context = await browser.new_context()
        page = await context.new_page()
        stage = "login_navigation"
        try:
            await _navigate_to_login(page, payload.timeout_ms)
        except Exception:
            # Firefox raises for an HTTP error document even though its body is
            # available. Classify the known 429 surface before treating it as
            # a generic navigation failure.
            if await _login_page_rate_limited(page):
                logger.info("instagram_login_probe_completed outcome=rate_limited")
                return InstagramLoginProbeResponse(
                    status="rate_limited",
                    message="Instagram throttled this proxy before login",
                )
            raise

        await _dismiss_cookie_consent(page)
        if await _login_page_rate_limited(page):
            logger.info("instagram_login_probe_completed outcome=rate_limited")
            return InstagramLoginProbeResponse(
                status="rate_limited",
                message="Instagram throttled this proxy before login",
            )

        stage = "login_form"
        user = (
            'input[name="email"]:visible, input[name="username"]:visible, '
            'input[autocomplete~="username"]:visible'
        )
        password = (
            'input[name="pass"]:visible, input[name="password"]:visible, '
            'input[type="password"]:visible'
        )
        try:
            await page.locator(user).first.wait_for(
                state="visible",
                timeout=min(payload.timeout_ms, 30_000),
            )
            await page.locator(password).first.wait_for(
                state="visible",
                timeout=min(payload.timeout_ms, 30_000),
            )
        except Exception:
            if await _login_page_rate_limited(page):
                logger.info("instagram_login_probe_completed outcome=rate_limited")
                return InstagramLoginProbeResponse(
                    status="rate_limited",
                    message="Instagram throttled this proxy before login",
                )
            await _capture_login_debug_screenshot(page, "login-probe-blocked")
            surface = await _safe_login_surface(page)
            logger.info("instagram_login_probe_completed outcome=blocked")
            return InstagramLoginProbeResponse(
                status="blocked",
                message=f"Instagram login form was unavailable ({surface})",
            )

        logger.info("instagram_login_probe_completed outcome=ready")
        return InstagramLoginProbeResponse(status="ready")
    except HTTPException:
        raise
    except Exception as exc:
        if page is not None:
            await _capture_login_debug_screenshot(page, f"login-probe-{stage}")
        failure_code = _browser_failure_code(exc)
        failure_detail = _safe_browser_failure_detail(exc)
        logger.warning(
            "instagram_login_probe_failed stage=%s exception_type=%s failure_code=%s detail=%s",
            stage,
            type(exc).__name__,
            failure_code,
            failure_detail,
        )
        return InstagramLoginProbeResponse(
            status="error",
            message=f"login preflight failed at {stage}: {failure_code}: {failure_detail}",
        )
    finally:
        await _close_login_resources(context, driver)


async def start_instagram_login(
    payload: InstagramLoginStartRequest,
) -> InstagramLoginResponse:
    """Launch the invisible Firefox login flow and return a safe outcome.

    For code challenges the live browser remains in this loopback process for
    five minutes.  ``complete_instagram_login`` resumes that exact page after
    Express obtains the email/TOTP code through its existing integrations.
    """
    from invisible_playwright.async_api import InvisiblePlaywright

    await _cleanup_expired_logins()
    ensure_supported_identity(payload.identity)
    invisible_proxy = payload.proxy.model_dump(exclude_none=True) if payload.proxy else None
    driver = InvisiblePlaywright(
        seed=payload.identity.browser_seed,
        headless=True,
        proxy=invisible_proxy,
        locale=payload.identity.locale,
        timezone=payload.identity.timezone,
    )
    context: Any | None = None
    page: Any | None = None
    stage = "browser_launch"
    keep_pending = False
    try:
        # invisible-playwright discovers the proxy's egress IP during launch.
        # Bound that third-party preflight so an unhealthy proxy cannot occupy
        # FastAPI's worker forever before we have even reached Instagram.
        browser = await asyncio.wait_for(
            driver.__aenter__(),
            timeout=min(payload.timeout_ms, BROWSER_LAUNCH_TIMEOUT_MS) / 1_000,
        )
        # The normal non-persistent launcher returns Browser.  Treat a
        # persistent-context return as an implementation error rather than
        # silently creating a mismatched extra context.
        if not hasattr(browser, "new_context"):
            raise RuntimeError("automation browser did not expose new_context")
        stage = "context_creation"
        context = await browser.new_context()
        page = await context.new_page()
        stage = "login_navigation"
        await _navigate_to_login(page, payload.timeout_ms)
        await _dismiss_cookie_consent(page)
        stage = "login_form"
        user = (
            'input[name="email"]:visible, input[name="username"]:visible, '
            'input[autocomplete~="username"]:visible'
        )
        password = (
            'input[name="pass"]:visible, input[name="password"]:visible, '
            'input[type="password"]:visible'
        )
        await page.locator(user).first.wait_for(state="visible", timeout=min(payload.timeout_ms, 30_000))
        await page.locator(user).first.fill(payload.credentials.username)
        await page.locator(password).first.fill(payload.credentials.password)
        stage = "login_submission"
        button = page.locator('div[role="button"]:has-text("Log in")').first
        await _click_or_submit(button, page.locator(password).first)

        stage = "login_outcome"
        outcome, message = await _wait_for_login_outcome(page, payload.timeout_ms)
        if outcome == "error":
            await _capture_login_debug_screenshot(page, "unclassified-login-surface")
        logger.info(
            "instagram_login_outcome outcome=%s challenge=%s",
            outcome,
            outcome.startswith("code_required:"),
        )
        if outcome == "authenticated":
            storage_state = await asyncio.wait_for(context.storage_state(), timeout=LOGIN_STATE_TIMEOUT_SECONDS)
            return _login_response(outcome, message, storage_state)
        if outcome.startswith("code_required:"):
            await _capture_login_debug_screenshot(page, "verification-prompt")
            login_id = secrets.token_urlsafe(32)
            pending = _PendingLogin(
                driver=driver,
                context=context,
                page=page,
                created_at=time.monotonic(),
                code_kind=outcome.split(":", 1)[1],  # type: ignore[arg-type]
            )
            async with _pending_login_lock:
                _pending_logins[login_id] = pending
            keep_pending = True
            return _login_response(outcome, message, login_id=login_id)
        return _login_response(outcome, message)
    except HTTPException:
        raise
    except Exception as exc:
        if page is not None:
            await _capture_login_debug_screenshot(page, stage)
        failure_code = _browser_failure_code(exc)
        failure_detail = _safe_browser_failure_detail(exc)
        logger.warning(
            "instagram_login_failed stage=%s exception_type=%s failure_code=%s detail=%s",
            stage,
            type(exc).__name__,
            failure_code,
            failure_detail,
        )
        return InstagramLoginResponse(
            status="error",
            message=(
                f"invisible-playwright login failed at {stage}: "
                f"{failure_code}: {failure_detail}"
            ),
        )
    finally:
        if not keep_pending:
            await _close_login_resources(context, driver)


async def complete_instagram_login(
    payload: InstagramLoginCompleteRequest,
) -> InstagramLoginResponse:
    await _cleanup_expired_logins()
    async with _pending_login_lock:
        pending = _pending_logins.pop(payload.login_id, None)
    if pending is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="login challenge was not found or has expired",
        )
    keep_pending = False
    stage = "challenge_field"
    try:
        selector = ":is(" + (
            'input[name="verificationCode"], input[name="confirmationCode"], '
            'input[name="security_code"], input[name="email"], '
            'input[autocomplete="one-time-code"], input[aria-label*="code" i], '
            'input[placeholder*="code" i], input[type="text"][maxlength="6"], '
            'input[type="tel"][maxlength="6"], input[inputmode="numeric"], '
            'input[type="text"], input[type="tel"], input[type="number"]'
        ) + "):visible"
        code_input = pending.page.locator(selector).first
        try:
            await code_input.wait_for(state="visible", timeout=min(payload.timeout_ms, 30_000))
        except Exception as exc:
            shape = await _input_shape(pending.page)
            raise RuntimeError(f"challenge code field did not appear ({type(exc).__name__}; {shape}; page_closed={pending.page.is_closed()})") from exc
        stage = "challenge_fill"
        await code_input.fill(payload.code)
        stage = "challenge_submit"
        continue_button = pending.page.locator(
            'div[role="button"]:has-text("Continue"), button:has-text("Continue")'
        ).first
        try:
            await _click_or_submit(continue_button, code_input)
        except Exception:
            # Some Instagram TOTP surfaces auto-submit as soon as the sixth
            # digit is filled. In that case navigation detaches the input and
            # our Enter fallback would otherwise wait on a stale locator until
            # Playwright times out, discarding a potentially valid session.
            try:
                code_input_still_visible = await code_input.is_visible(timeout=1_000)
            except Exception:
                code_input_still_visible = False
            if code_input_still_visible:
                raise
            logger.info(
                "instagram_login_challenge_auto_submitted input_detached=true"
            )
        # Instagram keeps /challenge/ and its input mounted while the submit
        # XHR is in flight.  Looking at that surface immediately would falsely
        # report another code challenge even for a valid code.
        await pending.page.wait_for_timeout(8_000)
        stage = "challenge_outcome"
        outcome, message = await _wait_for_login_outcome(pending.page, payload.timeout_ms)
        logger.info(
            "instagram_login_challenge_outcome outcome=%s",
            outcome,
        )
        storage_state = await asyncio.wait_for(pending.context.storage_state(), timeout=LOGIN_STATE_TIMEOUT_SECONDS) if outcome == "authenticated" else None
        if outcome.startswith("code_required:"):
            # The server is still asking for a code (usually a stale email
            # code). Keep the exact browser/page alive for one caller-driven
            # fresh-code retry instead of restarting the login from scratch.
            keep_pending = True
            async with _pending_login_lock:
                _pending_logins[payload.login_id] = pending
            return _login_response(outcome, message, login_id=payload.login_id)
        return _login_response(outcome, message, storage_state)
    except HTTPException:
        raise
    except Exception as exc:
        await _capture_login_debug_screenshot(pending.page, stage)
        failure_code = _browser_failure_code(exc)
        failure_detail = _safe_browser_failure_detail(exc)
        logger.warning(
            "instagram_login_challenge_failed stage=%s exception_type=%s failure_code=%s detail=%s",
            stage,
            type(exc).__name__,
            failure_code,
            failure_detail,
        )
        return InstagramLoginResponse(
            status="error",
            message=(
                f"invisible-playwright challenge completion failed at {stage}: "
                f"{failure_code}: {failure_detail}"
            ),
        )
    finally:
        if not keep_pending:
            await _close_pending(pending)


async def request_via_httpz(payload: TransportRequest) -> TransportResponse:
    """Make one authenticated Instagram request through pyhttpz.

    `http_impersonate` is assigned once when the bot identity is created and
    must be passed unchanged on every later request for that bot session.
    """
    import httpz

    url = instagram_url(payload.request.path)
    headers = instagram_api_headers(payload)
    try:
        async with httpz.AsyncClient(
            proxy=proxy_url(payload.proxy),
            cookies=cookie_values(payload.storage_state),
            timeout=payload.request.timeout_ms / 1_000,
            **httpz_options(payload.identity),
        ) as client:
            response = await client.request(
                payload.request.method,
                url,
                headers=headers,
                content=(payload.request.body.encode("utf-8") if payload.request.body else None),
            )
    except HTTPException:
        raise
    except Exception as exc:
        _write_transport_trace(
            transport="pyhttpz",
            method=payload.request.method,
            url=url,
            request_headers=headers,
            request_body=payload.request.body,
            error=f"{type(exc).__name__}: {_safe_httpz_failure_detail(exc)}",
        )
        logger.warning(
            "instagram_http_request_failed exception_type=%s detail=%s",
            type(exc).__name__,
            _safe_httpz_failure_detail(exc),
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"pyhttpz request failed: {type(exc).__name__}",
        ) from exc

    if len(response.content) > MAX_RESPONSE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instagram response exceeded automation response limit",
        )
    logger.info(
        "instagram_http_request_completed method=%s path=%s status=%s",
        payload.request.method,
        _safe_request_path(url),
        response.status_code,
    )
    _write_transport_trace(
        transport="pyhttpz",
        method=payload.request.method,
        url=url,
        request_headers=headers,
        request_body=payload.request.body,
        response_status=response.status_code,
        response_headers=_headers(response.headers),
        response_body=response.text,
    )
    return TransportResponse(
        status=response.status_code,
        headers=_headers(response.headers),
        body=response.text,
        response_url_class=_response_url_class(getattr(response, "url", None)),
        response_redirected=(str(response.url) != url) if getattr(response, "url", None) else None,
        cookies=dict(response.cookies.items()),
        storage_state=http_response_storage_state(payload.storage_state, response, url),
    )


def _wire_size(value: Any) -> int:
    """Coerce one Playwright size field to a non-negative byte count."""
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return value if value > 0 else 0


def _wire_resource_type(browser_request: Any) -> str:
    """Return the Playwright resource type, defaulting to the ``other`` bucket."""
    try:
        resource_type = browser_request.resource_type
    except Exception:
        return _WIRE_UNKNOWN_RESOURCE_TYPE
    if not isinstance(resource_type, str) or not resource_type:
        return _WIRE_UNKNOWN_RESOURCE_TYPE
    return resource_type[:_WIRE_RESOURCE_TYPE_MAX_LEN]


def _wire_top_types(breakdown: dict[str, int], limit: int = _WIRE_TOP_TYPES) -> str:
    """Render the heaviest resource types as ``type:bytes`` for one log line."""
    ranked = sorted(breakdown.items(), key=lambda item: (-item[1], item[0]))
    return ",".join(f"{name}:{size}" for name, size in ranked[:limit])


class _WireMeter:
    """Best-effort on-the-wire byte accounting for one browser context.

    A single ``request_via_browser`` call is far more expensive than its API
    body: Firefox loads a whole instagram.com document (scripts, fonts, images)
    through a metered residential proxy before the in-page fetch runs. Playwright
    reports the encoded transfer sizes per request through ``request.sizes()``,
    so this aggregates them as requests finish.

    Accounting is strictly advisory. Every step swallows its own failures, and
    ``settle`` is bounded, so the meter can never fail or meaningfully delay the
    request it is measuring.
    """

    def __init__(self) -> None:
        self.bytes_in = 0
        self.bytes_out = 0
        self.breakdown: dict[str, int] = {}
        self.failed_requests = 0
        self._tasks: set[Any] = set()

    def attach(self, context: Any) -> None:
        """Subscribe to a Playwright context's request lifecycle events."""
        # Closures, not bound methods: Playwright's handler wrapper setattr()s a
        # marker onto a bound method's instance, which a __slots__ class (or any
        # frozen object) rejects — that silently disabled all accounting once.
        try:
            context.on(
                "requestfinished",
                lambda browser_request: self._on_request_finished(browser_request),
            )
            context.on(
                "requestfailed",
                lambda browser_request: self._on_request_failed(browser_request),
            )
        except Exception as exc:
            # Accounting is advisory; the transport itself is unaffected. Log
            # once per call so a broken subscription is visible, not silent.
            logger.warning(
                "instagram_wire_meter_attach_failed exception_type=%s detail=%s",
                type(exc).__name__,
                str(exc)[:120],
            )
            return

    def _on_request_finished(self, browser_request: Any) -> None:
        # Playwright event handlers are synchronous, but ``sizes()`` is not, so
        # the measurement is scheduled and collected later by ``settle``.
        try:
            task = asyncio.create_task(self._account(browser_request))
        except Exception:
            return
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _on_request_failed(self, _browser_request: Any) -> None:
        self.failed_requests += 1

    async def _account(self, browser_request: Any) -> None:
        try:
            sizes = await browser_request.sizes()
        except Exception:
            # A request whose response is already gone cannot be measured.
            return
        if not isinstance(sizes, dict):
            return
        # ``responseBodySize`` is the encoded (transfer) size, which is what the
        # proxy actually bills; header bytes ride the same wire.
        received = _wire_size(sizes.get("responseBodySize")) + _wire_size(
            sizes.get("responseHeadersSize")
        )
        sent = _wire_size(sizes.get("requestBodySize")) + _wire_size(
            sizes.get("requestHeadersSize")
        )
        resource_type = _wire_resource_type(browser_request)
        self.bytes_in += received
        self.bytes_out += sent
        self.breakdown[resource_type] = self.breakdown.get(resource_type, 0) + received

    async def settle(self, timeout_s: float = _WIRE_SETTLE_TIMEOUT_S) -> None:
        """Collect outstanding measurements without stalling the response."""
        pending = [task for task in tuple(self._tasks) if not task.done()]
        if not pending:
            return
        try:
            _, unfinished = await asyncio.wait(pending, timeout=timeout_s)
        except Exception:
            return
        for task in unfinished:
            # The context closes next, so an unfinished size lookup would fail
            # anyway; a partial total beats a slower response.
            task.cancel()

    def snapshot(self) -> dict[str, int]:
        """Return an immutable copy of the per-resource-type totals."""
        return dict(self.breakdown)


async def request_via_browser(payload: TransportRequest) -> TransportResponse:
    """Make one in-page fetch through an invisible-playwright Firefox session."""
    from invisible_playwright.async_api import InvisiblePlaywright

    url = instagram_url(payload.request.path)
    # Validate here as well, even though Firefox itself ultimately controls its
    # User-Agent and fetch metadata.
    headers = browser_fetch_headers(payload)
    invisible_proxy = payload.proxy.model_dump(exclude_none=True) if payload.proxy else None
    stage = "browser_launch"
    emitted_headers: dict[str, str] | None = None
    # Created before the launch so the failure path can still report whatever
    # the aborted launch had already spent on the metered proxy.
    meter = _WireMeter()
    before_in, before_out, before_types = 0, 0, {}
    reused = False
    # Filtering is proved only for the JSON liker read. A bot-level allowlist
    # must not silently alter an untested stories/login/navigation workflow.
    filter_resources = (canary_enabled("BROWSER_RESOURCE_FILTER_BOT_IDS", payload.identity.bot_id)
                        and bool(re.fullmatch(r"/api/v1/media/\d+/likers/", urlparse(url).path)))
    identity_key = fingerprint({"identity": payload.identity.model_dump(), "proxy": invisible_proxy,
                                "filter_resources": filter_resources})
    session_key = fingerprint(payload.storage_state)

    async def create_session() -> BrowserSession:
        driver = InvisiblePlaywright(
            seed=payload.identity.browser_seed, headless=True, proxy=invisible_proxy,
            locale=payload.identity.locale, timezone=payload.identity.timezone,
        )
        try:
            browser = await driver.__aenter__()
            context = await browser.new_context(storage_state=payload.storage_state)
            meter.attach(context)
            if filter_resources:
                async def resource_filter(route: Any) -> None:
                    if route.request.resource_type in {"image", "media", "font"}:
                        await route.abort()
                    else:
                        await route.continue_()
                await context.route("**/*", resource_filter)
            return BrowserSession(driver, browser, context, meter, identity_key,
                                  {session_key}, time.monotonic())
        except BaseException:
            try:
                await asyncio.wait_for(driver.__aexit__(None, None, None), timeout=2.0)
            except Exception:
                pass
            raise

    try:
        # One deadline includes admission, startup, navigation and response.
        # Node allows an additional five seconds for bounded teardown.
        async with asyncio.timeout(payload.deadline_ms / 1000):
            async with browser_pool.borrow(
                payload.identity.bot_id, identity_key, session_key, create_session,
                reuse=canary_enabled("BROWSER_REUSE_BOT_IDS", payload.identity.bot_id),
            ) as (entry, reused):
                context, meter = entry.context, entry.meter
                before_in, before_out, before_types = meter.bytes_in, meter.bytes_out, meter.snapshot()
                storage_state = payload.storage_state
                async def export_state() -> None:
                    nonlocal storage_state, stage
                    stage = "storage_state"
                    storage_state, exported = await _export_read_storage_state(context, payload.storage_state)
                    if not exported:
                        entry.calls = browser_pool.max_calls  # fresh context on next read
                stage = "document_bridge"
                result, emitted_headers = await _fetch_with_document_bridge(
                    context,
                    _referer(payload.request.referer),
                    {
                        "url": url,
                        "method": payload.request.method,
                        "headers": headers,
                        "body": payload.request.body,
                        "timeoutMs": payload.request.timeout_ms,
                    },
                    payload.request.timeout_ms,
                    meter=meter,
                    on_read=export_state,
                )
                await meter.settle()
                # Keep only the original and latest accepted session version.
                entry.session_keys = {session_key, fingerprint(storage_state)}
                body = str(result.get("body", ""))
                if result.get("error"):
                    raise RuntimeError("browser_fetch_failed")
                if len(body.encode("utf-8")) > MAX_RESPONSE_BYTES:
                    raise RuntimeError("browser_response_too_large")
                if int(result.get("status", 0)) >= 400 or not body.lstrip().startswith(("{", "[")):
                    entry.calls = browser_pool.max_calls  # never retain a walled/failed context
    except HTTPException:
        raise
    except Exception as exc:
        code = _browser_failure_code(exc)
        _write_transport_trace(
            transport="invisible-playwright",
            method=payload.request.method,
            url=url,
            request_headers=emitted_headers or headers,
            request_body=payload.request.body,
            error=f"{code}: {_safe_browser_failure_detail(exc)}",
        )
        logger.warning(
            "instagram_browser_request_failed stage=%s failure=%s exception_type=%s detail=%s"
            " wire_in=%s wire_failed=%s",
            stage,
            code,
            type(exc).__name__,
            _safe_browser_failure_detail(exc),
            meter.bytes_in,
            meter.failed_requests,
        )
        await meter.settle(timeout_s=0.1)
        return TransportResponse(
            status=0, headers={}, body="", transport_error=code,
            wire_bytes_in=max(0, meter.bytes_in - before_in),
            wire_bytes_out=max(0, meter.bytes_out - before_out),
            wire_breakdown={k: max(0, v - before_types.get(k, 0)) for k, v in meter.snapshot().items()},
            browser_reused=reused, operation_id=payload.operation_id,
        )

    bridge_error = str(result.get("error", "")) if isinstance(result, dict) else ""
    if bridge_error:
        _write_transport_trace(
            transport="invisible-playwright",
            method=payload.request.method,
            url=url,
            request_headers=emitted_headers or headers,
            request_body=payload.request.body,
            error=f"browser_fetch: {_redact_trace_text(bridge_error[:80])}",
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"invisible-playwright in-page fetch failed: {bridge_error[:80]}",
        )
    body = str(result.get("body", "")) if isinstance(result, dict) else ""
    if len(body.encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instagram response exceeded automation response limit",
        )
    logger.info(
        "instagram_browser_request_completed method=%s path=%s status=%s"
        " wire_in=%d wire_out=%d top=%s",
        payload.request.method,
        _safe_request_path(url),
        int(result.get("status", 502)) if isinstance(result, dict) else 502,
        max(0, meter.bytes_in - before_in),
        max(0, meter.bytes_out - before_out),
        _wire_top_types({k: max(0, v - before_types.get(k, 0)) for k, v in meter.snapshot().items()}),
    )
    raw_headers = result.get("headers", {}) if isinstance(result, dict) else {}
    _write_transport_trace(
        transport="invisible-playwright",
        method=payload.request.method,
        url=url,
        request_headers=emitted_headers or headers,
        request_body=payload.request.body,
        response_status=int(result.get("status", 502)) if isinstance(result, dict) else 502,
        response_headers=_headers(raw_headers),
        response_body=body,
    )
    return TransportResponse(
        status=int(result.get("status", 502)) if isinstance(result, dict) else 502,
        headers=_headers(raw_headers),
        body=body,
        response_url_class=_response_url_class(result.get("response_url")),
        response_redirected=result.get("redirected") if isinstance(result.get("redirected"), bool) else None,
        storage_state=storage_state,
        wire_bytes_in=max(0, meter.bytes_in - before_in),
        wire_bytes_out=max(0, meter.bytes_out - before_out),
        wire_breakdown={k: max(0, v - before_types.get(k, 0)) for k, v in meter.snapshot().items()},
        browser_reused=reused, operation_id=payload.operation_id,
    )
