import { describe, expect, it } from "vitest";
import { redactForLog, redactKeys, redactLiteralValues, sensitiveValueMapFromParams } from "../src/safety/redaction.js";

describe("redaction", () => {
  it("redacts known-sensitive field names regardless of nesting", () => {
    const input = { user: "alice", auth: { password: "hunter2", token: "abc123" } };
    const out = redactKeys(input) as any;
    expect(out.auth.password).toBe("[REDACTED]");
    expect(out.auth.token).toBe("[REDACTED]");
    expect(out.user).toBe("alice");
  });

  it("redacts secret-shaped strings even under an innocuous key", () => {
    const input = { note: "using key sk-abcdefghijklmnop for this run" };
    const out = redactKeys(input) as any;
    expect(out.note).toContain("[REDACTED:secret-like]");
    expect(out.note).not.toContain("sk-abcdefghijklmnop");
  });

  it("redacts literal param values wherever they appear in free text", () => {
    const text = 'Member detail page shows "Alice Nguyen" with balance $500';
    const out = redactLiteralValues(text, new Map([["Alice Nguyen", "memberName"]]));
    expect(out).toBe('Member detail page shows "[REDACTED:memberName]" with balance $500');
  });

  it("builds a sensitive value map from capability params, skipping null/undefined", () => {
    const map = sensitiveValueMapFromParams({ memberId: "M1001", nickname: "Vacation", note: undefined });
    expect(map.get("M1001")).toBe("memberId");
    expect(map.get("Vacation")).toBe("nickname");
    expect(map.size).toBe(2);
  });

  it("redactForLog applies both passes together", () => {
    const sensitive = sensitiveValueMapFromParams({ memberId: "M1001" });
    const out = redactForLog({ visibleText: "Member M1001 balance $500", password: "x" }, sensitive) as any;
    expect(out.visibleText).toBe("Member [REDACTED:memberId] balance $500");
    expect(out.password).toBe("[REDACTED]");
  });
});
