import unittest
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.identity import create_identity
from app.instagram import _WireMeter, _response_url_class, request_via_browser, request_via_httpz
from app.models import CreateIdentityRequest, InstagramRequest, TransportRequest


class ResponseDiagnosticsTest(unittest.IsolatedAsyncioTestCase):
    def test_final_urls_become_fixed_classes_only(self):
        examples = {
            "https://www.instagram.com/accounts/login/?next=%2Fprivate-user%2F&token=secret": "login",
            "https://instagram.com/challenge/private-id/secret/": "challenge",
            "https://www.instagram.com/checkpoint/secret/": "challenge",
            "https://www.instagram.com/accounts/suspended/": "suspended",
            "https://www.instagram.com/api/v1/feed/timeline/?secret=value": "instagram_api",
            "https://www.instagram.com/graphql/query/": "instagram_api",
            "https://www.instagram.com/": "instagram_home",
            "https://www.instagram.com/private-user/": "instagram_other",
            "https://instagram.com.attacker.invalid/accounts/login/": "external",
            "/accounts/login/": "unknown",
            "https://[invalid": "unknown",
            "": "unknown",
        }
        for url, expected in examples.items():
            with self.subTest(expected=expected):
                self.assertEqual(_response_url_class(url), expected)
        self.assertEqual(_response_url_class(None), "unknown")

    async def test_actual_http_adapter_exposes_login_class_without_redirect_url(self):
        identity = create_identity(CreateIdentityRequest(bot_id="test-bot"))
        payload = TransportRequest(identity=identity, request=InstagramRequest(path="/api/v1/feed/timeline/", method="POST"))
        fake = SimpleNamespace(
            status_code=200, headers={"content-type": "text/html"}, text="<title>Instagram</title>",
            content=b"<title>Instagram</title>", cookies={},
            url="https://www.instagram.com/accounts/login/?next=/private-user/&token=secret",
        )
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.request.return_value = fake
        with patch("httpz.AsyncClient", return_value=client):
            result = await request_via_httpz(payload)
        self.assertEqual(result.response_url_class, "login")
        self.assertTrue(result.response_redirected)
        self.assertNotIn("private-user", result.model_dump_json())
        self.assertNotIn("secret", result.model_dump_json())
        client.request.assert_awaited_once()

    async def test_actual_browser_adapter_returns_only_the_verified_redirect_class(self):
        identity = create_identity(CreateIdentityRequest(bot_id="test-bot"))
        payload = TransportRequest(identity=identity, request=InstagramRequest(path="/api/v1/feed/timeline/", method="POST"))
        entry = SimpleNamespace(context=object(), meter=_WireMeter(), session_keys=set(), calls=0)

        @asynccontextmanager
        async def borrow(*args, **kwargs):
            # Never invoke the browser factory passed by the real adapter.
            yield entry, False

        raw = {"status": 200, "headers": {"content-type": "text/html"}, "body": "<title>Instagram</title>",
               "response_url": "https://www.instagram.com/accounts/login/?next=/private-user/&token=secret", "redirected": True}
        bridge = AsyncMock(return_value=(raw, None))
        with patch("app.instagram.browser_pool", SimpleNamespace(borrow=borrow, max_calls=5)), \
                patch("app.instagram._fetch_with_document_bridge", bridge):
            result = await request_via_browser(payload)
        self.assertEqual(result.response_url_class, "login")
        self.assertTrue(result.response_redirected)
        self.assertNotIn("private-user", result.model_dump_json())
        self.assertNotIn("secret", result.model_dump_json())
        bridge.assert_awaited_once()
        self.assertEqual(entry.calls, 5)  # A logged-out HTML context is not reused.


if __name__ == "__main__":
    unittest.main()
