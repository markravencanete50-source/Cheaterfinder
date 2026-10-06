import { describe, expect, it } from "vitest";

import { registerSchema, updateProfileSchema } from "../../shared/validation.js";

/**
 * The server used to accept any non-empty name, which is how "Zohaib++++ 2323"
 * and "++++++++(((((+" got into the users table. These pin the rule that closed
 * that, on both the paths that write a name.
 *
 * The accept cases matter as much as the reject cases: the obvious `[A-Za-z ]`
 * fix would pass every rejection test here and lock out customers called José
 * or Иван, so those names are asserted explicitly.
 */

const VALID_REGISTRATION = {
  email: "person@example.com",
  password: "12345678",
};

/** First message for a field, or undefined when the field validated. */
function messageFor(result: ReturnType<typeof registerSchema.safeParse>, field: string) {
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path[0] === field)?.message;
}

const REAL_NAMES = [
  "Ada Lovelace",
  "José Álvarez",
  "Gonçalves",
  "Иван Петров",
  "Zoë Müller",
  "Mary-Jane O'Neil",
  "Anne-Marie O’Brien",
  "J. R. Ewing",
];

const JUNK_NAMES = [
  "Zohaib++++ 2323",
  "++++++++(((((+",
  "Kalez Owner 22323",
  "Test2",
  "bob@example.com",
  "Ada!",
  "Ada_Lovelace",
  "<script>alert(1)</script>",
  "12345",
];

describe("registerSchema.name", () => {
  it.each(REAL_NAMES)("accepts %s", (name) => {
    expect(registerSchema.safeParse({ ...VALID_REGISTRATION, name }).success).toBe(true);
  });

  it.each(JUNK_NAMES)("refuses %s", (name) => {
    const result = registerSchema.safeParse({ ...VALID_REGISTRATION, name });
    expect(result.success).toBe(false);
    expect(messageFor(result, "name")).toBe(
      "Name can only contain letters, spaces, hyphens and apostrophes",
    );
  });

  it("still trims, and reports an empty name as required", () => {
    expect(
      registerSchema.safeParse({ ...VALID_REGISTRATION, name: "  Ada  " }).data?.name,
    ).toBe("Ada");

    for (const name of ["", "   "]) {
      expect(messageFor(registerSchema.safeParse({ ...VALID_REGISTRATION, name }), "name")).toBe(
        "Name is required",
      );
    }
  });

  it("caps the name at 50 characters, measured after trimming", () => {
    expect(
      registerSchema.safeParse({ ...VALID_REGISTRATION, name: "a".repeat(50) }).success,
    ).toBe(true);
    expect(
      messageFor(registerSchema.safeParse({ ...VALID_REGISTRATION, name: "a".repeat(51) }), "name"),
    ).toBe("Name must be 50 characters or less");
  });

  it("reports exactly one problem, so the client never shows two contradictory messages", () => {
    const result = registerSchema.safeParse({ ...VALID_REGISTRATION, name: "" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.filter((issue) => issue.path[0] === "name")).toHaveLength(1);
  });
});

describe("updateProfileSchema.name", () => {
  it("holds an edited name to the same rule as registration", () => {
    for (const name of JUNK_NAMES) {
      expect(updateProfileSchema.safeParse({ name }).success).toBe(false);
    }
    for (const name of REAL_NAMES) {
      expect(updateProfileSchema.safeParse({ name }).success).toBe(true);
    }
  });

  it("still allows a save that does not touch the name", () => {
    expect(updateProfileSchema.safeParse({ emailAlerts: false }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ email: "a@b.co" }).success).toBe(true);
  });

  it("still refuses a body with no fields at all", () => {
    expect(updateProfileSchema.safeParse({}).success).toBe(false);
  });
});
