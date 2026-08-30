import { describe, expect, it } from "vitest";
import { appendBusinessOutcome, appendEscalationTrigger, compileGoalMetArtifact } from "../src/discovery/artifactCompiler.js";
import type { CapabilityArtifact, Step } from "../src/core/artifact.js";
import type { DiscoveryResult } from "../src/discovery/discoveryLoop.js";

// These exercise the deterministic generalization pass directly — the
// pass that closes the gap between "the model applies paramRef
// inconsistently" and "artifacts are PII-free by construction." Until
// now this was only validated by real discovery runs (see CHANGELOG.md
// bugs #2, #3, #10), never by a fast, no-API-key regression test.

function step(overrides: Partial<Step>): Step {
  return {
    id: "s",
    description: "",
    action: { type: "click" },
    risk: "safe",
    riskRationale: "",
    checkpoint: null,
    recoverable: [],
    extract: [],
    ...overrides
  };
}

function result(overrides: Partial<DiscoveryResult>): DiscoveryResult {
  return {
    steps: [],
    inputParams: [],
    outputs: [],
    literalValuesByParam: {},
    terminal: { kind: "goal_met", signatureText: "Done" },
    ...overrides
  };
}

describe("compileGoalMetArtifact", () => {
  const baseParams = {
    capabilityId: "cap",
    goal: "goal",
    target: { surface: "dom" as const, baseUrl: "http://x" },
    discoveryRunId: "run-1"
  };

  it("substitutes a literal param value back into a checkpoint", () => {
    const artifact = compileGoalMetArtifact({
      ...baseParams,
      result: result({
        literalValuesByParam: { memberId: "M1001" },
        steps: [
          step({
            checkpoint: { kind: "textVisible", value: "M1001", description: "" }
          })
        ]
      })
    });
    expect(artifact.steps[0]!.checkpoint!.value).toBe("{{memberId}}");
  });

  it("substitutes a literal param value inside every field of a locator strategy (testId, role/name, text, css, visionDescription)", () => {
    const artifact = compileGoalMetArtifact({
      ...baseParams,
      result: result({
        literalValuesByParam: { memberId: "M1001" },
        steps: [
          step({
            action: {
              type: "click",
              locator: {
                description: "View link for M1001",
                strategies: [
                  { kind: "testId", testId: "view-member-M1001" },
                  { kind: "role", role: "link", name: "View M1001" },
                  { kind: "text", text: "M1001" },
                  { kind: "css", selector: "#row-M1001" },
                  { kind: "visionDescription", description: "row for M1001" }
                ],
                rationale: ""
              }
            }
          })
        ]
      })
    });
    const locator = artifact.steps[0]!.action.locator!;
    expect(locator.description).toBe("View link for {{memberId}}");
    expect(locator.strategies[0]).toEqual({ kind: "testId", testId: "view-member-{{memberId}}" });
    expect(locator.strategies[1]).toEqual({ kind: "role", role: "link", name: "View {{memberId}}" });
    expect(locator.strategies[2]).toEqual({ kind: "text", text: "{{memberId}}" });
    expect(locator.strategies[3]).toEqual({ kind: "css", selector: "#row-{{memberId}}" });
    expect(locator.strategies[4]).toEqual({ kind: "visionDescription", description: "row for {{memberId}}" });
  });

  it("prefers the longest literal match first, so one param's value can't be swallowed by a substring of another's", () => {
    const artifact = compileGoalMetArtifact({
      ...baseParams,
      result: result({
        literalValuesByParam: { memberId: "M100", nickname: "M1001 Fund" },
        steps: [step({ checkpoint: { kind: "textVisible", value: "M1001 Fund", description: "" } })]
      })
    });
    expect(artifact.steps[0]!.checkpoint!.value).toBe("{{nickname}}");
  });

  it("does not touch a checkpoint that's already templated", () => {
    const artifact = compileGoalMetArtifact({
      ...baseParams,
      result: result({
        literalValuesByParam: { memberId: "M1001" },
        steps: [step({ checkpoint: { kind: "textVisible", value: "{{memberId}}", description: "" } })]
      })
    });
    expect(artifact.steps[0]!.checkpoint!.value).toBe("{{memberId}}");
  });

  it("nulls out any checkpoint on a fill/selectOption step regardless of what was recorded", () => {
    const artifact = compileGoalMetArtifact({
      ...baseParams,
      result: result({
        steps: [
          step({ action: { type: "fill", value: "x" }, checkpoint: { kind: "textVisible", value: "x", description: "" } }),
          step({ action: { type: "selectOption", value: "y" }, checkpoint: { kind: "textVisible", value: "y", description: "" } })
        ]
      })
    });
    expect(artifact.steps[0]!.checkpoint).toBeNull();
    expect(artifact.steps[1]!.checkpoint).toBeNull();
  });

  it("throws if the terminal isn't goal_met, or is goal_met without a signature", () => {
    expect(() => compileGoalMetArtifact({ ...baseParams, result: result({ terminal: { kind: "stuck", reason: "x" } }) })).toThrow(
      /goal_met/
    );
    expect(() =>
      compileGoalMetArtifact({ ...baseParams, result: result({ terminal: { kind: "goal_met" } }) })
    ).toThrow(/terminalSignatureText/);
  });

  it("versions from an existing artifact and preserves its business/escalation rules", () => {
    const existing: CapabilityArtifact = {
      id: "cap",
      version: 3,
      status: "approved",
      goal: "old goal",
      target: { surface: "dom", baseUrl: "http://x" },
      createdAt: "2020-01-01",
      discoveredBy: { model: "m", discoveryRunId: "old" },
      inputParams: [],
      outputs: [],
      steps: [],
      overallCheckpoint: { kind: "textVisible", value: "x", description: "" },
      businessOutcomes: [{ label: "not_found", match: { kind: "textVisible", value: "nf", description: "" }, message: "nf" }],
      escalationTriggers: [],
      riskSummary: { hasRiskySteps: false, justification: "" }
    };
    const artifact = compileGoalMetArtifact({ ...baseParams, existing, result: result({}) });
    expect(artifact.version).toBe(4);
    expect(artifact.status).toBe("draft"); // a fresh main-flow discovery always resets to draft
    expect(artifact.businessOutcomes).toEqual(existing.businessOutcomes);
  });

  it("computes riskSummary from the steps' own risk classifications", () => {
    const safeOnly = compileGoalMetArtifact({ ...baseParams, result: result({ steps: [step({ risk: "safe" })] }) });
    expect(safeOnly.riskSummary).toEqual({ hasRiskySteps: false, justification: "No risky steps." });

    const withRisky = compileGoalMetArtifact({
      ...baseParams,
      result: result({ steps: [step({ risk: "risky", riskRationale: "irreversible submit" })] })
    });
    expect(withRisky.riskSummary).toEqual({ hasRiskySteps: true, justification: "irreversible submit" });
  });
});

describe("appendBusinessOutcome / appendEscalationTrigger", () => {
  const artifact: CapabilityArtifact = {
    id: "cap",
    version: 1,
    status: "approved",
    goal: "g",
    target: { surface: "dom", baseUrl: "http://x" },
    createdAt: "2020-01-01",
    discoveredBy: { model: "m", discoveryRunId: "r" },
    inputParams: [],
    outputs: [],
    steps: [],
    overallCheckpoint: { kind: "textVisible", value: "x", description: "" },
    businessOutcomes: [],
    escalationTriggers: [],
    riskSummary: { hasRiskySteps: false, justification: "" }
  };

  it("appends a business_outcome rule from the terminal", () => {
    const updated = appendBusinessOutcome(artifact, {
      kind: "business_outcome",
      label: "member_not_found",
      message: "No such member.",
      signatureText: "No members matched"
    });
    expect(updated.businessOutcomes).toEqual([
      {
        label: "member_not_found",
        match: { kind: "textVisible", value: "No members matched", description: "No such member." },
        message: "No such member."
      }
    ]);
    expect(updated.escalationTriggers).toEqual([]);
  });

  it("re-appending the same label replaces rather than duplicates", () => {
    const once = appendBusinessOutcome(artifact, {
      kind: "business_outcome",
      label: "member_not_found",
      message: "v1",
      signatureText: "v1 text"
    });
    const twice = appendBusinessOutcome(once, {
      kind: "business_outcome",
      label: "member_not_found",
      message: "v2",
      signatureText: "v2 text"
    });
    expect(twice.businessOutcomes).toHaveLength(1);
    expect(twice.businessOutcomes[0]!.message).toBe("v2");
  });

  it("appends an escalation rule from the terminal", () => {
    const updated = appendEscalationTrigger(artifact, {
      kind: "escalation",
      label: "compliance_hold",
      message: "Blocked.",
      signatureText: "compliance hold"
    });
    expect(updated.escalationTriggers).toEqual([
      {
        label: "compliance_hold",
        match: { kind: "textVisible", value: "compliance hold", description: "Blocked." },
        reason: "Blocked."
      }
    ]);
  });

  it("throws when the terminal is missing label or signatureText", () => {
    expect(() => appendBusinessOutcome(artifact, { kind: "business_outcome", signatureText: "x" })).toThrow(/label/);
    expect(() => appendEscalationTrigger(artifact, { kind: "escalation", label: "x" })).toThrow(/terminalSignatureText/);
  });
});
