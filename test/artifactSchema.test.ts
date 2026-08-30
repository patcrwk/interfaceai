import { describe, expect, it } from "vitest";
import { CapabilityArtifactSchema, compileFieldSchema } from "../src/core/artifact.js";
import { makeFixtureArtifact } from "./fixtures/subAccountFixture.js";

describe("CapabilityArtifactSchema", () => {
  it("accepts a well-formed artifact", () => {
    const result = CapabilityArtifactSchema.safeParse(makeFixtureArtifact());
    expect(result.success).toBe(true);
  });

  it("rejects an artifact with zero steps", () => {
    const artifact = makeFixtureArtifact();
    (artifact as any).steps = [];
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects an unknown status value", () => {
    const artifact = makeFixtureArtifact();
    (artifact as any).status = "published";
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });

  it("rejects a locator strategy of an unrecognized kind", () => {
    const artifact = makeFixtureArtifact();
    (artifact.steps[1]!.action.locator!.strategies as any) = [{ kind: "xpath", value: "//div" }];
    expect(CapabilityArtifactSchema.safeParse(artifact).success).toBe(false);
  });
});

describe("compileFieldSchema", () => {
  it("compiles a required string field", () => {
    const schema = compileFieldSchema([{ name: "memberId", type: "string", description: "", required: true }]);
    expect(schema.safeParse({ memberId: "M1001" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ memberId: 5 }).success).toBe(false);
  });

  it("compiles an optional number field", () => {
    const schema = compileFieldSchema([{ name: "balance", type: "number", description: "", required: false }]);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ balance: 100 }).success).toBe(true);
    expect(schema.safeParse({ balance: "100" }).success).toBe(false);
  });
});
