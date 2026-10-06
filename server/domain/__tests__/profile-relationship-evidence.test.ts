import { describe, expect, it } from "vitest";
import { parseProfileInfoResponse, parseProfileResponse } from "../ig-schemas.js";

describe("profile relationship evidence", () => {
  it.each([true, false])("preserves an explicit web relationship of %s", following => {
    expect(parseProfileResponse({ data: { user: {
      id: "123", username: "private_fixture", followed_by_viewer: following,
    } } })).toMatchObject({ followedByViewer: following, viewerRelationshipKnown: true });
  });

  it.each([true, false])("preserves an explicit mobile relationship of %s", following => {
    expect(parseProfileInfoResponse({ user: {
      pk: "123", username: "private_fixture", friendship_status: { following },
    } })).toMatchObject({ followedByViewer: following, viewerRelationshipKnown: true });
  });

  it("does not treat missing relationship fields as proof that approval ended", () => {
    expect(parseProfileResponse({ data: { user: { id: "123", username: "private_fixture" } } }))
      .toMatchObject({ followedByViewer: false, viewerRelationshipKnown: false });
    for (const friendship_status of [undefined, null, {}, { outgoing_request: false }]) {
      expect(parseProfileInfoResponse({ user: { pk: "123", username: "private_fixture", friendship_status } }))
        .toMatchObject({ followedByViewer: false, viewerRelationshipKnown: false });
    }
  });
});
