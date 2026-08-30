import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_STOP_CONDITION, runDiscovery } from "../src/discovery/discoveryLoop.js";
import type { DecideParams, LlmDecider } from "../src/discovery/llmClient.js";
import type { Decision } from "../src/discovery/types.js";
import { Logger } from "../src/logging/logger.js";
import { FakeSurface, type FakeScreen } from "../src/surfaces/fakeSurface.js";

// These exercise discoveryLoop's own control flow — stop conditions,
// paramRef/literal bookkeeping, and the missing-terminal-field retry —
// against a scripted fake LLM. No real API key, no browser. This is
// distinct from (and doesn't replace) the real discovery runs in
// evidence/: those prove the actual model behaves sensibly; these prove
// the loop around it behaves correctly no matter what the model says.

class ScriptedLlmClient implements LlmDecider {
  readonly calls: DecideParams[] = [];
  constructor(private readonly script: (callIndex: number, params: DecideParams) => Decision) {}
  async decide(params: DecideParams): Promise<Decision> {
    const i = this.calls.length;
    this.calls.push(params);
    return this.script(i, params);
  }
}

function makeLogger() {
  const dir = mkdtempSync(path.join(tmpdir(), "discovery-loop-test-"));
  return new Logger(path.join(dir, "log.jsonl"), "test-run");
}

const START_URL = "http://fake.local/";

function makeSurface(extraScreens: FakeScreen[] = []): FakeSurface {
  const screens: FakeScreen[] = [
    {
      url: START_URL,
      text: () => "Home",
      elements: [
        { strategies: [{ kind: "testId", testId: "search" }] },
        { strategies: [{ kind: "testId", testId: "go" }], onClick: (s) => s.goto(`${START_URL}result`) }
      ]
    },
    ...extraScreens
  ];
  return new FakeSurface(screens, START_URL);
}

describe("runDiscovery", () => {
  it("records step-0 as the initial navigation, tracks paramRef/literals, and reaches goal_met", async () => {
    const surface = makeSurface([
      { url: `${START_URL}result`, text: () => "Result page shows Balance: 500", elements: [] }
    ]);
    const llm = new ScriptedLlmClient((i) => {
      const decisions: Decision[] = [
        {
          thought: "",
          status: "continue",
          action: {
            type: "fill",
            locatorDescription: "Search box",
            strategies: [{ kind: "testId", testId: "search" }],
            value: "M1001",
            paramRef: "memberId",
            paramType: "string",
            risk: "safe",
            riskRationale: "r"
          }
        },
        {
          thought: "",
          status: "continue",
          action: {
            type: "click",
            locatorDescription: "Go button",
            strategies: [{ kind: "testId", testId: "go" }],
            risk: "safe",
            riskRationale: "r",
            checkpoint: { kind: "textVisible", value: "Result", description: "d" }
          }
        },
        {
          thought: "",
          status: "continue",
          action: {
            type: "observe",
            risk: "safe",
            riskRationale: "r",
            extract: [{ outputField: "balance", description: "d", type: "number", pattern: "Balance: (\\d+)" }]
          }
        },
        { thought: "", status: "goal_met", terminalSignatureText: "Result page", terminalMessage: "done" }
      ];
      return decisions[i]!;
    });

    const result = await runDiscovery(surface, llm, "goal text", START_URL, makeLogger());

    expect(result.steps.map((s) => s.id)).toEqual(["step-0", "step-1", "step-2", "step-3"]);
    expect(result.steps[0]!.action).toEqual({ type: "navigate", value: START_URL });
    expect(result.inputParams).toEqual([
      { name: "memberId", type: "string", description: "Value supplied for: Search box", required: true }
    ]);
    expect(result.outputs).toEqual([{ name: "balance", type: "number", description: "d", required: false }]);
    expect(result.literalValuesByParam).toEqual({ memberId: "M1001" });
    expect(result.terminal).toEqual({
      kind: "goal_met",
      label: undefined,
      message: "done",
      signatureText: "Result page",
      reason: undefined
    });
  });

  it("stops with 'stuck' after exceeding max steps, rather than looping forever", async () => {
    const surface = makeSurface();
    const llm = new ScriptedLlmClient(() => ({
      thought: "",
      status: "continue",
      action: { type: "observe", risk: "safe", riskRationale: "r" }
    }));

    const result = await runDiscovery(surface, llm, "goal", START_URL, makeLogger(), {
      ...DEFAULT_STOP_CONDITION,
      maxSteps: 3
    });

    expect(result.terminal.kind).toBe("stuck");
    expect(result.terminal.reason).toMatch(/Exceeded max steps \(3\)/);
    // step-0 (navigate) + 3 observe steps from the 3 loop iterations
    expect(result.steps).toHaveLength(4);
  });

  it("stops with 'stuck' on a wall-clock timeout, independent of step count", async () => {
    const surface = makeSurface();
    const llm = new ScriptedLlmClient(() => ({
      thought: "",
      status: "continue",
      action: { type: "observe", risk: "safe", riskRationale: "r" }
    }));

    const result = await runDiscovery(surface, llm, "goal", START_URL, makeLogger(), {
      ...DEFAULT_STOP_CONDITION,
      timeoutMs: 0
    });

    expect(result.terminal.kind).toBe("stuck");
    expect(result.terminal.reason).toMatch(/timeout/i);
    expect(llm.calls).toHaveLength(0); // timeout is checked before ever asking the model for a decision
  });

  it("stops with 'stuck' after N consecutive action failures", async () => {
    const surface = makeSurface();
    const llm = new ScriptedLlmClient(() => ({
      thought: "",
      status: "continue",
      action: {
        type: "click",
        locatorDescription: "ghost",
        strategies: [{ kind: "testId", testId: "does-not-exist" }],
        risk: "safe",
        riskRationale: "r"
      }
    }));

    const result = await runDiscovery(surface, llm, "goal", START_URL, makeLogger(), {
      ...DEFAULT_STOP_CONDITION,
      maxConsecutiveFailures: 2
    });

    expect(result.terminal.kind).toBe("stuck");
    expect(result.terminal.reason).toMatch(/2 consecutive action failures/);
    // Failed actions are never recorded as steps — only step-0 (navigate) exists.
    expect(result.steps).toHaveLength(1);
  });

  it("stops with 'stuck' when the model returns status=continue with no action", async () => {
    const surface = makeSurface();
    const llm = new ScriptedLlmClient(() => ({ thought: "", status: "continue" }));

    const result = await runDiscovery(surface, llm, "goal", START_URL, makeLogger());

    expect(result.terminal).toEqual({ kind: "stuck", reason: "Model returned status=continue without an action." });
  });

  it("gives the model a corrective retry when a terminal decision is missing required fields, instead of accepting it", async () => {
    const surface = makeSurface();
    const llm = new ScriptedLlmClient((i) =>
      i === 0
        ? { thought: "", status: "goal_met" } // missing terminalSignatureText — should be rejected
        : { thought: "", status: "goal_met", terminalSignatureText: "Done text", terminalMessage: "ok" }
    );

    const result = await runDiscovery(surface, llm, "goal", START_URL, makeLogger());

    expect(llm.calls).toHaveLength(2);
    expect(result.terminal.signatureText).toBe("Done text");
    // The corrective note is visible to the model on its retry.
    expect(llm.calls[1]!.historySummary.at(-1)).toMatch(/terminalSignatureText/);
  });

  it("gives the same corrective retry for business_outcome/escalation missing terminalLabel", async () => {
    const surface = makeSurface();
    const llm = new ScriptedLlmClient((i) =>
      i === 0
        ? { thought: "", status: "business_outcome", terminalSignatureText: "No results" } // missing terminalLabel
        : {
            thought: "",
            status: "business_outcome",
            terminalLabel: "not_found",
            terminalSignatureText: "No results",
            terminalMessage: "nope"
          }
    );

    const result = await runDiscovery(surface, llm, "goal", START_URL, makeLogger());

    expect(llm.calls).toHaveLength(2);
    expect(result.terminal.label).toBe("not_found");
  });
});
