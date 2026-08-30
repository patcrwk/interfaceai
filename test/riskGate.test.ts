import { describe, expect, it } from "vitest";
import { CliRiskGate } from "../src/safety/riskGate.js";
import { makeFixtureArtifact } from "./fixtures/subAccountFixture.js";

describe("CliRiskGate", () => {
  it("authorizes an approved artifact's risky step without prompting", async () => {
    const gate = new CliRiskGate(false);
    const artifact = makeFixtureArtifact({ status: "approved" });
    const step = artifact.steps.find((s) => s.risk === "risky")!;
    await expect(gate.authorize(artifact, step)).resolves.toBe(true);
  });

  it("fails closed on a draft artifact's risky step when no operator is attached", async () => {
    const gate = new CliRiskGate(false);
    const artifact = makeFixtureArtifact({ status: "draft" });
    const step = artifact.steps.find((s) => s.risk === "risky")!;
    await expect(gate.authorize(artifact, step)).resolves.toBe(false);
  });
});
