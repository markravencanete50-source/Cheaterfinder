"""One coherent Firefox identity for each Python automation bot.

The browser engine is the source of truth for the user agent.  We deliberately
do not keep a pool of hand-written UAs in either Express or FastAPI: a browser
seed, the sealed invisible-playwright Firefox version, and the pyhttpz TLS/H2
preset are resolved together when an identity is minted and persisted by
Express.
"""

from __future__ import annotations

import secrets

from fastapi import HTTPException, status

from .models import AutomationIdentity, CreateIdentityRequest

IDENTITY_VERSION = 1
CLIENT_NAME = "instagram-firefox-web"
PLATFORM = "Windows"


def _runtime_fingerprint() -> tuple[str, str, str, str, str]:
    """Return the sealed browser and matching pyhttpz transport data.

    invisible-playwright deliberately reports a Windows Firefox UA on every
    supported host.  pyhttpz's stock preset currently carries a macOS UA, so
    the caller must explicitly replace it with the sealed browser UA below.
    This preserves its Firefox TLS/H2 preset without claiming a different OS
    at the HTTP layer.
    """
    from httpz import resolve_impersonate
    from invisible_core.constants import FIREFOX_UPSTREAM_VERSION, USER_AGENT

    browser_version = FIREFOX_UPSTREAM_VERSION
    profile = f"firefox{browser_version.split('.', 1)[0]}"
    preset = resolve_impersonate(profile)
    if preset.get("browser") != "firefox":
        raise RuntimeError(f"{profile} is not a Firefox pyhttpz preset")

    ja3 = preset.get("ja3")
    h2_fingerprint = preset.get("h2_fingerprint")
    if not isinstance(ja3, str) or not isinstance(h2_fingerprint, str):
        raise RuntimeError(f"{profile} has no complete TLS/H2 preset")
    return browser_version, profile, USER_AGENT, ja3, h2_fingerprint


def create_identity(payload: CreateIdentityRequest) -> AutomationIdentity:
    """Mint a persistent, browser-derived identity for one bot.

    Express must save this exact object and reuse it for the bot's subsequent
    browser and HTTP calls.  Recreating it is an explicit identity rotation.
    """
    browser_version, http_profile, user_agent, ja3, h2_fingerprint = _runtime_fingerprint()
    return AutomationIdentity(
        identity_version=IDENTITY_VERSION,
        client=CLIENT_NAME,
        bot_id=payload.bot_id,
        browser_seed=secrets.randbelow(2_147_483_648),
        browser_family="firefox",
        browser_version=browser_version,
        platform=PLATFORM,
        user_agent=user_agent,
        http_impersonate=http_profile,
        ja3=ja3,
        h2_fingerprint=h2_fingerprint,
        locale=payload.locale,
        timezone=payload.timezone,
    )


def ensure_supported_identity(identity: AutomationIdentity) -> None:
    """Reject malformed or cross-browser identities before they hit Instagram."""
    if (
        identity.identity_version != IDENTITY_VERSION
        or identity.client != CLIENT_NAME
        or identity.browser_family != "firefox"
        or identity.platform != PLATFORM
        or not identity.user_agent.startswith("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:")
        or "Firefox/" not in identity.user_agent
        or not identity.http_impersonate.startswith("firefox")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="automation identity is not a supported Firefox web identity",
        )


def httpz_options(identity: AutomationIdentity) -> dict[str, str | bool]:
    """Return the immutable transport settings owned by the identity."""
    ensure_supported_identity(identity)
    return {
        "impersonate": identity.http_impersonate,
        "ja3": identity.ja3,
        "h2_fingerprint": identity.h2_fingerprint,
        "browser": identity.browser_family,
        "user_agent": identity.user_agent,
        # API/XHR headers are built below rather than using pyhttpz's document
        # navigation defaults.
        "browser_headers": False,
    }
