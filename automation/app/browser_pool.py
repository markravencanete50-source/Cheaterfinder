"""Bounded, single-owner browser contexts. Reuse is an explicit canary only.

Cookies/identity/proxy must all match. A changed session invalidates the old
context. Every read gets a fresh PAGE (no accumulated init scripts), but an
eligible context can retain its HTTP cache. No account ever shares a context.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator, Callable, Awaitable


def bounded_int(name: str, default: int, lower: int, upper: int) -> int:
    try:
        return min(upper, max(lower, int(os.getenv(name, str(default)))))
    except ValueError:
        return default


def fingerprint(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass
class BrowserSession:
    driver: Any
    browser: Any
    context: Any
    meter: Any
    identity_key: str
    session_keys: set[str]
    created_at: float
    calls: int = 0
    busy: bool = False


async def close_session(session: BrowserSession) -> None:
    try:
        await asyncio.wait_for(session.context.close(), timeout=1.0)
    except Exception:
        pass
    finally:
        try:
            await asyncio.wait_for(session.driver.__aexit__(None, None, None), timeout=2.0)
        except Exception:
            pass


class BrowserPool:
    def __init__(self, max_size: int = 6, ttl_seconds: float = 120, max_calls: int = 8) -> None:
        self.max_size = max_size
        self.ttl_seconds = ttl_seconds
        self.max_calls = max_calls
        self._slots = asyncio.Semaphore(max_size)
        self._entries: dict[str, BrowserSession] = {}
        self._creating = 0
        self._owners: dict[str, tuple[asyncio.Lock, int]] = {}
        self._reaper: asyncio.Task | None = None

    async def _prune(self) -> None:
        now = time.monotonic()
        for bot_id, entry in list(self._entries.items()):
            if self._entries.get(bot_id) is entry and not entry.busy and now - entry.created_at >= self.ttl_seconds:
                self._entries.pop(bot_id, None)
                await close_session(entry)

    async def _reap(self) -> None:
        try:
            while self._entries:
                await asyncio.sleep(min(self.ttl_seconds, 10))
                await self._prune()
        finally:
            self._reaper = None

    @asynccontextmanager
    async def borrow(
        self, bot_id: str, identity_key: str, session_key: str,
        factory: Callable[[], Awaitable[BrowserSession]], *, reuse: bool,
    ) -> AsyncIterator[tuple[BrowserSession, bool]]:
        # Even cold mode serializes one bot so its cookies cannot race.
        owner, users = self._owners.get(bot_id, (asyncio.Lock(), 0))
        self._owners[bot_id] = (owner, users + 1)
        try:
            async with owner, self._slots:
                await self._prune()
                entry = self._entries.get(bot_id)
                if entry and (not reuse or entry.identity_key != identity_key or
                              session_key not in entry.session_keys or entry.calls >= self.max_calls):
                    self._entries.pop(bot_id, None)
                    await close_session(entry)
                    entry = None
                reused = entry is not None
                if entry is None:
                    # Bound resident contexts as well as simultaneous requests.
                    # Reserve capacity BEFORE awaiting close/startup. Parallel
                    # factories otherwise all see spare room and exceed the cap.
                    self._creating += 1
                    try:
                        while len(self._entries) + self._creating > self.max_size:
                            idle = next(((k, e) for k, e in self._entries.items() if not e.busy), None)
                            if idle is None:
                                raise RuntimeError("browser resident capacity unavailable")
                            self._entries.pop(idle[0], None)
                            await close_session(idle[1])
                        entry = await factory()
                        self._entries[bot_id] = entry
                    finally:
                        self._creating -= 1
                entry.busy = True
                healthy = False
                try:
                    yield entry, reused
                    healthy = True
                finally:
                    entry.busy = False
                    entry.calls += 1
                    if not healthy or not reuse or entry.calls >= self.max_calls:
                        self._entries.pop(bot_id, None)
                        await close_session(entry)
                    elif self._reaper is None:
                        self._reaper = asyncio.create_task(self._reap())
        finally:
            current = self._owners.get(bot_id)
            if current:
                if current[1] <= 1:
                    self._owners.pop(bot_id, None)
                else:
                    self._owners[bot_id] = (current[0], current[1] - 1)

    async def close(self) -> None:
        if self._reaper:
            self._reaper.cancel()
            await asyncio.gather(self._reaper, return_exceptions=True)
        entries, self._entries = list(self._entries.values()), {}
        await asyncio.gather(*(close_session(e) for e in entries))


browser_pool = BrowserPool(
    max_size=bounded_int("BROWSER_MAX_CONTEXTS", 6, 1, 16),
    ttl_seconds=bounded_int("BROWSER_CONTEXT_TTL_SECONDS", 120, 10, 600),
    max_calls=bounded_int("BROWSER_CONTEXT_MAX_CALLS", 8, 1, 20),
)


def canary_enabled(name: str, bot_id: str) -> bool:
    """Explicit bot allowlist. A global boolean cannot change every viewer."""
    return bot_id in {x.strip() for x in os.getenv(name, "").split(",") if x.strip()}
