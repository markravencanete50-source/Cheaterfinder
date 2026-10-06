import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.browser_pool import BrowserPool, BrowserSession, fingerprint
from app.instagram import _fetch_with_document_bridge, _in_page_fetch_script, _export_read_storage_state


class BrowserPoolTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pool = BrowserPool(max_size=2, ttl_seconds=60, max_calls=3)
        self.created = []

    async def asyncTearDown(self):
        await self.pool.close()

    async def factory(self, identity="identity", state="session"):
        entry = BrowserSession(
            SimpleNamespace(__aexit__=AsyncMock()), object(),
            SimpleNamespace(close=AsyncMock()), object(), identity, {state}, time.monotonic(),
        )
        self.created.append(entry)
        return entry

    async def test_cold_mode_closes_every_context(self):
        async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=False) as (entry, reused):
            self.assertFalse(reused)
        entry.context.close.assert_awaited_once()
        entry.driver.__aexit__.assert_awaited_once()
        self.assertFalse(self.pool._entries)

    async def test_matching_bot_identity_and_session_reuses(self):
        for expected in [False, True]:
            async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True) as (_, reused):
                self.assertEqual(reused, expected)
        self.assertEqual(len(self.created), 1)

    async def test_changed_cookie_or_proxy_identity_invalidates(self):
        async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True):
            pass
        async with self.pool.borrow("bot", "different-proxy", "session", lambda: self.factory("different-proxy"), reuse=True) as (_, reused):
            self.assertFalse(reused)
        async with self.pool.borrow("bot", "different-proxy", "new-login", lambda: self.factory("different-proxy", "new-login"), reuse=True) as (_, reused):
            self.assertFalse(reused)
        self.assertEqual(len(self.created), 3)
        self.created[0].context.close.assert_awaited_once()
        self.created[1].context.close.assert_awaited_once()

    async def test_bots_never_share_a_context(self):
        for bot in ["a", "b"]:
            async with self.pool.borrow(bot, "identity", "session", self.factory, reuse=True) as (_, reused):
                self.assertFalse(reused)
        self.assertEqual(len(self.created), 2)

    async def test_failed_or_cancelled_work_evicts(self):
        with self.assertRaises(RuntimeError):
            async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True):
                raise RuntimeError("failed fetch")
        self.assertFalse(self.pool._entries)
        self.created[0].context.close.assert_awaited_once()

    async def test_same_bot_is_serialized(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def first():
            async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True):
                entered.set()
                await release.wait()
        task = asyncio.create_task(first())
        await entered.wait()
        second_entered = asyncio.Event()
        async def second():
            async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True):
                second_entered.set()
        other = asyncio.create_task(second())
        await asyncio.sleep(0)
        self.assertFalse(second_entered.is_set())
        release.set()
        await asyncio.gather(task, other)
        self.assertTrue(second_entered.is_set())
        self.assertFalse(self.pool._owners)

    async def test_age_and_call_limits_close_contexts(self):
        async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True) as (entry, _):
            entry.created_at -= 61
        await self.pool._prune()
        self.assertFalse(self.pool._entries)
        for _ in range(3):
            async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True):
                pass
        self.assertFalse(self.pool._entries)

    async def test_resident_count_is_bounded(self):
        for bot in ["a", "b", "c", "d"]:
            async with self.pool.borrow(bot, "identity", "session", self.factory, reuse=True):
                self.assertLessEqual(len(self.pool._entries), 2)

    async def test_parallel_factories_reserve_resident_capacity(self):
        async with self.pool.borrow("idle", "identity", "session", self.factory, reuse=True):
            pass
        entered, release = asyncio.Event(), asyncio.Event()
        async def delayed_factory():
            entered.set()
            await release.wait()
            return await self.factory()
        async def acquire(bot, factory):
            async with self.pool.borrow(bot, "identity", "session", factory, reuse=True):
                self.assertLessEqual(len(self.pool._entries) + self.pool._creating, 2)
        first = asyncio.create_task(acquire("first", delayed_factory))
        await entered.wait()
        await acquire("second", self.factory)
        release.set()
        await first
        self.assertLessEqual(len(self.pool._entries), 2)
        self.created[0].context.close.assert_awaited_once()

    async def test_deadline_cancels_active_work_and_closes_context(self):
        with self.assertRaises(TimeoutError):
            async with asyncio.timeout(0.01):
                async with self.pool.borrow("bot", "identity", "session", self.factory, reuse=True):
                    await asyncio.Event().wait()
        self.assertFalse(self.pool._entries)
        self.assertFalse(self.pool._owners)
        self.created[0].context.close.assert_awaited_once()

    async def test_bridge_is_page_scoped_and_always_closes_page(self):
        page = SimpleNamespace(on=lambda *_: None, add_init_script=AsyncMock(), close=AsyncMock())
        context = SimpleNamespace(new_page=AsyncMock(return_value=page))
        with patch("app.instagram._read_document_bridge", new=AsyncMock(return_value=({"status": 200}, None))):
            async def export_before_close():
                page.close.assert_not_awaited()
            await _fetch_with_document_bridge(context, "https://www.instagram.com/", {"url": "https://www.instagram.com/api/", "method": "GET"}, 1000, on_read=export_before_close)
        page.add_init_script.assert_awaited_once()
        page.close.assert_awaited_once()
        self.assertFalse(hasattr(context, "add_init_script"))

    async def test_state_export_failure_does_not_discard_completed_read(self):
        original = {"cookies": [{"name": "sessionid", "value": "original"}], "origins": []}
        context = SimpleNamespace(storage_state=AsyncMock(side_effect=TimeoutError()))
        state, exported = await _export_read_storage_state(context, original)
        self.assertFalse(exported)
        self.assertIs(state, original)

    def test_session_fingerprint_is_stable_and_changes_on_new_login(self):
        self.assertEqual(fingerprint({"a": 1, "b": 2}), fingerprint({"b": 2, "a": 1}))
        self.assertNotEqual(fingerprint({"sessionid": "old"}), fingerprint({"sessionid": "new"}))

    def test_api_read_bypasses_cache_even_when_static_browser_assets_are_reused(self):
        self.assertIn('cache: "no-store"', _in_page_fetch_script({"url": "https://www.instagram.com/api/v1/media/1/likers/"}))
