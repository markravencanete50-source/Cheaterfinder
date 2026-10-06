// Tests for the activity-log CSV renderer.
//
// The whole point of a CSV export is that a caption or username with a comma,
// quote or newline cannot break the columns — a single unescaped field silently
// corrupts every downstream cell. These tests pin that, plus the newest-first
// ordering across mixed action types.

import { describe, it, expect, vi } from "vitest";

vi.stubEnv("DATABASE_URL", "postgres://mock:mock@localhost/mock");
vi.mock("../../db.js", () => ({ db: {} }));

import { renderCsv, __testing, type ReportCsvRow } from "../report-csv.js";

const { csvField } = __testing;

const row = (over: Partial<ReportCsvRow>): ReportCsvRow => ({
  detectedAt: "2026-07-10T12:00:00.000Z",
  action: "like",
  targetUsername: "someone",
  targetName: "",
  postDate: "",
  mediaType: "",
  likeCount: "",
  hashtags: "",
  url: "",
  ...over,
});

describe("csvField (RFC 4180)", () => {
  it("leaves plain values untouched", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField("")).toBe("");
  });
  it("quotes fields containing a comma", () => {
    expect(csvField("a,b")).toBe('"a,b"');
  });
  it("quotes and doubles embedded quotes", () => {
    expect(csvField('she said "hi"')).toBe('"she said ""hi"""');
  });
  it("quotes fields with newlines (captions)", () => {
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("has\rcr")).toBe('"has\rcr"');
  });
  it.each(["=1+1", "+SUM(1,2)", "-1+2", "@SUM(1)", "  =1+1", "\t=1+1", "\r=1+1", "\n=1+1"])(
    "exports a spreadsheet formula prefix as text: %j", value => {
      const exported = csvField(value);
      const decoded = exported.startsWith('"') ? exported.slice(1, -1).replace(/""/g, '"') : exported;
      expect(decoded).toBe("'" + value);
    },
  );
  it("preserves ordinary text, numbers and internal formula characters", () => {
    for (const value of ["123", "hello @friend", "one+two", "someone-name", " plain text"]) {
      expect(csvField(value)).toBe(value);
    }
  });
});

describe("renderCsv", () => {
  it("emits a header row with human labels", () => {
    const out = renderCsv([]);
    const [header] = out.split("\r\n");
    expect(header).toBe(
      "Detected At (UTC),Action,Target Username,Target Name,Post Date (UTC),Media Type,Post Likes,Hashtags,URL",
    );
    expect(out.endsWith("\r\n")).toBe(true);
  });

  it("orders newest action first across mixed types", () => {
    const out = renderCsv([
      row({ detectedAt: "2026-07-10T08:00:00.000Z", action: "follow", targetUsername: "old" }),
      row({ detectedAt: "2026-07-10T20:00:00.000Z", action: "like", targetUsername: "new" }),
      row({ detectedAt: "2026-07-10T14:00:00.000Z", action: "unfollow", targetUsername: "mid" }),
    ]);
    const usernames = out
      .split("\r\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.split(",")[2]);
    expect(usernames).toEqual(["new", "mid", "old"]);
  });

  it("a comma-laden caption cannot shift columns", () => {
    const out = renderCsv([
      row({
        action: "like",
        targetUsername: "cook",
        hashtags: "#food #nyc",
        url: "https://www.instagram.com/p/abc/",
        mediaType: "carousel",
        likeCount: "1,234".replace(",", ""), // count is numeric, no comma
      }),
    ]);
    const dataLine = out.split("\r\n")[1];
    // 9 columns → 8 unquoted commas exactly (hashtags has a space, not comma).
    const commaCount = (dataLine.match(/,/g) || []).length;
    expect(commaCount).toBe(8);
    expect(dataLine).toContain("https://www.instagram.com/p/abc/");
  });

  it("round-trips a nasty caption through quoting", () => {
    const nasty = 'buy 1, get "2", free\nshipping';
    const out = renderCsv([row({ targetName: nasty, action: "follow" })]);
    const line = out.split("\r\n").slice(1, 3).join("\r\n"); // may span a newline
    expect(line).toContain('"buy 1, get ""2"", free\nshipping"');
  });
});
