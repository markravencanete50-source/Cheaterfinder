import { describe, expect, it } from "vitest";
import { IGSchemaError } from "../ig-client-port.js";
import {
  parseClipsResponse, parseCommentsResponse, parseFeedResponse,
  parseFriendshipPageResponse, parseFriendshipStatusResponse,
  parseGraphqlFriendshipPageResponse, parseLikersResponse,
  parseProfileInfoResponse, parseProfileResponse,
} from "../ig-schemas.js";

const endpoints = [
  ["feed", parseFeedResponse, "items"],
  ["clips", parseClipsResponse, "items"],
  ["friendships", parseFriendshipPageResponse, "users"],
  ["comments", parseCommentsResponse, "comments"],
  ["likers", parseLikersResponse, "users"],
] as const;

describe("upstream collection response completeness", () => {
  for (const [name, parse, key] of endpoints) {
    it(`${name} accepts an explicitly empty collection`, () => {
      expect(() => parse({ status: "ok", [key]: [] })).not.toThrow();
    });
    it.each([{}, { status: "ok" }, { status: "fail" }, { [key]: null }])(
      `${name} rejects missing collection data: %j`, raw => {
        expect(() => parse(raw)).toThrow(IGSchemaError);
      },
    );
    it.each([{ status: "fail" }, { success: false }, { errors: [{ message: "denied" }] }])(
      `${name} rejects a failed envelope even with a collection: %j`, error => {
        expect(() => parse({ [key]: [], ...error })).toThrow(IGSchemaError);
      },
    );
  }
  it("does not silently drop a malformed clip wrapper", () => {
    expect(() => parseClipsResponse({ items: [{}] })).toThrow(IGSchemaError);
  });
  it("requires GraphQL roster edges even when page_info is present", () => {
    expect(() => parseGraphqlFriendshipPageResponse({ data: { user: {
      edge_followed_by: { page_info: { has_next_page: false } },
    } } }, "followers")).toThrow(IGSchemaError);
    expect(parseGraphqlFriendshipPageResponse({ data: { user: {
      edge_followed_by: { edges: [], page_info: { has_next_page: false } },
    } } }, "followers").users).toEqual([]);
  });
  it("does not accept a failure response as a profile or confirmed follow state", () => {
    expect(() => parseProfileResponse({ status: "fail", data: { user: { id: "1" } } })).toThrow(IGSchemaError);
    expect(() => parseProfileInfoResponse({ status: "fail", user: { pk: "1" } })).toThrow(IGSchemaError);
    expect(() => parseFriendshipStatusResponse({ status: "fail", friendship_status: { following: true } })).toThrow(IGSchemaError);
  });
  it.each([{}, { status: "ok" }, { friendship_status: {} }])("requires evidence of the follow state: %j", raw => {
    expect(() => parseFriendshipStatusResponse(raw)).toThrow(IGSchemaError);
  });
  it("preserves explicit no-follow and requested-follow states", () => {
    expect(parseFriendshipStatusResponse({ friendship_status: { following: false, outgoing_request: false } }))
      .toMatchObject({ following: false, outgoingRequest: false });
    expect(parseFriendshipStatusResponse({ friendship_status: { outgoing_request: true } }))
      .toMatchObject({ following: false, outgoingRequest: true });
  });
});
