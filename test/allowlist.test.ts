import { describe, expect, it } from "vitest";
import { Allowlist, defaultAllowlist } from "../src/safety/allowlist.js";

describe("Allowlist", () => {
  it("allows a URL matching origin and path prefix", () => {
    const allowlist = defaultAllowlist("http://localhost:4173");
    expect(allowlist.isUrlAllowed("http://localhost:4173/modern/members/M1001")).toBe(true);
  });

  it("rejects a URL from a different origin", () => {
    const allowlist = defaultAllowlist("http://localhost:4173");
    expect(allowlist.isUrlAllowed("http://evil.example.com/modern/")).toBe(false);
  });

  it("rejects a path outside the allowed prefixes", () => {
    const allowlist = new Allowlist({
      allowedOrigins: ["http://localhost:4173"],
      allowedPathPrefixes: ["/modern"],
      allowedActionTypes: ["click", "navigate"]
    });
    expect(allowlist.isUrlAllowed("http://localhost:4173/admin/danger")).toBe(false);
  });

  it("rejects a malformed URL rather than throwing", () => {
    const allowlist = defaultAllowlist("http://localhost:4173");
    expect(allowlist.isUrlAllowed("not a url")).toBe(false);
  });

  it("enforces the permitted action-type set", () => {
    const allowlist = new Allowlist({
      allowedOrigins: ["http://localhost:4173"],
      allowedPathPrefixes: ["/"],
      allowedActionTypes: ["click", "navigate"]
    });
    expect(allowlist.isActionTypeAllowed("click")).toBe(true);
    expect(allowlist.isActionTypeAllowed("fill")).toBe(false);
  });
});
