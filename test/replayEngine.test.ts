import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ReplayEngine } from "../src/replay/replayEngine.js";
import { Logger } from "../src/logging/logger.js";
import { EscalationHandoff } from "../src/escalation/handoff.js";
import { Allowlist, defaultAllowlist } from "../src/safety/allowlist.js";
import { AlwaysApproveRiskGate, AlwaysDenyRiskGate } from "../src/safety/riskGate.js";
import { FakeSurface } from "../src/surfaces/fakeSurface.js";
import { BASE_URL, makeFixtureArtifact, makeFixtureSurface } from "./fixtures/subAccountFixture.js";

function makeEngine(surface: ReturnType<typeof makeFixtureSurface>, opts: { deny?: boolean; allowlist?: Allowlist } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "replay-test-"));
  const logger = new Logger(path.join(dir, "log.jsonl"), "test-run");
  const allowlist = opts.allowlist ?? defaultAllowlist(new URL(BASE_URL).origin);
  const riskGate = opts.deny ? new AlwaysDenyRiskGate() : new AlwaysApproveRiskGate();
  const handoff = new EscalationHandoff(surface, logger, false, dir);
  return new ReplayEngine({ surface, allowlist, riskGate, logger, handoff, evidenceDir: dir, runId: "test-run" });
}

describe("ReplayEngine", () => {
  it("returns success with extracted outputs on the happy path", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface);
    const outcome = await engine.run(makeFixtureArtifact({ status: "approved" }), { memberId: "M1001" });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.outputs.balance).toBe(4210);
      expect(outcome.outputs.newBalance).toBe(500);
    }
  });

  it("auto-dismisses the recoverable interstitial without escalating", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface);
    const outcome = await engine.run(makeFixtureArtifact({ status: "approved" }), { memberId: "M1007" });
    expect(outcome.kind).toBe("success");
  });

  it("returns business_outcome for a member that doesn't exist", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface);
    const outcome = await engine.run(makeFixtureArtifact({ status: "approved" }), { memberId: "M9999" });
    expect(outcome.kind).toBe("business_outcome");
    if (outcome.kind === "business_outcome") {
      expect(outcome.label).toBe("member_not_found");
    }
  });

  it("returns escalated when a compliance-hold trigger is hit and no operator resolves it", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface);
    const outcome = await engine.run(makeFixtureArtifact({ status: "approved" }), { memberId: "M1008" });
    expect(outcome.kind).toBe("escalated");
    if (outcome.kind === "escalated") {
      expect(outcome.stepId).toBe("confirm-submit");
      expect(outcome.reason).toMatch(/compliance hold/i);
      expect(outcome.evidence.screenshotPath).toBeDefined();
    }
  });

  it("returns escalated (not hard_failure) when a draft artifact's risky step is declined", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface, { deny: true });
    const outcome = await engine.run(makeFixtureArtifact({ status: "draft" }), { memberId: "M1001" });
    expect(outcome.kind).toBe("escalated");
    if (outcome.kind === "escalated") {
      expect(outcome.stepId).toBe("confirm-submit");
    }
  });

  it("returns hard_failure with expected/observed when a locator can't be resolved at all", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface);
    const artifact = makeFixtureArtifact({ status: "approved" });
    artifact.steps[2]!.action.locator!.strategies = [{ kind: "testId", testId: "does-not-exist" }];
    const outcome = await engine.run(artifact, { memberId: "M1001" });
    expect(outcome.kind).toBe("hard_failure");
    if (outcome.kind === "hard_failure") {
      expect(outcome.stepId).toBe("submit-search");
      expect(outcome.observed).toMatch(/No element matched/);
    }
  });

  it("returns hard_failure on invalid input params rather than throwing", async () => {
    const surface = makeFixtureSurface();
    const engine = makeEngine(surface);
    const outcome = await engine.run(makeFixtureArtifact({ status: "approved" }), {} as Record<string, unknown>);
    expect(outcome.kind).toBe("hard_failure");
    if (outcome.kind === "hard_failure") {
      expect(outcome.stepId).toBe("$input");
    }
  });

  it("strips thousands separators before coercing an extracted number (real replay against a $15,320.00 balance hit NaN)", async () => {
    const surface = new FakeSurface(
      [{ url: `${BASE_URL}/balance`, text: () => "Primary balance: $15,320.00", elements: [] }],
      `${BASE_URL}/balance`
    );
    const engine = makeEngine(surface);
    const artifact = makeFixtureArtifact({
      status: "approved",
      inputParams: [],
      steps: [
        {
          id: "read-balance",
          description: "Read the balance",
          action: { type: "navigate", value: `${BASE_URL}/balance` },
          risk: "safe",
          riskRationale: "Read-only.",
          checkpoint: { kind: "textVisible", value: "Primary balance", description: "Balance page loaded" },
          recoverable: [],
          extract: [{ outputField: "balance", pattern: "Primary balance: \\$([0-9,]+\\.\\d{2})", transform: "number" }]
        }
      ],
      overallCheckpoint: { kind: "textVisible", value: "Primary balance", description: "Balance page loaded" },
      outputs: [{ name: "balance", type: "number", description: "Balance", required: false }]
    });
    const outcome = await engine.run(artifact, {});
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.outputs.balance).toBe(15320);
    }
  });

  it("recovers a clean number from a capture group that swallowed trailing punctuation (real run: '75.00.' from a sentence-ending period)", async () => {
    const surface = new FakeSurface(
      [{ url: `${BASE_URL}/success`, text: () => "Account SA0009 opened with a balance of $75.00.", elements: [] }],
      `${BASE_URL}/success`
    );
    const engine = makeEngine(surface);
    const artifact = makeFixtureArtifact({
      status: "approved",
      inputParams: [],
      steps: [
        {
          id: "read-result",
          description: "Read the result",
          action: { type: "navigate", value: `${BASE_URL}/success` },
          risk: "safe",
          riskRationale: "Read-only.",
          checkpoint: { kind: "textVisible", value: "opened", description: "Success page loaded" },
          recoverable: [],
          // Deliberately greedy, as a real discovery run produced: [\d,.]+ eats the trailing period.
          extract: [{ outputField: "newAccountBalance", pattern: "opened with a balance of \\$([\\d,.]+)", transform: "number" }]
        }
      ],
      overallCheckpoint: { kind: "textVisible", value: "opened", description: "Success page loaded" },
      outputs: [{ name: "newAccountBalance", type: "number", description: "New balance", required: false }]
    });
    const outcome = await engine.run(artifact, {});
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.outputs.newAccountBalance).toBe(75);
    }
  });

  it("detects a business outcome BEFORE attempting the next step's action, when that action's target simply doesn't exist on the divergent page (real bug: a 'no results' page has no row to click)", async () => {
    // Unlike the shared fixture (whose "results" screen always has a
    // clickable view-member element regardless of outcome), this mirrors
    // what the real /modern app actually does: a no-match search renders
    // NO row to click at all. A real replay against a nonexistent member
    // ID came back hard_failure ("no element matched") instead of
    // business_outcome, because business/escalation rules were only ever
    // checked after a successful action's checkpoint failed — never before
    // attempting an action whose target might not exist in the first place.
    const surface = new FakeSurface(
      [
        { url: `${BASE_URL}/results`, text: () => "No members matched", elements: [] },
        { url: `${BASE_URL}/detail`, text: () => "unreachable", elements: [] }
      ],
      `${BASE_URL}/results`
    );
    const engine = makeEngine(surface);
    const artifact = makeFixtureArtifact({
      status: "approved",
      inputParams: [],
      steps: [
        {
          id: "open-member",
          description: "Click the view-member link",
          action: {
            type: "click",
            locator: {
              description: "View link",
              strategies: [{ kind: "testId", testId: "view-member" }],
              rationale: ""
            }
          },
          risk: "safe",
          riskRationale: "Read-only.",
          checkpoint: { kind: "textVisible", value: "unreachable", description: "Detail page loaded" },
          recoverable: [],
          extract: []
        }
      ],
      overallCheckpoint: { kind: "textVisible", value: "unreachable", description: "Detail page loaded" },
      businessOutcomes: [
        {
          label: "member_not_found",
          match: { kind: "textVisible", value: "No members matched", description: "No-results page shown" },
          message: "No such member."
        }
      ]
    });
    const outcome = await engine.run(artifact, {});
    expect(outcome.kind).toBe("business_outcome");
  });

  it("enforces the allowlist in the executor, not just in config", async () => {
    const surface = makeFixtureSurface();
    const restrictiveAllowlist = new Allowlist({
      allowedOrigins: [new URL(BASE_URL).origin],
      allowedPathPrefixes: ["/nowhere"],
      allowedActionTypes: ["click", "fill", "selectOption", "navigate", "observe"]
    });
    const engine = makeEngine(surface, { allowlist: restrictiveAllowlist });
    const outcome = await engine.run(makeFixtureArtifact({ status: "approved" }), { memberId: "M1001" });
    expect(outcome.kind).toBe("hard_failure");
    if (outcome.kind === "hard_failure") {
      expect(outcome.stepId).toBe("$target");
    }
  });
});
