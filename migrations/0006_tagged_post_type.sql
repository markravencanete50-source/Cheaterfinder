-- Wave 4: tagged_post variant.
--
-- Posts where the tracked user has been *tagged* by another account come
-- from a different IG endpoint (usertags/<pk>/feed/) than the user's own
-- grid posts. We stash them in posts_cache alongside the owner's posts so
-- the dashboard can render a single "feed" view, but tagged posts need a
-- distinct post_type so the UI can label them ("Tagged in this post by ...")
-- and so we don't confuse them with the user's authored content during
-- analytics.

ALTER TYPE post_type ADD VALUE IF NOT EXISTS 'tagged_post';
