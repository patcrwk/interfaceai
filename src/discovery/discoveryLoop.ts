import type { Extraction, FieldSpec, LocatorSpec, Step } from "../core/artifact.js";
import type { Surface } from "../core/surface.js";
import type { Logger } from "../logging/logger.js";
import type { LlmDecider } from "./llmClient.js";
import type { ActionInput, LocatorStrategyInput } from "./types.js";

// The goal-driven discovery loop (brief §3.1). Observe -> decide -> act
// against the LIVE target app until the goal is met or a stopping
// condition fires (max steps, wall-clock timeout, consecutive failures, or
// the model declaring itself stuck). Every decision and action is logged.
//
// This never pre-scripts anything: each iteration hands the current
// Surface.observe() result (and a screenshot, for VisionSurface) to the
// model and executes exactly what it decides, for real, against the
// running target app.

export interface DiscoveryStopCondition {
  maxSteps: number;
  maxConsecutiveFailures: number;
  timeoutMs: number;
}

export const DEFAULT_STOP_CONDITION: DiscoveryStopCondition = {
  maxSteps: 20,
  maxConsecutiveFailures: 2,
  timeoutMs: 5 * 60 * 1000
};

export type DiscoveryTerminalKind = "goal_met" | "business_outcome" | "escalation" | "stuck";

export interface DiscoveryTerminal {
  kind: DiscoveryTerminalKind;
  label?: string;
  message?: string;
  signatureText?: string;
  reason?: string;
}

export interface DiscoveryResult {
  steps: Step[];
  inputParams: FieldSpec[];
  outputs: FieldSpec[];
  terminal: DiscoveryTerminal;
  /**
   * paramRef -> the literal value actually typed during this run (e.g.
   * memberId -> "M1001"). Not persisted in the artifact itself — used only
   * by artifactCompiler's generalization pass, which substitutes these
   * literals back to "{{paramName}}" in any checkpoint the model forgot to
   * parameterize itself. The model applies paramRef to action values
   * reliably but is inconsistent about echoing it into checkpoints, so
   * this closes that gap deterministically rather than depending on the
   * model to get every field right.
   */
  literalValuesByParam: Record<string, string>;
}

function buildLocatorSpec(surfaceKind: Surface["kind"], action: ActionInput): LocatorSpec | undefined {
  if (action.type === "navigate" || action.type === "observe") return undefined;
  const description = action.locatorDescription ?? "unspecified element";
  if (surfaceKind === "vision") {
    return { description, strategies: [{ kind: "visionDescription", description }], rationale: "VisionSurface targets by screenshot grounding only; there is no DOM to fall back to." };
  }
  const strategies: LocatorStrategyInput[] = action.strategies && action.strategies.length > 0
    ? action.strategies
    : [{ kind: "text", text: description }];
  return { description, strategies, rationale: action.rationale ?? "" };
}

export async function runDiscovery(
  surface: Surface,
  llm: LlmDecider,
  goal: string,
  startUrl: string,
  logger: Logger,
  stop: DiscoveryStopCondition = DEFAULT_STOP_CONDITION
): Promise<DiscoveryResult> {
  // ReplayEngine deliberately never navigates anywhere implicitly — an
  // artifact must be fully self-contained, so the initial navigation has
  // to be a recorded step, not something the CLI does outside the loop
  // before handing off to discovery. (A first real run without this step
  // produced an artifact that replayed straight into a hard_failure on
  // step-1, since a freshly launched Surface starts at about:blank.)
  await surface.navigate(startUrl);
  const steps: Step[] = [
    {
      id: "step-0",
      description: `Navigate to ${startUrl}`,
      action: { type: "navigate", value: startUrl },
      risk: "safe",
      riskRationale: "Navigation alone has no side effects.",
      checkpoint: null,
      recoverable: [],
      extract: []
    }
  ];
  const historySummary: string[] = [`Navigate to ${startUrl}`];
  const inputParamsByName = new Map<string, FieldSpec>();
  const outputsByName = new Map<string, FieldSpec>();
  const literalValuesByParam: Record<string, string> = {};
  let consecutiveFailures = 0;
  const startedAt = Date.now();

  const finish = (terminal: DiscoveryTerminal): DiscoveryResult => ({
    steps,
    inputParams: [...inputParamsByName.values()],
    outputs: [...outputsByName.values()],
    literalValuesByParam,
    terminal
  });

  for (let i = 0; i < stop.maxSteps; i++) {
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= stop.timeoutMs) {
      const terminal: DiscoveryTerminal = {
        kind: "stuck",
        reason: `Exceeded wall-clock timeout (${stop.timeoutMs}ms) after ${i} steps.`
      };
      logger.log({ event: "discovery_terminal", terminal });
      return finish(terminal);
    }

    const observation = await surface.observe();
    const screenshotBase64 =
      surface.kind === "vision" ? (await surface.screenshot()).toString("base64") : undefined;

    const decision = await llm.decide({
      goal,
      historySummary,
      visibleText: observation.visibleText,
      interactiveElements: observation.interactiveElements,
      screenshotBase64
    });
    logger.log({ event: "discovery_decision", step: i, url: observation.url, decision });

    if (decision.status !== "continue") {
      // A real run reached goal_met but omitted terminalSignatureText,
      // which artifactCompiler requires — surfacing as a crash well after
      // the fact, outside the loop. Same fix pattern as the missing-status
      // case: validate here and give the model one more turn to correct
      // itself rather than failing the whole run over a missing field.
      const missingSignature = !decision.terminalSignatureText;
      const missingLabel =
        (decision.status === "business_outcome" || decision.status === "escalation") && !decision.terminalLabel;
      if (missingSignature || missingLabel) {
        logger.log({ event: "discovery_decision_incomplete", step: i, status: decision.status, missingSignature, missingLabel });
        historySummary.push(
          `(Your status="${decision.status}" response was rejected: it must include terminalSignatureText` +
            `${missingLabel ? " and terminalLabel" : ""}. Please resend it with those fields filled in.)`
        );
        continue;
      }

      const terminal: DiscoveryTerminal = {
        kind: decision.status,
        label: decision.terminalLabel,
        message: decision.terminalMessage,
        signatureText: decision.terminalSignatureText,
        reason: decision.reason
      };
      logger.log({ event: "discovery_terminal", terminal });
      return finish(terminal);
    }

    const action = decision.action;
    if (!action) {
      logger.log({ event: "discovery_error", message: "status=continue but no action provided" });
      return finish({ kind: "stuck", reason: "Model returned status=continue without an action." });
    }

    const locator = buildLocatorSpec(surface.kind, action);
    const recordedValue = action.paramRef ? `{{${action.paramRef}}}` : action.value;

    const execResult = await surface.act({ type: action.type, locator, value: action.value });
    logger.log({
      event: "discovery_action",
      step: i,
      actionType: action.type,
      locatorDescription: action.locatorDescription,
      ok: execResult.ok,
      strategyUsed: execResult.strategyUsed,
      error: execResult.error
    });

    if (!execResult.ok) {
      consecutiveFailures++;
      historySummary.push(`(failed) ${action.type} on ${action.locatorDescription ?? "?"}: ${execResult.error}`);
      if (consecutiveFailures >= stop.maxConsecutiveFailures) {
        const terminal: DiscoveryTerminal = {
          kind: "stuck",
          reason: `${consecutiveFailures} consecutive action failures. Last error: ${execResult.error}`
        };
        logger.log({ event: "discovery_terminal", terminal });
        return finish(terminal);
      }
      continue; // let the model see the failure and try something else
    }
    consecutiveFailures = 0;

    if (action.paramRef) {
      if (!inputParamsByName.has(action.paramRef)) {
        inputParamsByName.set(action.paramRef, {
          name: action.paramRef,
          type: action.paramType ?? "string",
          description: action.locatorDescription ? `Value supplied for: ${action.locatorDescription}` : action.paramRef,
          required: true
        });
      }
      if (action.value !== undefined) literalValuesByParam[action.paramRef] = action.value;
    }

    const extract: Extraction[] = (action.extract ?? []).map((e) => ({
      outputField: e.outputField,
      pattern: e.pattern,
      transform: e.type === "number" ? "number" : "string"
    }));
    for (const e of action.extract ?? []) {
      if (!outputsByName.has(e.outputField)) {
        outputsByName.set(e.outputField, { name: e.outputField, type: e.type, description: e.description, required: false });
      }
    }

    // Discovery doesn't just record an extraction pattern on faith — it
    // tests it against the live page right now and reports the result back
    // into the model's own history. Without this, a real run showed the
    // model has no way to tell whether its regex actually matches anything,
    // so it just kept "refining" the same pattern in an unbounded loop of
    // observe-only steps that never progressed the goal.
    let extractionFeedback = "";
    if (extract.length > 0) {
      const afterObservation = await surface.observe();
      const results = extract.map((e) => {
        const match = new RegExp(e.pattern).exec(afterObservation.visibleText);
        return match && match[1] !== undefined
          ? `"${e.outputField}" matched: ${match[1]}`
          : `"${e.outputField}" did NOT match anything on the current page — this pattern or step is wrong`;
      });
      extractionFeedback = ` [${results.join("; ")}]`;
      logger.log({ event: "discovery_extraction_check", step: i, results });
    }

    steps.push({
      id: `step-${i + 1}`,
      description: action.locatorDescription
        ? `${action.type} on ${action.locatorDescription}`
        : `${action.type}${action.value ? ` ${action.value}` : ""}`,
      action: { type: action.type, locator, value: recordedValue },
      risk: action.risk,
      riskRationale: action.riskRationale,
      checkpoint: action.checkpoint ?? null,
      recoverable: [],
      extract
    });
    historySummary.push(steps[steps.length - 1]!.description + extractionFeedback);
  }

  const terminal: DiscoveryTerminal = { kind: "stuck", reason: `Exceeded max steps (${stop.maxSteps}) without reaching a terminal state.` };
  logger.log({ event: "discovery_terminal", terminal });
  return finish(terminal);
}
