import asyncio
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from pydantic import ValidationError

from app.identity import create_identity
from app.instagram import (
    _has_bad_credentials_copy,
    _close_login_resources,
    _login_outcome,
    _WireMeter,
    _wire_top_types,
    browser_fetch_headers,
    cookie_values,
    instagram_api_headers,
    instagram_url,
    proxy_url,
    _format_trace_body,
    _trace_headers,
    _write_transport_trace,
)
from app.models import (
    CreateIdentityRequest,
    InstagramLoginProbeRequest,
    InstagramLoginStartRequest,
    InstagramRequest,
    ProxyConfig,
    TransportRequest,
    TransportResponse,
)
from app.runtime import browser_engine_available


class LoginResourceLifecycleTest(unittest.IsolatedAsyncioTestCase):
    async def test_hung_context_does_not_prevent_driver_cleanup(self) -> None:
        async def hung_close():
            await asyncio.Future()
        context = SimpleNamespace(close=AsyncMock(side_effect=hung_close))
        driver = SimpleNamespace(__aexit__=AsyncMock(return_value=None))
        with patch("app.instagram.LOGIN_CLEANUP_TIMEOUT_SECONDS", 0.01):
            await asyncio.wait_for(_close_login_resources(context, driver), timeout=0.5)
        driver.__aexit__.assert_awaited_once()

    async def test_hung_driver_does_not_hold_a_completed_login(self) -> None:
        async def hung_exit(*_args):
            await asyncio.Future()
        context = SimpleNamespace(close=AsyncMock(return_value=None))
        driver = SimpleNamespace(__aexit__=AsyncMock(side_effect=hung_exit))
        with patch("app.instagram.LOGIN_CLEANUP_TIMEOUT_SECONDS", 0.01):
            await asyncio.wait_for(_close_login_resources(context, driver), timeout=0.5)
        context.close.assert_awaited_once()

    async def test_navigation_failure_is_returned_despite_cleanup_failure(self) -> None:
        from app.instagram import start_instagram_login
        page = SimpleNamespace(goto=AsyncMock(side_effect=RuntimeError("navigation failed")))
        context = SimpleNamespace(new_page=AsyncMock(return_value=page), close=AsyncMock(side_effect=RuntimeError("close failed")))
        browser = SimpleNamespace(new_context=AsyncMock(return_value=context))
        driver = SimpleNamespace(__aenter__=AsyncMock(return_value=browser), __aexit__=AsyncMock(side_effect=RuntimeError("driver failed")))
        payload = InstagramLoginStartRequest(identity=create_identity(CreateIdentityRequest(bot_id="login-fixture")), credentials={"username":"fixture_user", "password":"fixture_password"})
        with patch("invisible_playwright.async_api.InvisiblePlaywright", return_value=driver), \
             patch("app.instagram._cleanup_expired_logins", new=AsyncMock()), \
             patch("app.instagram._capture_login_debug_screenshot", new=AsyncMock()):
            result = await start_instagram_login(payload)
        self.assertEqual(result.status, "error")
        self.assertIn("login_navigation", result.message)
        self.assertIsNone(result.storage_state)
        context.close.assert_awaited_once()
        driver.__aexit__.assert_awaited_once()

    async def test_hung_session_export_cannot_be_reported_as_authenticated(self) -> None:
        async def hung_state():
            await asyncio.Future()
        page = SimpleNamespace(url="https://www.instagram.com/", context=SimpleNamespace(storage_state=AsyncMock(side_effect=hung_state)))
        with patch("app.instagram.LOGIN_STATE_TIMEOUT_SECONDS", 0.01), \
             patch("app.instagram._visible_body", new=AsyncMock(return_value="home")):
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(_login_outcome(page), timeout=0.5)


class InstagramAdapterTest(unittest.IsolatedAsyncioTestCase):
    @staticmethod
    def page(url: str, storage_state: dict) -> SimpleNamespace:
        return SimpleNamespace(
            url=url,
            context=SimpleNamespace(
                storage_state=AsyncMock(return_value=storage_state),
            ),
        )

    def test_current_login_information_error_is_bad_credentials(self) -> None:
        self.assertTrue(
            _has_bad_credentials_copy(
                "The login information you entered is incorrect. Find your account and log in."
            )
        )
        self.assertFalse(_has_bad_credentials_copy("Log into Instagram"))
        self.assertFalse(_has_bad_credentials_copy("Sorry, we couldn't log you in. Please try again."))

    async def test_generic_login_alert_does_not_claim_wrong_password(self) -> None:
        page = self.page("https://www.instagram.com/accounts/login/", {"cookies": []})
        with patch("app.instagram._visible_body", new=AsyncMock(return_value="something went wrong")), \
                patch("app.instagram._has_login_error_alert", new=AsyncMock(return_value=True)):
            outcome, message = await _login_outcome(page)
        self.assertEqual(outcome, "error")
        self.assertIn("generic visible login alert", message)

    async def test_checkpoint_does_not_invent_an_email_code_step(self) -> None:
        page = self.page("https://www.instagram.com/challenge/opaque/", {"cookies": []})
        with patch("app.instagram._visible_body", new=AsyncMock(return_value="confirm your identity")):
            outcome, message = await _login_outcome(page)
        self.assertEqual(outcome, "error")
        self.assertIn("checkpoint", message)

    async def test_explicit_email_code_step_is_preserved(self) -> None:
        page = self.page("https://www.instagram.com/challenge/opaque/", {"cookies": []})
        with patch("app.instagram._visible_body", new=AsyncMock(return_value="we sent a security code to your email")):
            outcome, _ = await _login_outcome(page)
        self.assertEqual(outcome, "code_required:email")

    async def test_sms_code_is_not_misrouted_to_email_or_totp(self) -> None:
        page = self.page("https://www.instagram.com/challenge/opaque/", {"cookies": []})
        with patch("app.instagram._visible_body", new=AsyncMock(return_value="two-factor verification code sent by text message")):
            outcome, message = await _login_outcome(page)
        self.assertEqual(outcome, "error")
        self.assertIn("SMS", message)

    async def test_suspended_surface_wins_over_session_cookie(self) -> None:
        page = self.page(
            "https://www.instagram.com/accounts/suspended/",
            {
                "cookies": [
                    {
                        "name": "sessionid",
                        "value": "present-but-locked",
                        "domain": ".instagram.com",
                    }
                ]
            },
        )
        with patch(
            "app.instagram._visible_body",
            new=AsyncMock(return_value="your account has been suspended"),
        ):
            outcome, _ = await _login_outcome(page)
        self.assertEqual(outcome, "suspended")

    async def test_session_cookie_with_authenticated_navigation_is_authenticated(self) -> None:
        page = self.page(
            "https://www.instagram.com/",
            {
                "cookies": [
                    {
                        "name": "sessionid",
                        "value": "live",
                        "domain": ".instagram.com",
                    }
                ]
            },
        )
        with patch(
            "app.instagram._visible_body",
            new=AsyncMock(return_value="instagram home"),
        ), patch("app.instagram._has_authenticated_navigation", new=AsyncMock(return_value=True)):
            outcome, _ = await _login_outcome(page)
        self.assertEqual(outcome, "authenticated")

    def test_only_instagram_origin_is_allowed(self) -> None:
        self.assertEqual(
            instagram_url("/api/v1/feed/user/123/"),
            "https://www.instagram.com/api/v1/feed/user/123/",
        )
        with self.assertRaises(HTTPException) as raised:
            instagram_url("https://example.com/private")
        self.assertEqual(raised.exception.status_code, 422)

    def test_proxy_credentials_are_encoded(self) -> None:
        self.assertEqual(
            proxy_url(
                ProxyConfig(
                    server="http://proxy.example:10000",
                    username="user@example",
                    password="pass/word",
                )
            ),
            "http://user%40example:pass%2Fword@proxy.example:10000",
        )

    def test_only_instagram_cookies_are_forwarded(self) -> None:
        cookies = cookie_values(
            {
                "cookies": [
                    {"name": "sessionid", "value": "good", "domain": ".instagram.com"},
                    {"name": "other", "value": "no", "domain": ".example.com"},
                ]
            }
        )
        self.assertEqual(cookies, {"sessionid": "good"})

    def test_browser_engine_is_present_after_setup(self) -> None:
        self.assertTrue(browser_engine_available())

    def test_identity_uses_the_sealed_firefox_ua_not_a_pool(self) -> None:
        from invisible_core.constants import FIREFOX_UPSTREAM_VERSION, USER_AGENT

        identity = create_identity(CreateIdentityRequest(bot_id="bot-1"))

        self.assertEqual(identity.client, "instagram-firefox-web")
        self.assertEqual(identity.browser_family, "firefox")
        self.assertEqual(identity.browser_version, FIREFOX_UPSTREAM_VERSION)
        self.assertEqual(identity.user_agent, USER_AGENT)
        self.assertEqual(
            identity.http_impersonate,
            f"firefox{FIREFOX_UPSTREAM_VERSION.split('.', 1)[0]}",
        )

    def test_login_probe_contract_rejects_credentials(self) -> None:
        identity = create_identity(CreateIdentityRequest(bot_id="bot-1"))
        probe = InstagramLoginProbeRequest(identity=identity)
        self.assertEqual(probe.timeout_ms, 45_000)

        with self.assertRaises(ValidationError):
            InstagramLoginProbeRequest.model_validate(
                {
                    "identity": identity.model_dump(),
                    "credentials": {"username": "must-not-enter", "password": "secret"},
                }
            )

    def test_http_headers_come_from_identity_and_reject_chrome_overrides(self) -> None:
        identity = create_identity(CreateIdentityRequest(bot_id="bot-1", locale="en-GB"))
        payload = TransportRequest(
            identity=identity,
            request=InstagramRequest(
                path="/graphql/query/?query_hash=dummy",
                referer="/some.profile/",
                headers={"X-IG-WWW-Claim": "0"},
            ),
        )

        headers = instagram_api_headers(payload)
        self.assertEqual(headers["user-agent"], identity.user_agent)
        self.assertEqual(headers["accept-language"], "en-GB,en;q=0.5")
        self.assertEqual(headers["referer"], "https://www.instagram.com/some.profile/")
        self.assertEqual(headers["x-ig-www-claim"], "0")
        self.assertNotIn("sec-ch-ua", headers)

        browser_headers = browser_fetch_headers(payload)
        self.assertNotIn("user-agent", browser_headers)
        self.assertEqual(browser_headers["x-ig-app-id"], "936619743392459")

        payload.request.headers = {"Sec-CH-UA": '"Chromium";v="124"'}
        with self.assertRaises(HTTPException) as raised:
            instagram_api_headers(payload)
        self.assertEqual(raised.exception.status_code, 422)

    def test_post_content_type_is_owned_by_python(self) -> None:
        identity = create_identity(CreateIdentityRequest(bot_id="bot-1"))
        payload = TransportRequest(
            identity=identity,
            request=InstagramRequest(
                method="POST",
                path="/api/v1/friendships/create/123/",
            ),
        )
        self.assertEqual(
            instagram_api_headers(payload)["content-type"],
            "application/x-www-form-urlencoded;charset=UTF-8",
        )
        payload.request.headers = {"Content-Type": "text/plain"}
        with self.assertRaises(HTTPException):
            instagram_api_headers(payload)

    def test_trace_redacts_session_material_but_keeps_useful_header_shape(self) -> None:
        headers = _trace_headers(
            {
                "x-fb-friendly-name": "PolarisScreenTimeLogger_syncMutation",
                "x-fb-lsd": "secret-lsd",
                "x-ig-set-www-claim": "secret-claim",
                "proxy-status": "opaque-provider-diagnostic",
                "content-type": "application/json",
            }
        )
        self.assertEqual(
            headers["x-fb-friendly-name"],
            "PolarisScreenTimeLogger_syncMutation",
        )
        self.assertEqual(headers["x-fb-lsd"], "<redacted>")
        self.assertEqual(headers["x-ig-set-www-claim"], "<redacted>")
        self.assertEqual(headers["proxy-status"], "<redacted>")

        body = _format_trace_body(
            '{"status":"ok","sessionid":"secret-session","profile":{"id":"123"}}'
        )
        self.assertIn('"status": "ok"', body)
        self.assertIn('"id": "123"', body)
        self.assertNotIn("secret-session", body)

    def test_trace_writes_bounded_redacted_transcript_with_owner_only_permissions(self) -> None:
        with TemporaryDirectory() as directory:
            trace_path = Path(directory) / "trace.log"
            with patch.dict(
                "os.environ",
                {
                    "AUTOMATION_TRACE_REQUESTS": "true",
                    "AUTOMATION_TRACE_LOG_PATH": str(trace_path),
                    "AUTOMATION_TRACE_BODY_MAX_BYTES": "4096",
                },
                clear=False,
            ):
                _write_transport_trace(
                    transport="pyhttpz",
                    method="GET",
                    url="https://www.instagram.com/graphql/query/?query_hash=dummy",
                    request_headers={"cookie": "sessionid=secret", "accept": "*/*"},
                    request_body=None,
                    response_status=200,
                    response_headers={"proxy-status": "opaque", "content-type": "application/json"},
                    response_body='{"message":"ok","csrftoken":"secret"}',
                )
            transcript = trace_path.read_text(encoding="utf-8")
            self.assertIn("REQUEST GET https://www.instagram.com/graphql/query/?query_hash=dummy", transcript)
            self.assertIn("RESPONSE status=200", transcript)
            self.assertNotIn("sessionid=secret", transcript)
            self.assertNotIn('"csrftoken": "secret"', transcript)
            self.assertEqual(trace_path.stat().st_mode & 0o777, 0o600)


class WireMeterTest(unittest.IsolatedAsyncioTestCase):
    """The meter is the only report of what a Firefox launch costs on the proxy."""

    @staticmethod
    def request(
        resource_type: str,
        *,
        response_body: int = 0,
        response_headers: int = 0,
        request_body: int = 0,
        request_headers: int = 0,
    ) -> SimpleNamespace:
        return SimpleNamespace(
            resource_type=resource_type,
            sizes=AsyncMock(
                return_value={
                    "requestBodySize": request_body,
                    "requestHeadersSize": request_headers,
                    "responseBodySize": response_body,
                    "responseHeadersSize": response_headers,
                }
            ),
        )

    @staticmethod
    def context() -> SimpleNamespace:
        handlers: dict[str, list] = {}

        def on(event: str, handler) -> None:
            handlers.setdefault(event, []).append(handler)

        return SimpleNamespace(on=on, handlers=handlers)

    @staticmethod
    def finish(context: SimpleNamespace, browser_request: SimpleNamespace) -> None:
        for handler in context.handlers.get("requestfinished", []):
            handler(browser_request)

    async def test_encoded_sizes_are_summed_and_split_by_resource_type(self) -> None:
        meter = _WireMeter()
        context = self.context()
        meter.attach(context)

        self.finish(
            context,
            self.request(
                "document",
                response_body=120_000,
                response_headers=800,
                request_body=0,
                request_headers=1_200,
            ),
        )
        self.finish(
            context,
            self.request("script", response_body=900_000, response_headers=500, request_headers=700),
        )
        self.finish(
            context,
            self.request("script", response_body=100_000, response_headers=500, request_headers=700),
        )
        self.finish(
            context,
            self.request("xhr", response_body=4_000, response_headers=300, request_body=90, request_headers=600),
        )
        await meter.settle()

        self.assertEqual(meter.bytes_in, 120_800 + 900_500 + 100_500 + 4_300)
        self.assertEqual(meter.bytes_out, 1_200 + 700 + 700 + 690)
        self.assertEqual(
            meter.breakdown,
            {"document": 120_800, "script": 1_001_000, "xhr": 4_300},
        )
        self.assertEqual(meter.failed_requests, 0)
        self.assertEqual(
            _wire_top_types(meter.breakdown),
            "script:1001000,document:120800,xhr:4300",
        )

    async def test_snapshot_does_not_alias_the_live_breakdown(self) -> None:
        meter = _WireMeter()
        context = self.context()
        meter.attach(context)
        self.finish(context, self.request("font", response_body=2_000))
        await meter.settle()

        snapshot = meter.snapshot()
        self.finish(context, self.request("font", response_body=3_000))
        await meter.settle()

        self.assertEqual(snapshot, {"font": 2_000})
        self.assertEqual(meter.breakdown, {"font": 5_000})

    async def test_a_request_whose_sizes_are_gone_is_ignored(self) -> None:
        meter = _WireMeter()
        context = self.context()
        meter.attach(context)

        self.finish(context, self.request("image", response_body=50_000, response_headers=200))
        self.finish(
            context,
            SimpleNamespace(
                resource_type="media",
                sizes=AsyncMock(side_effect=RuntimeError("Target page, context or browser has been closed")),
            ),
        )
        self.finish(context, self.request("image", response_body=10_000, response_headers=200))
        await meter.settle()

        self.assertEqual(meter.bytes_in, 60_400)
        self.assertEqual(meter.breakdown, {"image": 60_400})
        self.assertNotIn("media", meter.breakdown)

    async def test_missing_or_negative_size_fields_never_corrupt_the_total(self) -> None:
        meter = _WireMeter()
        context = self.context()
        meter.attach(context)

        self.finish(
            context,
            SimpleNamespace(
                resource_type=None,
                sizes=AsyncMock(
                    return_value={"responseBodySize": -1, "responseHeadersSize": None}
                ),
            ),
        )
        self.finish(context, self.request("stylesheet", response_body=7_000))
        await meter.settle()

        self.assertEqual(meter.bytes_in, 7_000)
        self.assertEqual(meter.bytes_out, 0)
        self.assertEqual(meter.breakdown, {"other": 0, "stylesheet": 7_000})

    async def test_failed_requests_are_counted_but_never_billed(self) -> None:
        meter = _WireMeter()
        context = self.context()
        meter.attach(context)

        for handler in context.handlers.get("requestfailed", []):
            handler(SimpleNamespace(resource_type="image"))
        await meter.settle()

        self.assertEqual(meter.failed_requests, 1)
        self.assertEqual(meter.bytes_in, 0)
        self.assertEqual(meter.breakdown, {})

    async def test_settle_returns_within_its_budget_when_a_lookup_hangs(self) -> None:
        async def never_returns() -> dict:
            await asyncio.sleep(30)
            return {}

        meter = _WireMeter()
        context = self.context()
        meter.attach(context)
        self.finish(context, self.request("document", response_body=1_000))
        self.finish(
            context,
            SimpleNamespace(resource_type="media", sizes=AsyncMock(side_effect=never_returns)),
        )

        started = time.monotonic()
        await meter.settle(timeout_s=0.05)
        elapsed = time.monotonic() - started

        self.assertLess(elapsed, 5.0)
        self.assertEqual(meter.bytes_in, 1_000)

    async def test_attach_survives_a_context_without_request_events(self) -> None:
        def refuse(event: str, handler) -> None:
            raise NotImplementedError(event)

        meter = _WireMeter()
        meter.attach(SimpleNamespace(on=refuse))
        await meter.settle()

        self.assertEqual(meter.bytes_in, 0)
        self.assertEqual(meter.breakdown, {})

    def test_top_types_is_empty_when_nothing_was_measured(self) -> None:
        self.assertEqual(_wire_top_types({}), "")
        self.assertEqual(
            _wire_top_types({"a": 1, "b": 2, "c": 3, "d": 4}),
            "d:4,c:3,b:2",
        )

    def test_transport_response_stays_valid_without_wire_fields(self) -> None:
        response = TransportResponse(status=200, headers={}, body="{}")

        self.assertIsNone(response.wire_bytes_in)
        self.assertIsNone(response.wire_bytes_out)
        self.assertIsNone(response.wire_breakdown)

        measured = TransportResponse(
            status=200,
            headers={},
            body="{}",
            wire_bytes_in=6_100_000,
            wire_bytes_out=41_000,
            wire_breakdown={"script": 4_000_000, "document": 2_100_000},
        )
        self.assertEqual(measured.wire_bytes_in, 6_100_000)
        self.assertEqual(measured.wire_breakdown["script"], 4_000_000)

if __name__ == "__main__":
    unittest.main()

class WireMeterAttachRegressionTest(unittest.IsolatedAsyncioTestCase):
    async def test_attach_registers_closures_not_bound_methods(self) -> None:
        """Playwright's handler wrapper setattr()s onto a bound method's instance.

        A bound method of a __slots__/frozen object made that raise, and attach()
        swallowed it — no wire bytes were ever recorded in production. Register
        plain closures so the wrapper has nothing to decorate.
        """
        from app.instagram import _WireMeter

        registered: list[tuple[str, object]] = []

        class PlaywrightLikeContext:
            def on(self, event: str, handler: object) -> None:
                owner = getattr(handler, "__self__", None)
                if owner is not None:
                    setattr(owner, "_pw_impl_instance__marker", handler)
                registered.append((event, handler))

        meter = _WireMeter()
        meter.attach(PlaywrightLikeContext())
        events = sorted(event for event, _ in registered)
        self.assertEqual(events, ["requestfailed", "requestfinished"])
        for _, handler in registered:
            self.assertFalse(hasattr(handler, "__self__"), "handler must be a closure")
        self.assertFalse(hasattr(type(meter), "__slots__"))
