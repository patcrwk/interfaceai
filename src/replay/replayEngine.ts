import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileFieldSchema, type CapabilityArtifact, type Step } from "../core/artifact.js";
import { evaluateCheckpoint, resolveActionTemplate, resolveCheckpointTemplate } from "../core/checkpoint.js";
import type { Observation, Surface } from "../core/surface.js";
import type { EvidenceRef, ReplayOutcome } from "../core/types.js";
import type { Allowlist } from "../safety/allowlist.js";
import type { RiskGate } from "../safety/riskGate.js";
import type { Logger } from "../logging/logger.js";
import type { EscalationHandoff } from "../escalation/handoff.js";

// Deterministic replay engine (brief §3.3). Given a saved CapabilityArtifact
// and caller-supplied params, walks the recorded steps in order. No LLM
// call is ever made in this file — every decision (which rule matched,
// whether to retry, whether to escalate) is a lookup against data the
// artifact already declared. The only place a model appears anywhere in
// this codebase's replay path is inside VisionSurface's per-step element
// grounding, which answers "where on this screenshot is X", never "what
// should happen next" — see REPORT.md "Determinism & error handling" for
// why that distinction holds up.
//
// Outcome classification (see also core/types.ts):
//   - Allowlist/schema violations           -> hard_failure, no handoff.
//     A guardrail breach needs a config/artifact fix, not a live override.
//   - Action fails to resolve at all        -> hard_failure.
//     The recorded plan is literally inexecutable against the current
//     page — a structural break needing re-discovery, not something a
//     human clicking around in the moment should paper over silently.
//   - Checkpoint fails, matches businessOutcomes   -> business_outcome.
//   - Checkpoint fails, matches escalationTriggers,
//     or matches nothing recognized                -> raise a live handoff.
//     If an operator is attached and resolves it live, replay continues
//     as if the step had passed; otherwise -> escalated.
//   - Risky step, artifact draft, operator declines -> escalated.

export interface ReplayContext {
  surface: Surface;
  allowlist: Allowlist;
  riskGate: RiskGate;
  logger: Logger;
  handoff: EscalationHandoff;
  evidenceDir: string;
  runId: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ReplayEngine {
  constructor(private readonly ctx: ReplayContext) {}

  async run(artifact: CapabilityArtifact, rawParams: Record<string, unknown>): Promise<ReplayOutcome> {
    const { logger } = this.ctx;
    logger.log({
      event: "replay_start",
      artifactId: artifact.id,
      version: artifact.version,
      status: artifact.status,
      params: rawParams
    });

    const inputSchema = compileFieldSchema(artifact.inputParams);
    const parsedInput = inputSchema.safeParse(rawParams);
    if (!parsedInput.success) {
      return this.hardFailure("$input", "params matching artifact.inputParams", parsedInput.error.message);
    }
    const params = parsedInput.data as Record<string, unknown>;

    if (!this.ctx.allowlist.isUrlAllowed(artifact.target.baseUrl)) {
      return this.hardFailure("$target", "target.baseUrl within allowlist", artifact.target.baseUrl);
    }

    const outputs: Record<string, unknown> = {};

    for (const step of artifact.steps) {
      const outcome = await this.runStep(artifact, step, params, outputs);
      if (outcome) {
        logger.log({ event: "replay_outcome", kind: outcome.kind });
        return outcome;
      }
    }

    const finalObservation = await this.ctx.surface.observe();
    const overallCheckpoint = resolveCheckpointTemplate(artifact.overallCheckpoint, params);
    if (!evaluateCheckpoint(overallCheckpoint, finalObservation)) {
      return this.hardFailure("$overall", overallCheckpoint.description, finalObservation.visibleText.slice(0, 500));
    }

    const outputSchema = compileFieldSchema(artifact.outputs);
    const parsedOutputs = outputSchema.safeParse(outputs);
    if (!parsedOutputs.success) {
      return this.hardFailure("$output", "outputs matching artifact.outputs", parsedOutputs.error.message);
    }

    logger.log({ event: "replay_outcome", kind: "success", outputs: parsedOutputs.data });
    return { kind: "success", outputs: parsedOutputs.data as Record<string, unknown> };
  }

  private async runStep(
    artifact: CapabilityArtifact,
    step: Step,
    params: Record<string, unknown>,
    outputs: Record<string, unknown>
  ): Promise<ReplayOutcome | null> {
    const { surface, allowlist, riskGate, logger } = this.ctx;

    // A business/escalation state can also show up as "the page this step
    // needs to act on doesn't have the expected element at all" — e.g. a
    // "no results" page left behind by the PREVIOUS step has no row to
    // click next. A real replay against a nonexistent member ID surfaced
    // exactly this: it came back hard_failure ("no element matched") on
    // step-3 instead of the business_outcome it should have been, because
    // business/escalation rules were only ever checked after a successful
    // action's checkpoint failed. Checking here too, before attempting to
    // resolve this step's own locator, closes that gap.
    const preObservation = await surface.observe();
    const preMatch = this.matchTerminalRule(artifact, preObservation, params);
    if (preMatch) {
      if (preMatch.kind === "business_outcome") {
        logger.log({ event: "business_outcome", stepId: step.id, label: preMatch.label, detectedBeforeAction: true });
        return { kind: "business_outcome", label: preMatch.label, message: preMatch.message, outputs };
      }
      const handoffResult = await this.ctx.handoff.raise({
        capabilityId: artifact.id,
        goal: artifact.goal,
        stepId: step.id,
        reason: preMatch.reason
      });
      if (!handoffResult.resumed) {
        return {
          kind: "escalated",
          reason: preMatch.reason,
          stepId: step.id,
          evidence: { screenshotPath: handoffResult.screenshotPath, logRef: handoffResult.logRef }
        };
      }
      logger.log({ event: "escalation_resolved", stepId: step.id, detectedBeforeAction: true });
      // Operator says it's fixed — fall through and attempt this step's action as normal.
    }

    if (step.risk === "risky") {
      const approved = await riskGate.authorize(artifact, step);
      logger.log({ event: "risk_gate", stepId: step.id, artifactStatus: artifact.status, approved });
      if (!approved) {
        const evidence = await this.captureEvidence(step.id);
        return {
          kind: "escalated",
          reason: `Risky step "${step.id}" was not authorized to proceed.`,
          stepId: step.id,
          evidence
        };
      }
    }

    const resolvedAction = resolveActionTemplate(step.action, params);

    if (!allowlist.isActionTypeAllowed(resolvedAction.type)) {
      logger.log({ event: "allowlist_violation", stepId: step.id, actionType: resolvedAction.type });
      return this.hardFailure(step.id, "action type permitted by allowlist", resolvedAction.type);
    }
    if (resolvedAction.type === "navigate" && resolvedAction.value && !allowlist.isUrlAllowed(resolvedAction.value)) {
      logger.log({ event: "allowlist_violation", stepId: step.id, url: resolvedAction.value });
      return this.hardFailure(step.id, "URL within allowlist", resolvedAction.value);
    }

    const result = await surface.act(resolvedAction);
    logger.log({
      event: "action",
      stepId: step.id,
      description: step.description,
      actionType: resolvedAction.type,
      value: resolvedAction.value,
      ok: result.ok,
      strategyUsed: result.strategyUsed,
      error: result.error
    });

    if (!result.ok) {
      return this.hardFailure(step.id, step.action.locator?.description ?? step.description, result.error ?? "action failed");
    }

    return this.checkStepOutcome(artifact, step, params, outputs);
  }

  private async checkStepOutcome(
    artifact: CapabilityArtifact,
    step: Step,
    params: Record<string, unknown>,
    outputs: Record<string, unknown>
  ): Promise<ReplayOutcome | null> {
    const { surface, logger } = this.ctx;
    // Checkpoints/rules may reference "{{paramName}}" (e.g. verifying a
    // page shows the specific member ID passed in this run) — resolved
    // once per call against this run's params, same as action values.
    const checkpoint = step.checkpoint ? resolveCheckpointTemplate(step.checkpoint, params) : null;

    let observation = await surface.observe();
    if (!checkpoint || evaluateCheckpoint(checkpoint, observation)) {
      this.extract(step, observation, outputs);
      return null;
    }

    for (const rule of step.recoverable) {
      const match = resolveCheckpointTemplate(rule.match, params);
      for (let attempt = 1; attempt <= rule.maxAttempts; attempt++) {
        if (!evaluateCheckpoint(match, observation)) break;
        logger.log({ event: "recoverable", stepId: step.id, rule: rule.description, attempt });
        if (rule.handling === "dismissAndRetry" && rule.dismissAction) {
          await surface.act(resolveActionTemplate(rule.dismissAction, params));
        } else {
          await delay(200);
        }
        observation = await surface.observe();
        if (checkpoint && evaluateCheckpoint(checkpoint, observation)) {
          this.extract(step, observation, outputs);
          return null;
        }
      }
    }

    const match = this.matchTerminalRule(artifact, observation, params);
    if (match?.kind === "business_outcome") {
      logger.log({ event: "business_outcome", stepId: step.id, label: match.label });
      this.extract(step, observation, outputs);
      return { kind: "business_outcome", label: match.label, message: match.message, outputs };
    }
    const reason =
      match?.kind === "escalation"
        ? match.reason
        : `Step "${step.id}" checkpoint failed and no rule recognized the resulting state.`;

    const handoffResult = await this.ctx.handoff.raise({
      capabilityId: artifact.id,
      goal: artifact.goal,
      stepId: step.id,
      reason
    });

    if (handoffResult.resumed) {
      const reobserved = await surface.observe();
      if (!checkpoint || evaluateCheckpoint(checkpoint, reobserved)) {
        logger.log({ event: "escalation_resolved", stepId: step.id });
        this.extract(step, reobserved, outputs);
        return null;
      }
    }

    return {
      kind: "escalated",
      reason,
      stepId: step.id,
      evidence: { screenshotPath: handoffResult.screenshotPath, logRef: handoffResult.logRef }
    };
  }

  /** Shared by the pre-action check (runStep) and the post-checkpoint-failure cascade (checkStepOutcome). */
  private matchTerminalRule(
    artifact: CapabilityArtifact,
    observation: Observation,
    params: Record<string, unknown>
  ): { kind: "business_outcome"; label: string; message: string } | { kind: "escalation"; reason: string } | null {
    for (const rule of artifact.businessOutcomes) {
      if (evaluateCheckpoint(resolveCheckpointTemplate(rule.match, params), observation)) {
        return { kind: "business_outcome", label: rule.label, message: rule.message };
      }
    }
    const escalationRule = artifact.escalationTriggers.find((r) =>
      evaluateCheckpoint(resolveCheckpointTemplate(r.match, params), observation)
    );
    return escalationRule ? { kind: "escalation", reason: escalationRule.reason } : null;
  }

  private extract(step: Step, observation: Observation, outputs: Record<string, unknown>): void {
    for (const ext of step.extract) {
      const match = new RegExp(ext.pattern).exec(observation.visibleText);
      if (!match || match[1] === undefined) continue;
      if (ext.transform !== "number") {
        outputs[ext.outputField] = match[1];
        continue;
      }
      // A discovery-authored capture group over natural-language UI text
      // isn't always clean — real runs surfaced both thousands separators
      // ("$15,320.00") and a capture group that greedily swallowed the
      // sentence-ending period ("75.00." from "...balance of $75.00.").
      // Rather than trust the group verbatim, pull the actual numeric
      // substring out of it; skip the field (not NaN) if there isn't one.
      const numeric = match[1].replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      if (numeric) outputs[ext.outputField] = Number(numeric[0]);
    }
  }

  private async hardFailure(stepId: string, expected: string, observed: string): Promise<ReplayOutcome> {
    const evidence = await this.captureEvidence(stepId);
    this.ctx.logger.log({ event: "replay_outcome", kind: "hard_failure", stepId, expected, observed });
    return { kind: "hard_failure", stepId, expected, observed, evidence };
  }

  private async captureEvidence(stepId: string): Promise<EvidenceRef> {
    mkdirSync(this.ctx.evidenceDir, { recursive: true });
    const buf = await this.ctx.surface.screenshot();
    const filePath = path.join(this.ctx.evidenceDir, `${this.ctx.runId}-${stepId}-${Date.now()}.png`);
    writeFileSync(filePath, buf);
    const logRef = this.ctx.logger.log({ event: "evidence_captured", stepId, screenshotPath: filePath });
    return { screenshotPath: filePath, logRef };
  }
}
