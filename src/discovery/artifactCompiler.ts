import { DISCOVERY_MODEL } from "./llmClient.js";
import type { CapabilityArtifact, Checkpoint, LocatorSpec, LocatorStrategy, Step } from "../core/artifact.js";
import type { DiscoveryResult, DiscoveryTerminal } from "./discoveryLoop.js";

// The model reliably applies paramRef to action *values* but is
// inconsistent about echoing the same placeholder into checkpoints (a
// checkpoint literally written as "M1001" instead of "{{memberId}}" would
// never match again once a different memberId is supplied). Rather than
// depend on the model to get every field right, this pass deterministically
// substitutes known literal param values back into "{{paramName}}"
// wherever they appear in a checkpoint — closing that gap without another
// model call.
function substituteLiterals(text: string, literalValuesByParam: Record<string, string>): string {
  if (text.includes("{{")) return text;
  let out = text;
  const entries = Object.entries(literalValuesByParam).sort((a, b) => b[1].length - a[1].length);
  for (const [name, literal] of entries) {
    if (!literal) continue;
    if (out.includes(literal)) out = out.split(literal).join(`{{${name}}}`);
  }
  return out;
}

function generalizeCheckpoint<T extends Checkpoint | null>(checkpoint: T, literalValuesByParam: Record<string, string>): T {
  if (!checkpoint) return checkpoint;
  return { ...checkpoint, value: substituteLiterals(checkpoint.value, literalValuesByParam) };
}

// A locator strategy's own fields can embed run-specific data too, not
// just the action's value or a checkpoint — a real run against /modern
// showed this directly: the "View" link's data-testid is per-row
// ("view-member-M1001"), so without this the recorded strategy would only
// ever match the exact member looked up during discovery.
function generalizeStrategy(strategy: LocatorStrategy, literalValuesByParam: Record<string, string>): LocatorStrategy {
  switch (strategy.kind) {
    case "role":
      return {
        ...strategy,
        role: substituteLiterals(strategy.role, literalValuesByParam),
        name: substituteLiterals(strategy.name, literalValuesByParam)
      };
    case "label":
      return { ...strategy, label: substituteLiterals(strategy.label, literalValuesByParam) };
    case "testId":
      return { ...strategy, testId: substituteLiterals(strategy.testId, literalValuesByParam) };
    case "text":
      return { ...strategy, text: substituteLiterals(strategy.text, literalValuesByParam) };
    case "css":
      return { ...strategy, selector: substituteLiterals(strategy.selector, literalValuesByParam) };
    case "visionDescription":
      return { ...strategy, description: substituteLiterals(strategy.description, literalValuesByParam) };
  }
}

function generalizeLocator<T extends LocatorSpec | undefined>(locator: T, literalValuesByParam: Record<string, string>): T {
  if (!locator) return locator;
  return {
    ...locator,
    description: substituteLiterals(locator.description, literalValuesByParam),
    strategies: locator.strategies.map((s) => generalizeStrategy(s, literalValuesByParam))
  } as T;
}

function generalizeStep(step: Step, literalValuesByParam: Record<string, string>): Step {
  const locator = generalizeLocator(step.action.locator, literalValuesByParam);
  // A fill/selectOption action's effect (the field's new value) is never
  // part of Observation.visibleText — document.body.innerText does not
  // include form field values — so a textVisible/textNotVisible checkpoint
  // on one of these actions can never be verified, on discovery OR replay,
  // no matter how it's parameterized. The action's own ok/error result from
  // the Surface is already the correct verification for this action type.
  // Enforced here rather than only via prompt, since a real run showed the
  // model doesn't reliably follow that instruction.
  if (step.action.type === "fill" || step.action.type === "selectOption") {
    return { ...step, checkpoint: null, action: { ...step.action, locator } };
  }
  return {
    ...step,
    checkpoint: generalizeCheckpoint(step.checkpoint, literalValuesByParam),
    action: { ...step.action, locator }
  };
}

// Deterministic, non-LLM compilation from a DiscoveryResult into the
// persisted CapabilityArtifact shape. A goal_met run produces/replaces the
// steps + overall checkpoint; business_outcome/escalation runs (short,
// separate, real discovery invocations targeting a known edge case) append
// a rule to an already-existing artifact rather than replacing it — see
// CLAUDE.md and README.md for why this is three real discovery runs
// merged, not one run with fabricated edge cases bolted on.

export function compileGoalMetArtifact(params: {
  capabilityId: string;
  goal: string;
  target: { surface: "dom" | "vision"; baseUrl: string };
  discoveryRunId: string;
  result: DiscoveryResult;
  existing?: CapabilityArtifact;
}): CapabilityArtifact {
  const { terminal } = params.result;
  if (terminal.kind !== "goal_met") throw new Error("compileGoalMetArtifact requires a goal_met terminal");
  if (!terminal.signatureText) throw new Error("goal_met terminal is missing terminalSignatureText");

  return {
    id: params.capabilityId,
    version: (params.existing?.version ?? 0) + 1,
    status: "draft",
    goal: params.goal,
    target: params.target,
    createdAt: new Date().toISOString(),
    discoveredBy: { model: DISCOVERY_MODEL, discoveryRunId: params.discoveryRunId },
    inputParams: params.result.inputParams,
    outputs: params.result.outputs,
    steps: params.result.steps.map((s) => generalizeStep(s, params.result.literalValuesByParam)),
    overallCheckpoint: generalizeCheckpoint(
      { kind: "textVisible", value: terminal.signatureText, description: terminal.message ?? "Goal achieved" },
      params.result.literalValuesByParam
    ),
    businessOutcomes: params.existing?.businessOutcomes ?? [],
    escalationTriggers: params.existing?.escalationTriggers ?? [],
    riskSummary: {
      hasRiskySteps: params.result.steps.some((s) => s.risk === "risky"),
      justification:
        params.result.steps
          .filter((s) => s.risk === "risky")
          .map((s) => s.riskRationale)
          .join(" ") || "No risky steps."
    }
  };
}

export function appendBusinessOutcome(artifact: CapabilityArtifact, terminal: DiscoveryTerminal): CapabilityArtifact {
  if (!terminal.signatureText || !terminal.label) {
    throw new Error("business_outcome terminal is missing label and/or terminalSignatureText");
  }
  return {
    ...artifact,
    businessOutcomes: [
      ...artifact.businessOutcomes.filter((r) => r.label !== terminal.label),
      {
        label: terminal.label,
        match: { kind: "textVisible", value: terminal.signatureText, description: terminal.message ?? terminal.label },
        message: terminal.message ?? terminal.label
      }
    ]
  };
}

export function appendEscalationTrigger(artifact: CapabilityArtifact, terminal: DiscoveryTerminal): CapabilityArtifact {
  if (!terminal.signatureText || !terminal.label) {
    throw new Error("escalation terminal is missing label and/or terminalSignatureText");
  }
  return {
    ...artifact,
    escalationTriggers: [
      ...artifact.escalationTriggers.filter((r) => r.label !== terminal.label),
      {
        label: terminal.label,
        match: { kind: "textVisible", value: terminal.signatureText, description: terminal.message ?? terminal.label },
        reason: terminal.message ?? terminal.label
      }
    ]
  };
}
