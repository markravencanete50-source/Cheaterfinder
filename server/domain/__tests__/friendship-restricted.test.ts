// Instagram withholds follower/following lists from low-trust viewing bots with
// a `special_empty_state` payload and zero users. That must be flagged as
// `restricted`, NOT parsed as a genuinely-empty list — otherwise the roster
// settles at 0 and the account is shown as following nobody (@tracked_user_1: public,
// 1,405 following, but every read returned this state).

import { describe, it, expect } from "vitest";
import {
  parseFriendshipPageResponse,
  parseGraphqlFriendshipPageResponse,
} from "../ig-schemas.js";

describe("parseFriendshipPageResponse — restricted detection", () => {
  it("flags a special_empty_state + zero users as restricted", () => {
    const page = parseFriendshipPageResponse({
      users: [],
      status: "ok",
      has_more: false,
      special_empty_state: {
        title: "Keine Ergebnisse",
        body: "we limit certain things you can see, like another person's follower or following lists.",
      },
    });
    expect(page.restricted).toBe(true);
    expect(page.users).toEqual([]);
  });

  it("a genuinely empty list (no special_empty_state) is NOT restricted", () => {
    const page = parseFriendshipPageResponse({ users: [], status: "ok" });
    expect(page.restricted).toBe(false);
  });

  it("a normal populated page is not restricted", () => {
    const page = parseFriendshipPageResponse({
      users: [{ pk: "123", username: "someone", full_name: "Some One" }],
      next_max_id: "abc",
      big_list: true,
    });
    expect(page.restricted).toBe(false);
    expect(page.users).toHaveLength(1);
    expect(page.nextMaxId).toBe("abc");
  });

  it("flags the populated limited preview instead of treating it as an exhausted full list", () => {
    const page = parseFriendshipPageResponse({
      users: [{ pk: "123", username: "preview_member" }],
      should_limit_list_of_followers: true, has_more: false, big_list: false, status: "ok",
    });
    expect(page.users).toHaveLength(1);
    expect(page.restricted).toBe(true);
    expect(page.nextMaxId).toBeNull();
  });

  it("an explicitly unrestricted populated list retains normal behaviour", () => {
    const page = parseFriendshipPageResponse({
      users: [{ pk: "123", username: "real_member" }],
      should_limit_list_of_followers: false, next_max_id: "NEXT",
    });
    expect(page.restricted).toBe(false);
    expect(page.nextMaxId).toBe("NEXT");
  });
});

describe("parseGraphqlFriendshipPageResponse", () => {
  it("maps follower connection nodes and its continuation cursor", () => {
    const page = parseGraphqlFriendshipPageResponse(
      {
        data: {
          user: {
            edge_followed_by: {
              edges: [
                {
                  node: {
                    id: "456",
                    username: "real_follower",
                    full_name: "Real Follower",
                    is_verified: true,
                    profile_pic_url: "https://example.test/avatar.jpg",
                  },
                },
              ],
              page_info: { has_next_page: true, end_cursor: "cursor-2" },
            },
          },
        },
      },
      "followers",
    );

    expect(page.restricted).toBe(false);
    expect(page.nextMaxId).toBe("cursor-2");
    expect(page.users).toEqual([
      {
        pk: "456",
        username: "real_follower",
        fullName: "Real Follower",
        isPrivate: false,
        isVerified: true,
        profilePicUrl: "https://example.test/avatar.jpg",
      },
    ]);
  });

  it("maps the following connection and ends when has_next_page is false", () => {
    const page = parseGraphqlFriendshipPageResponse(
      {
        data: {
          user: {
            edge_follow: {
              edges: [{ node: { id: "789", username: "followed_user" } }],
              page_info: { has_next_page: false, end_cursor: "ignored" },
            },
          },
        },
      },
      "following",
    );

    expect(page.nextMaxId).toBeNull();
    expect(page.users[0]?.username).toBe("followed_user");
  });
});
