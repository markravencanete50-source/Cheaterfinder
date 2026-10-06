"""Private request/response contracts for the Express → FastAPI boundary."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


HTTP_METHOD = Literal["GET", "POST"]
ResponseUrlClass = Literal[
    "login", "challenge", "suspended", "instagram_api", "instagram_home",
    "instagram_other", "external", "unknown",
]


class ProxyConfig(BaseModel):
    """One sticky proxy lane; credentials never appear in logs or responses."""

    server: str = Field(min_length=1, max_length=1_024)
    username: str | None = Field(default=None, max_length=1_024)
    password: str | None = Field(default=None, max_length=1_024)


class AutomationIdentity(BaseModel):
    """The persistent network/browser identity assigned to exactly one bot."""

    identity_version: Literal[1] = 1
    client: Literal["instagram-firefox-web"] = "instagram-firefox-web"
    bot_id: str = Field(min_length=1, max_length=128)
    browser_seed: int = Field(ge=0, le=2_147_483_647)
    browser_family: Literal["firefox"] = "firefox"
    browser_version: str = Field(min_length=1, max_length=32)
    # invisible-playwright presents a coherent Windows persona, independent of
    # the Linux/macOS host running the service.
    platform: Literal["Windows"] = "Windows"
    # Derived from invisible-playwright's sealed engine, never a caller pool.
    user_agent: str = Field(min_length=1, max_length=1_024)
    http_impersonate: str = Field(min_length=1, max_length=64)
    ja3: str = Field(min_length=1, max_length=4_096)
    h2_fingerprint: str = Field(min_length=1, max_length=4_096)
    locale: str = Field(default="en-US", min_length=2, max_length=32)
    timezone: str = Field(default="America/New_York", min_length=1, max_length=64)


class CreateIdentityRequest(BaseModel):
    bot_id: str = Field(min_length=1, max_length=128)
    locale: str = Field(default="en-US", min_length=2, max_length=32)
    timezone: str = Field(default="America/New_York", min_length=1, max_length=64)


class InstagramRequest(BaseModel):
    """An authenticated API call, restricted to Instagram's web origin."""

    method: HTTP_METHOD = "GET"
    path: str = Field(min_length=1, max_length=8_192)
    # Additional endpoint-specific headers only. Browser identity headers are
    # created in Python from AutomationIdentity and cannot be supplied by the
    # Express caller.
    headers: dict[str, str] = Field(default_factory=dict)
    referer: str | None = Field(default=None, max_length=8_192)
    body: str | None = Field(default=None, max_length=1_000_000)
    timeout_ms: int = Field(default=30_000, ge=1_000, le=60_000)

    @field_validator("headers")
    @classmethod
    def validate_headers(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 100:
            raise ValueError("too many request headers")
        return value


class TransportRequest(BaseModel):
    identity: AutomationIdentity
    storage_state: dict[str, Any] = Field(default_factory=dict)
    proxy: ProxyConfig | None = None
    request: InstagramRequest
    operation_id: str | None = Field(default=None, max_length=128)
    deadline_ms: int = Field(default=60_000, ge=1_000, le=90_000)


class TransportResponse(BaseModel):
    status: int
    headers: dict[str, str]
    body: str
    # Only fixed classes cross the service boundary; never return the redirect
    # URL, which may contain a username, session token or next= query.
    response_url_class: ResponseUrlClass | None = None
    response_redirected: bool | None = None
    cookies: dict[str, str] = Field(default_factory=dict)
    # Browser calls can return an updated Playwright storage-state blob for
    # Express to persist in its encrypted bot-session record.
    storage_state: dict[str, Any] | None = None
    # Best-effort wire accounting for the whole browser launch, not just the
    # API body: a Firefox context loads a full instagram.com document through
    # the metered residential proxy before the in-page fetch runs.  Encoded
    # (on-the-wire) byte counts, absent when the transport cannot measure them.
    wire_bytes_in: int | None = None
    wire_bytes_out: int | None = None
    wire_breakdown: dict[str, int] | None = None
    transport_error: str | None = None
    browser_reused: bool = False
    operation_id: str | None = None


class InstagramFollowRequest(BaseModel):
    """One bounded UI follow using an existing bot session and fixed proxy."""

    model_config = ConfigDict(extra="forbid")

    identity: AutomationIdentity
    storage_state: dict[str, Any]
    proxy: ProxyConfig
    target_username: str = Field(min_length=1, max_length=30, pattern=r"^[A-Za-z0-9._]+$")
    target_user_id: str = Field(min_length=1, max_length=64, pattern=r"^[0-9]+$")
    deadline_ms: int = Field(default=60_000, ge=1_000, le=90_000)
    operation_id: str | None = Field(default=None, max_length=128)

    @field_validator("target_username")
    @classmethod
    def validate_target_username(cls, value: str) -> str:
        if value in {".", ".."} or value.lower() in {
            "accounts", "challenge", "checkpoint", "direct", "explore", "api", "graphql",
        }:
            raise ValueError("target must be an Instagram profile username")
        return value


class InstagramFollowResponse(BaseModel):
    status: Literal["accepted", "pending", "not_sent", "unknown"]
    following: bool = False
    outgoing_request: bool = False
    confirmed: bool = False
    # True as soon as the sole click is invoked, even if it later times out.
    clicked: bool = False
    reason: str | None = None
    storage_state: dict[str, Any] | None = None
    wire_bytes_in: int = 0
    wire_bytes_out: int = 0
    operation_id: str | None = None


class NativePublicReadRequest(InstagramFollowRequest):
    """Read data loaded by the ordinary public profile UI, without replaying API calls."""

    target_user_id: str | None = Field(default=None, max_length=64, pattern=r"^[0-9]+$")
    kind: Literal["profile", "posts", "stories", "highlights"]
    max_items: int = Field(default=24, ge=1, le=48)
    with_items: bool = False


# ─── Interactive login hand-off ────────────────────────────────────────────
#
# The browser process stays entirely inside FastAPI.  Express supplies the
# mailbox/TOTP code only after the browser has reached Instagram's challenge
# screen; it never receives a Playwright page, browser CDP endpoint, or a
# mutable fingerprint.  A pending login is short-lived and in-memory.


class InstagramLoginCredentials(BaseModel):
    username: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=1, max_length=1_024)


class InstagramLoginProbeRequest(BaseModel):
    """Credential-free check that a proxy can render Instagram's login form."""

    model_config = ConfigDict(extra="forbid")

    identity: AutomationIdentity
    proxy: ProxyConfig | None = None
    timeout_ms: int = Field(default=45_000, ge=5_000, le=60_000)


class InstagramLoginProbeResponse(BaseModel):
    status: Literal["ready", "rate_limited", "blocked", "error"]
    message: str | None = Field(default=None, max_length=500)


class InstagramLoginStartRequest(BaseModel):
    identity: AutomationIdentity
    credentials: InstagramLoginCredentials
    proxy: ProxyConfig | None = None
    timeout_ms: int = Field(default=60_000, ge=10_000, le=120_000)


class InstagramLoginCompleteRequest(BaseModel):
    login_id: str = Field(min_length=16, max_length=256)
    code: str = Field(min_length=4, max_length=16)
    timeout_ms: int = Field(default=60_000, ge=10_000, le=120_000)


class InstagramLoginResponse(BaseModel):
    status: Literal[
        "authenticated",
        "code_required",
        "bad_credentials",
        "captcha_required",
        "rate_limited",
        "suspended",
        "error",
    ]
    message: str | None = Field(default=None, max_length=500)
    login_id: str | None = Field(default=None, max_length=256)
    code_kind: Literal["email", "totp"] | None = None
    storage_state: dict[str, Any] | None = None
