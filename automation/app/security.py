"""Internal request authentication for the loopback-only service."""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import get_settings


def require_internal_token(
    x_automation_token: str | None = Header(default=None),
) -> None:
    """Require the shared token even though the server is bound to loopback.

    Loopback binding prevents remote access; the token prevents an unrelated
    process on the same machine from driving browser sessions.
    """
    expected = get_settings().internal_token
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="AUTOMATION_API_TOKEN is not configured",
        )
    if not x_automation_token or not hmac.compare_digest(x_automation_token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid automation service token",
        )
