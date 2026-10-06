import unittest
import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from app.public_native import (PublicCapture, NativeReadFailure, PROFILE_OPERATION, POSTS_OPERATION, POSTS_PAGE_OPERATION,
                               HIGHLIGHTS_OPERATION, FEED_KEY, embedded_reels, validate_reel, instagram_page_path, read_native_public)
from app.models import AutomationIdentity, NativePublicReadRequest, ProxyConfig


def profile(private=False, count=2):
    return {"data": {"user": {"id": "123", "pk": "123", "username": "cafe_test", "is_private": private,
        "follower_count": 1500, "following_count": 20, "media_count": count, "latest_reel_media": 0},
        "viewer": {"secret": "must-not-cross-boundary"}}}


def feed(more=False, owner="cafe_test"):
    return {"data": {FEED_KEY: {"edges": [{"node": {"pk": "900", "id": "900_123", "code": "abc", "user": {"username": owner}, "media_type": 1, "taken_at": 1790000000, "like_count": 2, "comment_count": 0}}],
                                     "page_info": {"has_next_page": more}}}}


class PublicNativeTests(unittest.TestCase):
    def test_navigation_requires_the_exact_https_instagram_origin(self):
        self.assertEqual(instagram_page_path('https://www.instagram.com/cafe_test/'), '/cafe_test/')
        for url in ('https://unrelated.invalid/cafe_test/', 'http://www.instagram.com/cafe_test/',
                    'https://www.instagram.com.unrelated.invalid/cafe_test/', 'https://www.instagram.com:8443/cafe_test/'):
            with self.assertRaisesRegex(NativeReadFailure, 'origin_mismatch'):
                instagram_page_path(url)

    def test_http_rejection_does_not_invent_session_expiry(self):
        for status in (401, 403):
            c = self.make_capture(); c.accept(POSTS_OPERATION, status, None)
            self.assertEqual(c.failure.reason, 'request_rejected')
            c = self.make_capture(); c.accept(POSTS_OPERATION, status, {'message': 'challenge_required'})
            self.assertEqual(c.failure.reason, 'challenge_required')

    def make_capture(self):
        c = PublicCapture("cafe_test", "123")
        c.accept(PROFILE_OPERATION, 200, profile())
        return c

    def test_profile_discards_viewer_and_validates_identity(self):
        c = self.make_capture()
        self.assertEqual(c.result("profile", 12)["user"]["username"], "cafe_test")
        self.assertNotIn("viewer", c.result("profile", 12))
        bad = PublicCapture("other", "123")
        bad.accept(PROFILE_OPERATION, 200, profile())
        with self.assertRaisesRegex(NativeReadFailure, "profile_identity_mismatch"):
            bad.result("profile", 12)

    def test_explicit_relationship_flags_are_preserved_without_inventing_unknown_flags(self):
        c = self.make_capture()
        self.assertNotIn("friendship_status", c.result("profile", 12)["user"])
        known = profile(private=True)
        known["data"]["user"].update(followed_by_viewer=False, requested_by_viewer=True)
        c.accept(PROFILE_OPERATION, 200, known)
        self.assertEqual(c.result("profile", 12)["user"]["friendship_status"], {"following": False, "outgoing_request": True})
        known["data"]["user"]["friendship_status"] = {"following": True}
        c.accept(PROFILE_OPERATION, 200, known)
        with self.assertRaisesRegex(NativeReadFailure, "native_relationship_conflict"):
            c.result("profile", 12)

    def test_numeric_id_mismatch_fails(self):
        c = PublicCapture("cafe_test", "456")
        c.accept(PROFILE_OPERATION, 200, profile())
        self.assertEqual(c.failure.reason, "profile_identity_mismatch")

    def test_pagination_is_not_silently_treated_as_complete(self):
        c = self.make_capture(); c.accept(POSTS_OPERATION, 200, feed(more=True))
        with self.assertRaisesRegex(NativeReadFailure, "native_posts_incomplete"):
            c.result("posts", 24)
        self.assertEqual(len(c.result("posts", 1)["items"]), 1)
        self.assertIsNone(c.result("posts", 1)["next_max_id"])

    def test_deduplicates_repeated_native_pages(self):
        c = self.make_capture()
        c.accept(POSTS_OPERATION, 200, feed());c.accept(POSTS_OPERATION, 200, feed())
        self.assertEqual(len(c.result("posts", 12)["items"]), 1)

    def test_native_pagination_operation_adds_posts_instead_of_losing_next_page(self):
        c = self.make_capture(); c.accept(POSTS_OPERATION, 200, feed(more=True))
        second = feed(); second["data"][FEED_KEY]["edges"][0]["node"].update(pk="901", id="901_123", code="def")
        c.accept(POSTS_PAGE_OPERATION, 200, second)
        self.assertEqual(len(c.result("posts", 24)["items"]), 2)
        self.assertFalse(c.result("posts", 24)["more_available"])
        self.assertTrue(c.result("posts", 1)["more_available"])

    def test_wrong_post_owner_cannot_pollute_target(self):
        c = self.make_capture(); c.accept(POSTS_OPERATION, 200, feed(owner="someone_else"))
        with self.assertRaisesRegex(NativeReadFailure, "post_owner_mismatch"):
            c.result("posts", 12)

    def test_missing_counts_cannot_turn_into_false_zero_metrics(self):
        c = self.make_capture(); bad = feed()
        del bad["data"][FEED_KEY]["edges"][0]["node"]["like_count"]
        c.accept(POSTS_OPERATION, 200, bad)
        with self.assertRaisesRegex(NativeReadFailure, "native_post_metrics_missing"):c.result("posts", 12)

    def test_private_profile_content_is_not_read(self):
        c = self.make_capture(); c.accept(PROFILE_OPERATION, 200, profile(private=True))
        self.assertTrue(c.result("profile", 12)["user"]["is_private"])
        with self.assertRaisesRegex(NativeReadFailure, "private_profile_not_supported"):
            c.result("posts", 12)

    def test_provider_restrictions_stay_failures(self):
        for status in (401, 403, 429):
            c = self.make_capture(); c.accept(POSTS_OPERATION, status, {})
            self.assertEqual(c.failure.status, status)
            with self.assertRaises(NativeReadFailure):c.result("posts", 12)

    def test_http_200_graphql_error_is_not_success(self):
        c = self.make_capture(); c.accept(POSTS_OPERATION, 200, {"errors": [{"message": "failed"}]})
        with self.assertRaises(NativeReadFailure):c.result("posts", 12)

    def test_missing_feed_is_not_empty_feed(self):
        c = self.make_capture()
        with self.assertRaisesRegex(NativeReadFailure, "native_posts_response_missing"):c.result("posts", 12)

    def test_real_empty_profile_feed_is_supported(self):
        c = self.make_capture();c.accept(PROFILE_OPERATION, 200, profile(count=0))
        c.accept(POSTS_OPERATION, 200, {"data": {FEED_KEY: {"edges": [], "page_info": {"has_next_page": False}}}})
        self.assertEqual(c.result("posts", 12)["items"], [])

    def test_highlight_index_requires_owner_and_complete_connection(self):
        c = self.make_capture()
        node = {"id": "highlight:900", "title": "Coffee", "user": {"username": "cafe_test"}}
        c.accept(HIGHLIGHTS_OPERATION, 200, {"data": {"highlights": {"edges": [{"node": node}], "page_info": {"has_next_page": False}}}})
        self.assertEqual(c.highlights[0]["id"], "highlight:900")
        self.assertNotIn("media_count", c.highlights[0])
        c.accept(HIGHLIGHTS_OPERATION, 200, {"data": {"highlights": {"edges": [], "page_info": {"has_next_page": True}}}})
        self.assertEqual(c.failure.reason, "native_highlights_incomplete")

    def test_story_bootstrap_only_returns_exact_public_reel(self):
        reel = {"id": "123", "items": [{"id": "901", "media_type": 1, "viewers": [{"private": True}]}],
                "user": {"pk": "123", "username": "cafe_test", "is_private": False}}
        raw = {"require": [{"data": {"xdt_api__v1__feed__reels_media": {"reels_media": [reel]}}}]}
        extracted = list(embedded_reels(raw))
        self.assertEqual(len(extracted), 1)
        checked = validate_reel(extracted[0], "123", "cafe_test", "123")
        self.assertNotIn("viewers", checked["items"][0])
        self.assertIsNone(validate_reel(reel, "999", "cafe_test", "123"))
        reel["user"]["is_private"] = True
        with self.assertRaisesRegex(NativeReadFailure, "reel_owner_mismatch"):validate_reel(reel, "123", "cafe_test", "123")


class NativeUiRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_read_consumes_normal_navigation_responses_without_injected_fetch(self):
        handler = None
        navigations = []
        class Page:
            url = 'https://www.instagram.com/cafe_test/'
            def on(self, event, callback):
                nonlocal handler
                self.assert_event = event
                handler = callback
            async def goto(self, url, **_):
                navigations.append(url)
                for operation, data in ((PROFILE_OPERATION, profile()), (POSTS_OPERATION, feed())):
                    handler(SimpleNamespace(url='https://www.instagram.com/graphql/query', status=200,
                        request=SimpleNamespace(post_data=f'fb_api_req_friendly_name={operation}'),
                        json=AsyncMock(return_value=data)))
                return SimpleNamespace(status=200)
            async def wait_for_timeout(self, _):
                await asyncio.sleep(0)
            async def evaluate(self, *_):
                raise AssertionError('Native UI must not execute injected fetch')
            async def add_init_script(self, *_):
                raise AssertionError('Native UI must not install an API bridge')
        context = SimpleNamespace(new_page=AsyncMock(return_value=Page()), storage_state=AsyncMock(return_value={'cookies': []}))
        @asynccontextmanager
        async def borrow(*_, **__):
            yield SimpleNamespace(context=context), False
        payload = NativePublicReadRequest(identity=AutomationIdentity(bot_id='viewer-1', browser_seed=123,
            browser_version='151.0', user_agent='Mozilla/5.0 Firefox/151.0', http_impersonate='firefox151', ja3='fixture', h2_fingerprint='fixture'),
            storage_state={'cookies': []}, proxy=ProxyConfig(server='http://proxy.invalid:10001'),
            target_username='cafe_test', target_user_id='123', kind='posts', max_items=1)
        with patch('app.public_native.browser_pool.borrow', side_effect=borrow), \
             patch('app.public_native.ensure_supported_identity'), \
             patch('app.public_native._has_authenticated_navigation', new=AsyncMock(return_value=True)):
            result = await read_native_public(payload)
        self.assertEqual(result.status, 200)
        self.assertEqual(json.loads(result.body)['items'][0]['code'], 'abc')
        self.assertEqual(navigations, ['https://www.instagram.com/cafe_test/'])


if __name__ == "__main__":unittest.main()
