"""FastAPI application that owns browser automation and Instagram transport.

Only the health contract is live in this first migration slice.  Endpoint
implementations will be added behind this boundary before TypeScript callers
are switched away from their existing transport.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from fastapi import Depends, FastAPI, HTTPException, Request
from .browser_pool import browser_pool
from .follow import follow_via_browser
from .public_native import read_native_public

from .identity import create_identity as mint_identity
from .instagram import (
    complete_instagram_login,
    probe_instagram_login,
    request_via_browser,
    request_via_httpz,
    start_instagram_login,
)
from .models import (
    AutomationIdentity,
    CreateIdentityRequest,
    InstagramLoginCompleteRequest,
    InstagramLoginProbeRequest,
    InstagramLoginProbeResponse,
    InstagramLoginResponse,
    InstagramLoginStartRequest,
    InstagramFollowRequest,
    InstagramFollowResponse,
    TransportRequest,
    TransportResponse,
    NativePublicReadRequest,
)
from .runtime import runtime_status
from .security import require_internal_token

@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await browser_pool.close()


app = FastAPI(
    title="CheaterFinder local automation service",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.get("/v1/health", dependencies=[Depends(require_internal_token)])
def health() -> dict[str, object]:
    """Authenticated readiness endpoint used by the Express integration."""
    runtime = runtime_status()
    ready = bool(
        runtime["browser_available"]
        and runtime["browser_engine_available"]
        and runtime["http_available"]
    )
    return {
        "status": "ok" if ready else "degraded",
        "loopback_only": True,
        "runtime": runtime,
    }


@app.post("/v1/identities", dependencies=[Depends(require_internal_token)])
def create_identity(payload: CreateIdentityRequest) -> AutomationIdentity:
    """Create a stable identity once; Express must persist this response."""
    return mint_identity(payload)


@app.post("/v1/instagram/http", dependencies=[Depends(require_internal_token)])
async def instagram_http(payload: TransportRequest) -> TransportResponse:
    """Authenticated Instagram request using pyhttpz TLS/H2 impersonation."""
    return await request_via_httpz(payload)


@app.post("/v1/instagram/browser", dependencies=[Depends(require_internal_token)])
async def instagram_browser(payload: TransportRequest, request: Request) -> TransportResponse:
    """Authenticated Instagram request made inside invisible-playwright."""
    work = asyncio.create_task(request_via_browser(payload))
    async def disconnect_watch():
        while not work.done():
            if await request.is_disconnected():
                work.cancel()
                return
            await asyncio.sleep(0.2)
    watcher = asyncio.create_task(disconnect_watch())
    try:
        return await work
    finally:
        watcher.cancel()
        if not work.done():
            work.cancel()
        await asyncio.gather(work, watcher, return_exceptions=True)


@app.post("/v1/instagram/follow", dependencies=[Depends(require_internal_token)])
async def instagram_follow(payload: InstagramFollowRequest, request: Request) -> InstagramFollowResponse:
    """One UI click at most; cancellation never retries an ambiguous write."""
    if await request.is_disconnected():
        raise HTTPException(status_code=499, detail="follow caller disconnected")
    work = asyncio.create_task(follow_via_browser(payload))

    async def disconnect_watch():
        while not work.done():
            if await request.is_disconnected():
                work.cancel()
                return
            await asyncio.sleep(0.2)

    watcher = asyncio.create_task(disconnect_watch())
    try:
        return await work
    finally:
        watcher.cancel()
        if not work.done():
            work.cancel()
        await asyncio.gather(work, watcher, return_exceptions=True)


@app.post("/v1/instagram/public-page", dependencies=[Depends(require_internal_token)])
async def instagram_public_page(payload: NativePublicReadRequest, request: Request) -> TransportResponse:
    if await request.is_disconnected():
        raise HTTPException(status_code=499, detail="native read caller disconnected")
    work = asyncio.create_task(read_native_public(payload))

    async def disconnect_watch():
        while not work.done():
            if await request.is_disconnected():
                work.cancel()
                return
            await asyncio.sleep(0.2)

    watcher = asyncio.create_task(disconnect_watch())
    try:
        return await work
    finally:
        watcher.cancel()
        if not work.done():
            work.cancel()
        await asyncio.gather(work, watcher, return_exceptions=True)


@app.post("/v1/instagram/login/start", dependencies=[Depends(require_internal_token)])
async def instagram_login_start(
    payload: InstagramLoginStartRequest,
) -> InstagramLoginResponse:
    """Begin Python-owned browser login; return only a safe login outcome."""
    return await start_instagram_login(payload)


@app.post("/v1/instagram/login/probe", dependencies=[Depends(require_internal_token)])
async def instagram_login_probe(
    payload: InstagramLoginProbeRequest,
) -> InstagramLoginProbeResponse:
    """Check a proxy's login surface without accepting account credentials."""
    return await probe_instagram_login(payload)


@app.post("/v1/instagram/login/complete", dependencies=[Depends(require_internal_token)])
async def instagram_login_complete(
    payload: InstagramLoginCompleteRequest,
) -> InstagramLoginResponse:
    """Resume a short-lived code challenge in the same local Firefox page."""
    return await complete_instagram_login(payload)
