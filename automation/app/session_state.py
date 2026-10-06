"""Keep the HTTP cookie jar compatible with saved browser storage state."""
from __future__ import annotations

import copy
import time
from email.utils import parsedate_to_datetime
from http.cookies import SimpleCookie
from typing import Any
from urllib.parse import urlparse


def instagram_cookie_domain(value: str) -> bool:
    domain = value.lower().lstrip(".")
    return domain == "instagram.com" or domain.endswith(".instagram.com")


def http_response_storage_state(original: dict[str, Any], response: Any, request_url: str) -> dict[str, Any]:
    """Apply Set-Cookie including expiry/deletion; never mutate caller state.

    pyhttpz also exposes a flat cookie map which may contain cookies received
    during redirects. It can refresh existing cookies, but cannot define the
    domain/path of a new cookie or resurrect an explicit deletion.
    """
    state = copy.deepcopy(original)
    jar = state.setdefault("cookies", [])
    headers = response.headers
    if hasattr(headers, "get_list"):
        values = headers.get_list("set-cookie")
    else:
        values = [v for k, v in headers.items() if k.lower() == "set-cookie"]
    handled: set[str] = set()
    host = urlparse(request_url).hostname or "www.instagram.com"
    now = time.time()
    for value in values:
        parsed: SimpleCookie = SimpleCookie()
        try:
            parsed.load(value)
        except Exception:
            continue
        for name, morsel in parsed.items():
            handled.add(name)
            domain = morsel["domain"] or host
            normalized = domain.lower().lstrip(".")
            if not instagram_cookie_domain(domain) or not (host == normalized or host.endswith("." + normalized)):
                continue
            path = morsel["path"] or "/"
            expires = -1.0
            try:
                if morsel["max-age"]:
                    expires = now + int(morsel["max-age"])
                elif morsel["expires"]:
                    expires = parsedate_to_datetime(morsel["expires"]).timestamp()
            except (ValueError, TypeError, OverflowError):
                continue
            # Domain cookies with/without a leading dot share the same scope.
            jar[:] = [c for c in jar if not (c.get("name") == name
                and str(c.get("domain", "")).lower().lstrip(".") == normalized
                and c.get("path", "/") == path)]
            if expires != -1 and expires <= now:
                continue
            same_site = morsel["samesite"].capitalize()
            jar.append({
                "name": name, "value": morsel.coded_value, "domain": domain,
                "path": path, "expires": expires, "secure": bool(morsel["secure"]),
                "httpOnly": bool(morsel["httponly"]),
                "sameSite": same_site if same_site in {"Strict", "Lax", "None"} else "Lax",
            })
    for name, value in response.cookies.items():
        if name in handled or not isinstance(value, str):
            continue
        for cookie in jar:
            if cookie.get("name") == name and instagram_cookie_domain(str(cookie.get("domain", ""))):
                cookie["value"] = value
    return state
