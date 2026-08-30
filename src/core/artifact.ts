import { z } from "zod";

// The CapabilityArtifact schema — the typed, reusable record of "how to do
// this thing," produced once by discovery and executed many times by
// replay. This file is the single source of truth for the artifact shape;
// core/surface.ts imports the locator/action types from here rather than
// redefining them, so discovery-time and replay-time code can never drift
// out of sync with what's actually persisted to disk.
//
// Design notes (see REPORT.md "Artifact schema" for the full rationale):
//   - Locator fallback chains are ordered most-robust-first: role/name
//     (accessibility-tree semantics, survives styling/copy changes) before
//     label, before testId (stable but vendor UIs may not have them),
//     before text (fragile to copy/i18n changes), before css (most brittle,
//     tied to DOM/class structure). visionDescription is the sole strategy
//     for VisionSurface, since /legacy has no roles/labels/testIds to fall
//     back to at all.
//   - Recorded step values never contain literal discovery-time data
//     (member IDs, names, dollar amounts). Anything variable is a
//     "{{paramName}}" placeholder resolved from caller-supplied inputParams
//     at replay time. This means artifacts don't need after-the-fact PII
//     scrubbing for the common case — they're PII-free by construction.
//     The redaction layer (safety/redaction.ts) exists for the log stream,
//     which does need to record literal runtime values for audit purposes.
//   - Checkpoints and business/escalation rules are matched against
//     Observation.visibleText, not DOM structure — so they work identically
//     for DomSurface and VisionSurface, and don't require either surface to
//     expose anything beyond plain page text.

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string() }),
  z.object({ kind: z.literal("label"), label: z.string() }),
  z.object({ kind: z.literal("testId"), testId: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("css"), selector: z.string() }),
  z.object({ kind: z.literal("visionDescription"), description: z.string() })
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorSpecSchema = z.object({
  description: z.string(),
  strategies: z.array(LocatorStrategySchema).min(1),
  rationale: z.string()
});
export type LocatorSpec = z.infer<typeof LocatorSpecSchema>;

export const ActionTypeSchema = z.enum(["click", "fill", "selectOption", "navigate", "observe"]);
export type ActionType = z.infer<typeof ActionTypeSchema>;

export const ActionSpecSchema = z.object({
  type: ActionTypeSchema,
  locator: LocatorSpecSchema.optional(),
  value: z.string().optional()
});
export type ActionSpec = z.infer<typeof ActionSpecSchema>;

export const CheckpointSchema = z.object({
  kind: z.enum(["textVisible", "textNotVisible", "urlMatches"]),
  value: z.string(),
  description: z.string()
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const FieldTypeSchema = z.enum(["string", "number", "boolean"]);

export const FieldSpecSchema = z.object({
  name: z.string(),
  type: FieldTypeSchema,
  description: z.string(),
  required: z.boolean().default(true)
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

export const RecoverableRuleSchema = z.object({
  description: z.string(),
  match: CheckpointSchema,
  handling: z.enum(["retry", "dismissAndRetry"]),
  dismissAction: ActionSpecSchema.optional(),
  maxAttempts: z.number().int().positive().default(3)
});
export type RecoverableRule = z.infer<typeof RecoverableRuleSchema>;

export const ExtractionSchema = z.object({
  outputField: z.string(),
  /** Regex source with exactly one capture group, applied to Observation.visibleText. */
  pattern: z.string(),
  transform: z.enum(["string", "number"]).default("string")
});
export type Extraction = z.infer<typeof ExtractionSchema>;

export const StepSchema = z.object({
  id: z.string(),
  description: z.string(),
  action: ActionSpecSchema,
  risk: z.enum(["safe", "risky"]),
  riskRationale: z.string(),
  checkpoint: CheckpointSchema.nullable(),
  recoverable: z.array(RecoverableRuleSchema).default([]),
  extract: z.array(ExtractionSchema).default([])
});
export type Step = z.infer<typeof StepSchema>;

export const BusinessOutcomeRuleSchema = z.object({
  label: z.string(),
  match: CheckpointSchema,
  message: z.string()
});
export type BusinessOutcomeRule = z.infer<typeof BusinessOutcomeRuleSchema>;

export const EscalationTriggerRuleSchema = z.object({
  label: z.string(),
  match: CheckpointSchema,
  reason: z.string()
});
export type EscalationTriggerRule = z.infer<typeof EscalationTriggerRuleSchema>;

export const CapabilityArtifactSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  /** draft: risky steps require a live confirmation prompt before running. approved: risky steps run unattended (still allowlist-checked, still logged). See safety/riskGate.ts. */
  status: z.enum(["draft", "approved"]),
  goal: z.string(),
  target: z.object({
    surface: z.enum(["dom", "vision"]),
    baseUrl: z.string()
  }),
  createdAt: z.string(),
  discoveredBy: z.object({
    model: z.string(),
    discoveryRunId: z.string()
  }),
  inputParams: z.array(FieldSpecSchema),
  outputs: z.array(FieldSpecSchema),
  steps: z.array(StepSchema).min(1),
  /** Success condition for the flow as a whole, checked after the last step. */
  overallCheckpoint: CheckpointSchema,
  /** Legitimate non-error terminal results, e.g. "no such member". Checked after every step; first match wins and short-circuits remaining steps. */
  businessOutcomes: z.array(BusinessOutcomeRuleSchema).default([]),
  /** Known conditions replay can't safely resolve alone, e.g. a compliance hold requiring supervisor override. Checked after every step, before falling through to hard_failure. */
  escalationTriggers: z.array(EscalationTriggerRuleSchema).default([]),
  riskSummary: z.object({
    hasRiskySteps: z.boolean(),
    justification: z.string()
  })
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

/**
 * Compiles a declared field list (artifact.inputParams or artifact.outputs)
 * into a real Zod object schema, so caller-supplied input params and
 * extracted outputs are validated against the artifact's own declared
 * types at replay time — not just documented in a comment.
 */
export function compileFieldSchema(fields: FieldSpec[]): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let base: z.ZodTypeAny =
      field.type === "string" ? z.string() : field.type === "number" ? z.number() : z.boolean();
    if (!field.required) base = base.optional();
    shape[field.name] = base;
  }
  return z.object(shape);
}
