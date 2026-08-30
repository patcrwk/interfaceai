import { describe, expect, it } from "vitest";
import { evaluateCheckpoint, resolveActionTemplate, resolveTemplate } from "../src/core/checkpoint.js";
import type { Observation } from "../src/core/surface.js";

const observation: Observation = { url: "http://x/modern/members/M1001", title: "t", visibleText: "Balance: $500" };

describe("evaluateCheckpoint", () => {
  it("textVisible matches substring", () => {
    expect(evaluateCheckpoint({ kind: "textVisible", value: "Balance", description: "" }, observation)).toBe(true);
    expect(evaluateCheckpoint({ kind: "textVisible", value: "Nope", description: "" }, observation)).toBe(false);
  });

  it("textNotVisible is the inverse", () => {
    expect(evaluateCheckpoint({ kind: "textNotVisible", value: "Balance", description: "" }, observation)).toBe(false);
    expect(evaluateCheckpoint({ kind: "textNotVisible", value: "Nope", description: "" }, observation)).toBe(true);
  });

  it("urlMatches applies the value as a regex against the URL", () => {
    expect(evaluateCheckpoint({ kind: "urlMatches", value: "/members/M\\d+", description: "" }, observation)).toBe(true);
    expect(evaluateCheckpoint({ kind: "urlMatches", value: "/legacy/", description: "" }, observation)).toBe(false);
  });
});

describe("resolveTemplate", () => {
  it("substitutes a known param", () => {
    expect(resolveTemplate("id={{memberId}}", { memberId: "M1001" })).toBe("id=M1001");
  });

  it("throws on an unknown param rather than silently leaving the placeholder", () => {
    expect(() => resolveTemplate("id={{missing}}", {})).toThrow(/unknown param/);
  });

  it("resolveActionTemplate leaves an action without a value untouched", () => {
    const action = { type: "observe" as const };
    expect(resolveActionTemplate(action, {})).toEqual(action);
  });

  it("resolveActionTemplate also substitutes placeholders inside locator strategy fields (a real target app baked a member ID into a data-testid)", () => {
    const action = {
      type: "click" as const,
      locator: {
        description: "View link",
        strategies: [{ kind: "testId" as const, testId: "view-member-{{memberId}}" }],
        rationale: ""
      }
    };
    const resolved = resolveActionTemplate(action, { memberId: "M1002" });
    expect(resolved.locator?.strategies[0]).toEqual({ kind: "testId", testId: "view-member-M1002" });
  });
});
