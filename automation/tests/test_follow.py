"""Offline follow regression tests: no browser process, DB or network."""

import asyncio
import base64
import json
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.browser_pool import BrowserPool
from app.follow import (
    _FOLLOW_LABEL,
    _follow_on_page,
    _friendship_bridge_script,
    _page_block_reason,
    _parse_friendship,
    _read_friendship,
    _target_follow_button,
    follow_via_browser,
)
from app.models import AutomationIdentity, InstagramFollowRequest, InstagramFollowResponse, ProxyConfig
from app.instagram import _dismiss_cookie_consent


def payload(**overrides):
    values = {
        "identity": AutomationIdentity(
            bot_id="bot-1", browser_seed=123, browser_version="151.0",
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:151.0) Gecko/20100101 Firefox/151.0",
            http_impersonate="firefox151", ja3="fixture", h2_fingerprint="fixture",
        ),
        "storage_state": {"cookies": [
            {"name": "sessionid", "value": "fixture-session", "domain": ".instagram.com"},
            {"name": "csrftoken", "value": "fixture-csrf", "domain": ".instagram.com"},
        ], "origins": []},
        "proxy": ProxyConfig(server="http://fixed.example:1234", username="fixture-user", password="fixture-pass"),
        "target_username": "private.target",
        "target_user_id": "9007199254740993",
        "operation_id": "operation-1",
    }
    values.update(overrides)
    return InstagramFollowRequest(**values)


class FollowContractTest(unittest.TestCase):
    def test_proxy_is_required_and_targets_cannot_be_arbitrary_urls(self):
        for invalid in (None,):
            with self.assertRaises(ValidationError):
                payload(proxy=invalid)
        for username in ("../accounts", "..", ".", "accounts", "https://example.com", "target?next=elsewhere"):
            with self.assertRaises(ValidationError):
                payload(target_username=username)
        for target_id in ("1/2", "not-numeric", ""):
            with self.assertRaises(ValidationError):
                payload(target_user_id=target_id)

    def test_no_credentials_can_enter_the_follow_contract(self):
        with self.assertRaises(ValidationError):
            payload(credentials={"username": "bot", "password": "never-used"})

    def test_bridge_performs_only_get_with_redirects_rejected_and_current_csrf(self):
        script = _friendship_bridge_script(payload())
        self.assertIn('method: "GET"', script)
        self.assertNotIn('method: "POST"', script)
        self.assertIn('redirect: "error"', script)
        self.assertIn('credentials: "include"', script)
        self.assertIn('document.cookie', script)
        self.assertIn('/friendships/show/9007199254740993/', script)
        self.assertNotIn('/friendships/create/', script)

    def test_exact_labels_never_match_requested_following_unfollow_or_suggestions(self):
        for label in ("Follow", "Follow back", "Seguir", "Folgen"):
            self.assertIsNotNone(_FOLLOW_LABEL.fullmatch(label))
        for label in ("Following", "Requested", "Unfollow", "Follow all", "Follow target", "Seguindo"):
            self.assertIsNone(_FOLLOW_LABEL.fullmatch(label))

    def test_friendship_confirmation_rejects_missing_coerced_or_failed_status(self):
        for body in ({}, {"following": "true", "outgoing_request": False},
                     {"following": True}, {"following": True, "outgoing_request": False, "status": "fail"}):
            self.assertIsNone(_parse_friendship({"status": 200, "body": json.dumps(body)}))
        self.assertIsNone(_parse_friendship({"status": 200, "body": "<html>login</html>"}))
        self.assertIsNone(_parse_friendship({"status": 429, "body": '{}'}))
        self.assertEqual(_parse_friendship({"status": 200, "body": '{"following":false,"outgoing_request":true}'}), (False, True))


class FollowPageTest(unittest.IsolatedAsyncioTestCase):
    def page(self):
        return SimpleNamespace(add_init_script=AsyncMock(), wait_for_timeout=AsyncMock())

    async def test_preflight_prevents_duplicate_click_for_every_existing_relationship(self):
        for relationship, expected in (((True, False), "accepted"), ((False, True), "pending"), ((True, True), "pending")):
            with self.subTest(relationship=relationship):
                page, response = self.page(), InstagramFollowResponse(status="not_sent")
                with patch("app.follow._read_friendship", AsyncMock(return_value=(relationship, None))), \
                     patch("app.follow._target_follow_button", AsyncMock()) as find_button:
                    await _follow_on_page(page, payload(), response)
                self.assertEqual(response.status, expected)
                self.assertTrue(response.confirmed)
                self.assertFalse(response.clicked)
                find_button.assert_not_awaited()

    async def test_one_click_is_confirmed_by_a_new_friendship_read(self):
        page, response = self.page(), InstagramFollowResponse(status="not_sent")
        button = SimpleNamespace(click=AsyncMock())
        with patch("app.follow._read_friendship", AsyncMock(side_effect=[((False, False), None), ((False, True), None)])) as reads, \
             patch("app.follow._target_follow_button", AsyncMock(return_value=button)), \
             patch("app.follow._page_block_reason", AsyncMock(return_value=None)):
            await _follow_on_page(page, payload(), response)
        self.assertEqual(reads.await_count, 2)
        button.click.assert_awaited_once()
        self.assertEqual(response.status, "pending")
        self.assertTrue(response.confirmed)
        self.assertTrue(response.clicked)
        page.add_init_script.assert_awaited_once()

    async def test_unconfirmed_write_is_unknown_and_never_clicked_again(self):
        for confirmation in (((False, False), None), (None, "friendship_unavailable")):
            page, response = self.page(), InstagramFollowResponse(status="not_sent")
            button = SimpleNamespace(click=AsyncMock())
            with patch("app.follow._read_friendship", AsyncMock(side_effect=[((False, False), None), confirmation])), \
                 patch("app.follow._target_follow_button", AsyncMock(return_value=button)), \
                 patch("app.follow._page_block_reason", AsyncMock(return_value=None)):
                await _follow_on_page(page, payload(), response)
            self.assertEqual(response.status, "unknown")
            self.assertTrue(response.clicked)
            self.assertFalse(response.confirmed)
            button.click.assert_awaited_once()

    async def test_failed_preflight_never_attempts_a_click(self):
        page, response = self.page(), InstagramFollowResponse(status="not_sent")
        with patch("app.follow._read_friendship", AsyncMock(return_value=(None, "login_required"))), \
             patch("app.follow._target_follow_button", AsyncMock()) as find_button:
            await _follow_on_page(page, payload(), response)
        find_button.assert_not_awaited()
        self.assertFalse(response.clicked)
        self.assertEqual(response.reason, "login_required")

    async def test_challenge_appearing_during_hydration_prevents_click(self):
        page, response = self.page(), InstagramFollowResponse(status="not_sent")
        button = SimpleNamespace(click=AsyncMock())
        with patch("app.follow._read_friendship", AsyncMock(return_value=((False, False), None))), \
             patch("app.follow._target_follow_button", AsyncMock(return_value=button)), \
             patch("app.follow._page_block_reason", AsyncMock(return_value="challenge_required")):
            await _follow_on_page(page, payload(), response)
        self.assertFalse(response.clicked)
        button.click.assert_not_awaited()

    async def test_insufficient_confirmation_time_prevents_a_last_second_click(self):
        page, response = self.page(), InstagramFollowResponse(status="not_sent")
        button = SimpleNamespace(click=AsyncMock())
        with patch("app.follow._read_friendship", AsyncMock(return_value=((False, False), None))), \
             patch("app.follow._target_follow_button", AsyncMock(return_value=button)), \
             patch("app.follow._page_block_reason", AsyncMock(return_value=None)):
            await _follow_on_page(page, payload(), response, deadline_at=time.monotonic() + 1)
        self.assertFalse(response.clicked)
        self.assertEqual(response.reason, "insufficient_confirmation_time")
        button.click.assert_not_awaited()

    async def test_profile_header_is_the_only_button_scope_and_ambiguity_fails_closed(self):
        for visible_count in (1, 2):
            candidates = [SimpleNamespace(is_visible=AsyncMock(return_value=True), is_enabled=AsyncMock(return_value=True)) for _ in range(visible_count)]
            buttons = SimpleNamespace(first=SimpleNamespace(wait_for=AsyncMock()), count=AsyncMock(return_value=visible_count), nth=lambda index: candidates[index])
            header = SimpleNamespace(first=SimpleNamespace(wait_for=AsyncMock()), count=AsyncMock(return_value=1), get_by_role=Mock(return_value=buttons))
            page = SimpleNamespace(locator=Mock(return_value=header))
            selected = await _target_follow_button(page)
            page.locator.assert_called_once_with("main header")
            header.get_by_role.assert_called_once_with("button", name=_FOLLOW_LABEL)
            self.assertIs(selected, candidates[0] if visible_count == 1 else None)

    async def test_redirects_login_and_challenge_surfaces_are_not_profiles(self):
        for url, reason in (
            ("https://www.instagram.com/accounts/login/", "login_required"),
            ("https://www.instagram.com/challenge/123/", "challenge_required"),
            ("https://www.instagram.com/another.target/", "target_navigation_mismatch"),
            ("https://example.com/private.target/", "target_navigation_mismatch"),
        ):
            self.assertEqual(await _page_block_reason(SimpleNamespace(url=url), "private.target"), reason)

    async def test_friendship_reader_decodes_only_the_authenticated_get_result(self):
        encoded = base64.b64encode(json.dumps({"status": 200, "body": '{"following":false,"outgoing_request":true}'}).encode()).decode()
        root = SimpleNamespace(wait_for=AsyncMock(), get_attribute=AsyncMock(return_value=encoded))
        page = SimpleNamespace(goto=AsyncMock(), locator=Mock(return_value=root))
        with patch("app.follow._page_block_reason", AsyncMock(return_value=None)):
            status, reason = await _read_friendship(page, "https://www.instagram.com/private.target/", "private.target")
        self.assertEqual(status, (False, True))
        self.assertIsNone(reason)

    async def test_cookie_consent_is_declined_before_rechecking_target(self):
        encoded = base64.b64encode(json.dumps({"status": 200, "body": '{"following":false,"outgoing_request":false}'}).encode()).decode()
        root = SimpleNamespace(wait_for=AsyncMock(), get_attribute=AsyncMock(return_value=encoded))
        page = SimpleNamespace(url="https://www.instagram.com/consent/", goto=AsyncMock(), wait_for_url=AsyncMock(), locator=Mock(return_value=root))
        with patch("app.follow._dismiss_cookie_consent", AsyncMock()) as dismiss, \
             patch("app.follow._page_block_reason", AsyncMock(return_value=None)) as recheck:
            status, reason = await _read_friendship(page, "https://www.instagram.com/private.target/", "private.target")
        dismiss.assert_awaited_once_with(page, timeout_ms=8_000)
        self.assertEqual(page.goto.await_count, 2)
        page.wait_for_url.assert_awaited_once()
        allowed = page.wait_for_url.await_args.args[0]
        self.assertTrue(allowed("https://www.instagram.com/"))
        self.assertTrue(allowed("https://www.instagram.com/private.target/"))
        self.assertFalse(allowed("https://www.instagram.com/challenge/"))
        self.assertFalse(allowed("https://example.com/"))
        recheck.assert_awaited_once_with(page, "private.target")
        self.assertEqual(status, (False, False))
        self.assertIsNone(reason)

    async def test_unresolved_consent_or_foreign_redirect_cannot_authorize_a_follow(self):
        for url, expected_dismissals in (("https://www.instagram.com/consent/", 1), ("https://example.com/consent/", 0)):
            page = SimpleNamespace(url=url, goto=AsyncMock(), wait_for_url=AsyncMock(), locator=Mock())
            with patch("app.follow._dismiss_cookie_consent", AsyncMock()) as dismiss:
                status, reason = await _read_friendship(page, "https://www.instagram.com/private.target/", "private.target")
            self.assertIsNone(status)
            self.assertEqual(reason, "target_navigation_mismatch")
            self.assertEqual(dismiss.await_count, expected_dismissals)
            self.assertEqual(page.goto.await_count, 1+expected_dismissals)
            page.locator.assert_not_called()

    async def test_cookie_preference_waits_for_hydration_and_never_accepts_optional_cookies(self):
        button = SimpleNamespace(wait_for=AsyncMock(), click=AsyncMock())
        page = SimpleNamespace(get_by_role=Mock(return_value=SimpleNamespace(first=button)), wait_for_timeout=AsyncMock())
        await _dismiss_cookie_consent(page, timeout_ms=8000)
        page.get_by_role.assert_called_once_with("button", name="Decline optional cookies", exact=True)
        button.wait_for.assert_awaited_once_with(state="visible", timeout=8000)
        button.click.assert_awaited_once()
        button.wait_for.side_effect = TimeoutError()
        button.click.reset_mock()
        await _dismiss_cookie_consent(page, timeout_ms=8000)
        button.click.assert_not_awaited()


class FollowRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pool = BrowserPool(max_size=1)
        self.page = SimpleNamespace()
        self.context = SimpleNamespace(new_page=AsyncMock(return_value=self.page), storage_state=AsyncMock(return_value={"cookies": [], "origins": []}), close=AsyncMock(), on=Mock())
        self.browser = SimpleNamespace(new_context=AsyncMock(return_value=self.context))
        self.driver = SimpleNamespace(__aenter__=AsyncMock(return_value=self.browser), __aexit__=AsyncMock())
        self.pool_patch = patch("app.follow.browser_pool", self.pool)
        self.driver_patch = patch("invisible_playwright.async_api.InvisiblePlaywright", return_value=self.driver)
        self.pool_patch.start()
        self.driver_factory = self.driver_patch.start()

    async def asyncTearDown(self):
        await self.pool.close()
        self.driver_patch.stop()
        self.pool_patch.stop()

    async def test_preserves_identity_proxy_session_and_always_closes_dedicated_context(self):
        request = payload()
        with patch("app.follow._follow_on_page", AsyncMock()):
            response = await follow_via_browser(request)
        self.driver_factory.assert_called_once_with(seed=123, headless=True, proxy=request.proxy.model_dump(exclude_none=True), locale=request.identity.locale, timezone=request.identity.timezone)
        self.browser.new_context.assert_awaited_once_with(storage_state=request.storage_state)
        self.context.close.assert_awaited_once()
        self.driver.__aexit__.assert_awaited_once()
        self.assertEqual(response.storage_state, {"cookies": [], "origins": []})
        self.assertEqual(response.operation_id, "operation-1")
        self.assertFalse(self.pool._entries)

    async def test_missing_saved_session_never_launches_browser(self):
        response = await follow_via_browser(payload(storage_state={"cookies": []}))
        self.assertEqual(response.reason, "saved_session_unavailable")
        self.driver_factory.assert_not_called()

    async def test_runtime_rejects_proxy_bypass_even_if_model_validation_was_bypassed(self):
        request = payload().model_copy(update={"proxy": None})
        with self.assertRaisesRegex(ValueError, "requires a proxy"):
            await follow_via_browser(request)
        self.driver_factory.assert_not_called()

    async def test_exception_after_click_is_unknown_with_no_retry(self):
        async def click_then_fail(_page, _payload, response, **_kwargs):
            response.clicked = True
            raise RuntimeError("sensitive upstream details must not escape")
        with patch("app.follow._follow_on_page", AsyncMock(side_effect=click_then_fail)) as action:
            response = await follow_via_browser(payload())
        action.assert_awaited_once()
        self.assertEqual(response.status, "unknown")
        self.assertTrue(response.clicked)
        self.assertFalse(response.confirmed)
        self.assertEqual(response.reason, "browser_operation_failed")
        self.context.close.assert_awaited_once()

    async def test_deadline_stops_preclick_work_and_releases_capacity(self):
        async def wait_forever(*_args, **_kwargs):
            await asyncio.Event().wait()
        with patch("app.follow._follow_on_page", AsyncMock(side_effect=wait_forever)):
            response = await follow_via_browser(payload(deadline_ms=1000))
        self.assertEqual(response.status, "not_sent")
        self.assertEqual(response.reason, "deadline_exceeded")
        self.context.close.assert_awaited_once()
        self.assertFalse(self.pool._entries)
        self.assertFalse(self.pool._owners)

    async def test_cancellation_after_click_propagates_and_closes_without_retry(self):
        entered = asyncio.Event()
        async def click_and_wait(_page, _payload, response, **_kwargs):
            response.clicked = True
            entered.set()
            await asyncio.Event().wait()
        with patch("app.follow._follow_on_page", AsyncMock(side_effect=click_and_wait)) as action:
            task = asyncio.create_task(follow_via_browser(payload()))
            await entered.wait()
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        action.assert_awaited_once()
        self.context.close.assert_awaited_once()
        self.assertFalse(self.pool._entries)


class FollowRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_follow_route_requires_the_existing_internal_token(self):
        from app.main import app
        from app.security import require_internal_token
        route = next(route for route in app.routes if route.path == "/v1/instagram/follow")
        self.assertEqual(route.methods, {"POST"})
        self.assertIn(require_internal_token, [dependency.call for dependency in route.dependant.dependencies])

    async def test_already_disconnected_caller_cannot_start_a_follow(self):
        from app.main import instagram_follow
        request = SimpleNamespace(is_disconnected=AsyncMock(return_value=True))
        with patch("app.main.follow_via_browser", AsyncMock()) as action:
            with self.assertRaises(HTTPException) as raised:
                await instagram_follow(payload(), request)
        self.assertEqual(raised.exception.status_code, 499)
        action.assert_not_awaited()

    async def test_disconnect_cancels_inflight_follow(self):
        from app.main import instagram_follow
        request = SimpleNamespace(is_disconnected=AsyncMock(side_effect=[False, True]))
        cancelled = asyncio.Event()
        async def pending(*_args):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        with patch("app.main.follow_via_browser", AsyncMock(side_effect=pending)) as action:
            with self.assertRaises(asyncio.CancelledError):
                await instagram_follow(payload(), request)
        action.assert_awaited_once()
        self.assertTrue(cancelled.is_set())


if __name__ == "__main__":
    unittest.main()
