import copy
import json
import shutil
import subprocess
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from httpz.headers import Headers
from app.identity import create_identity
from app.instagram import cookie_values, instagram_api_headers, request_via_httpz, _login_outcome, _in_page_fetch_script, _navigate_to_login
from app.models import CreateIdentityRequest, InstagramRequest, TransportRequest


def saved_state():
    return {"cookies": [
        {"name": "sessionid", "value": "saved-session", "domain": ".instagram.com", "path": "/", "expires": 4102444800, "secure": True, "httpOnly": True, "sameSite": "None"},
        {"name": "csrftoken", "value": "old-csrf", "domain": ".instagram.com", "path": "/", "expires": 4102444800, "secure": True, "httpOnly": False, "sameSite": "None"},
    ], "origins": [{"origin": "https://www.instagram.com", "localStorage": [{"name": "fixture", "value": "preserved"}]}]}


class SessionContinuityTest(unittest.IsolatedAsyncioTestCase):
    async def test_empty_login_entry_uses_the_same_pages_normal_home_form_once(self):
        page = SimpleNamespace(url='https://www.instagram.com/accounts/login/',
            goto=AsyncMock(side_effect=[RuntimeError('Page.goto: NS_ERROR_NET_EMPTY_RESPONSE'), None]))
        with patch('app.instagram._login_page_rate_limited', new=AsyncMock(return_value=False)):
            await _navigate_to_login(page, 60000)
        self.assertEqual([call.args[0] for call in page.goto.await_args_list],
            ['https://www.instagram.com/accounts/login/', 'https://www.instagram.com/'])

    async def test_login_entry_does_not_retry_rate_limited_or_challenged_pages(self):
        for url, rate_limited in [('https://www.instagram.com/challenge/verification/',False),
                                  ('https://www.instagram.com/accounts/login/',True)]:
            page=SimpleNamespace(url=url,goto=AsyncMock(side_effect=RuntimeError('NS_ERROR_NET_EMPTY_RESPONSE')))
            with patch('app.instagram._login_page_rate_limited', new=AsyncMock(return_value=rate_limited)):
                with self.assertRaises(RuntimeError): await _navigate_to_login(page, 60000)
            self.assertEqual(page.goto.await_count,1)

    async def test_login_entry_does_not_reinterpret_another_browser_failure(self):
        page=SimpleNamespace(url='https://www.instagram.com/accounts/login/',goto=AsyncMock(side_effect=RuntimeError('connection refused')))
        with self.assertRaises(RuntimeError): await _navigate_to_login(page, 60000)
        self.assertEqual(page.goto.await_count,1)

    async def test_successful_navigation_does_not_open_a_second_login_page(self):
        page=SimpleNamespace(goto=AsyncMock(return_value=SimpleNamespace(status=200)))
        await _navigate_to_login(page, 30000)
        page.goto.assert_awaited_once_with('https://www.instagram.com/accounts/login/',wait_until='commit',timeout=30000)

    def payload(self):
        return TransportRequest(identity=create_identity(CreateIdentityRequest(bot_id="continuity-test")),
            storage_state=saved_state(), request=InstagramRequest(path="/api/v1/feed/reels_media/?reel_ids=123",
                headers={"x-csrftoken": "stale-header"}))

    async def response(self, headers, cookies=None):
        payload = self.payload()
        original = copy.deepcopy(payload.storage_state)
        fake = SimpleNamespace(status_code=200, headers=Headers(headers), text='{"status":"ok"}',
            content=b'{"status":"ok"}', cookies=cookies or {}, url="https://www.instagram.com/api/v1/feed/reels_media/")
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.request.return_value = fake
        with patch("httpz.AsyncClient", return_value=client):
            result = await request_via_httpz(payload)
        self.assertEqual(payload.storage_state, original)
        return result

    def test_current_cookie_overrides_a_stale_csrf_header(self):
        self.assertEqual(instagram_api_headers(self.payload())["x-csrftoken"], "old-csrf")

    async def test_http_response_preserves_refreshed_cookie_attributes_and_storage(self):
        result = await self.response([
            ("Set-Cookie", "csrftoken=fresh-csrf; Domain=.instagram.com; Path=/; Max-Age=3600; Secure; SameSite=None"),
            ("Set-Cookie", 'rur="REGION\\054fixture"; Domain=.instagram.com; Path=/; Secure; HttpOnly; SameSite=Lax'),
        ], {"csrftoken": "fresh-csrf"})
        self.assertIsNotNone(result.storage_state)
        cookies = {c["name"]: c for c in result.storage_state["cookies"]}
        self.assertEqual(cookies["csrftoken"]["value"], "fresh-csrf")
        self.assertGreater(cookies["csrftoken"]["expires"], time.time())
        self.assertLess(cookies["csrftoken"]["expires"], time.time() + 3601)
        self.assertEqual(cookies["rur"]["value"], '"REGION\\054fixture"')
        self.assertTrue(cookies["rur"]["httpOnly"])
        self.assertEqual(cookies["sessionid"]["value"], "saved-session")
        self.assertEqual(result.storage_state["origins"], saved_state()["origins"])

    async def test_deleted_session_is_not_restored_from_the_flat_cookie_map(self):
        result = await self.response([("set-cookie", "sessionid=; Max-Age=0; Domain=.instagram.com; Path=/")],
            {"sessionid": "saved-session"})
        self.assertNotIn("sessionid", cookie_values(result.storage_state))

    async def test_foreign_cookie_domain_cannot_replace_instagram_session(self):
        result = await self.response([("set-cookie", "sessionid=foreign; Domain=notinstagram.com; Path=/")])
        self.assertEqual(cookie_values(result.storage_state)["sessionid"], "saved-session")

    async def test_existing_redirect_cookie_can_be_refreshed_without_losing_scope(self):
        result = await self.response([], {"csrftoken": "fresh-csrf"})
        csrf = next(c for c in result.storage_state["cookies"] if c["name"] == "csrftoken")
        self.assertEqual(csrf, {**saved_state()["cookies"][1], "value": "fresh-csrf"})

    def test_expired_and_lookalike_domain_cookies_are_not_forwarded(self):
        state = {"cookies": [
            {"name": "valid", "value": "yes", "domain": ".instagram.com", "expires": -1},
            {"name": "expired", "value": "no", "domain": ".instagram.com", "expires": 1},
            {"name": "fake", "value": "no", "domain": ".notinstagram.com"},
        ]}
        self.assertEqual(cookie_values(state), {"valid": "yes"})

    async def test_saved_session_cookie_does_not_prove_a_visible_login_screen_is_authenticated(self):
        control = SimpleNamespace(count=AsyncMock(return_value=1), nth=lambda _: SimpleNamespace(is_visible=AsyncMock(return_value=True)))
        page = SimpleNamespace(url="https://www.instagram.com/", locator=lambda _: control,
            context=SimpleNamespace(storage_state=AsyncMock(return_value=saved_state())))
        with patch("app.instagram._visible_body", new=AsyncMock(return_value="Continue Use another profile")), \
             patch("app.instagram._has_login_error_alert", new=AsyncMock(return_value=False)):
            outcome, _ = await _login_outcome(page)
        self.assertEqual(outcome, "pending")

    @unittest.skipUnless(shutil.which('node'), 'Node is required for the browser bridge execution test')
    def test_browser_bridge_reads_current_document_csrf_after_navigation(self):
        script = _in_page_fetch_script({"url":"https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=123",
            "method":"GET", "headers":{"x-csrftoken":"old-csrf"}, "timeoutMs":1000})
        harness = r'''
const vm = require('node:vm');
let emitted;
const document = {readyState: 'complete', cookie: 'csrftoken=current-csrf; irrelevant=value',
  documentElement: {setAttribute: (_name, value) => {emitted = JSON.parse(Buffer.from(value, 'base64').toString());}}};
const window = {setTimeout, clearTimeout}; window.top = window;
const sandbox = {window, document, location: {origin:'https://www.instagram.com'}, AbortController,
  btoa: s => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent, decodeURIComponent,
  fetch: async (_url, options) => ({status:200, url:_url, redirected:false, headers: new Map(),
    text: async () => JSON.stringify({csrf: options.headers['x-csrftoken'], credentials:options.credentials})})};
vm.runInNewContext(SOURCE, sandbox);
setTimeout(() => {console.log(JSON.stringify(emitted));}, 20);
'''.replace('SOURCE', json.dumps(script))
        result = subprocess.run(['node', '-e', harness], capture_output=True, text=True, check=True, timeout=5)
        data = json.loads(result.stdout)
        self.assertEqual(json.loads(data['body']), {'csrf':'current-csrf', 'credentials':'include'})


if __name__ == "__main__":
    unittest.main()
