import { z } from "zod";

// The structured decision Claude returns at every discovery step, via a
// forced tool-use call (never free-text parsing). Validated at runtime with
// this same schema even though the tool's JSON schema already constrains
// the shape, since a model response is still untrusted input.

export const LocatorStrategyInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string() }),
  z.object({ kind: z.literal("label"), label: z.string() }),
  z.object({ kind: z.literal("testId"), testId: z.string() }),
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("css"), selector: z.string() })
]);
export type LocatorStrategyInput = z.infer<typeof LocatorStrategyInputSchema>;

export const CheckpointInputSchema = z.object({
  kind: z.enum(["textVisible", "textNotVisible", "urlMatches"]),
  value: z.string(),
  description: z.string()
});

export const ExtractInputSchema = z.object({
  outputField: z.string(),
  description: z.string(),
  type: z.enum(["string", "number", "boolean"]),
  pattern: z.string()
});

export const ActionInputSchema = z.object({
  type: z.enum(["click", "fill", "selectOption", "navigate", "observe"]),
  value: z.string().optional(),
  paramRef: z.string().optional(),
  paramType: z.enum(["string", "number", "boolean"]).optional(),
  locatorDescription: z.string().optional(),
  strategies: z.array(LocatorStrategyInputSchema).optional(),
  rationale: z.string().optional(),
  risk: z.enum(["safe", "risky"]),
  riskRationale: z.string(),
  checkpoint: CheckpointInputSchema.optional(),
  extract: z.array(ExtractInputSchema).optional()
});
export type ActionInput = z.infer<typeof ActionInputSchema>;

const StatusSchema = z.enum(["continue", "goal_met", "business_outcome", "escalation", "stuck"]);

export const DecisionSchema = z.object({
  thought: z.string(),
  status: StatusSchema,
  action: ActionInputSchema.optional(),
  terminalLabel: z.string().optional(),
  terminalMessage: z.string().optional(),
  terminalSignatureText: z.string().optional(),
  reason: z.string().optional()
});
export type Decision = z.infer<typeof DecisionSchema>;

/**
 * A real discovery run consistently showed the model omitting `status`
 * on turns where it clearly intends to continue (i.e. it supplies
 * `action` and nothing else) — reproducible across separate runs, not
 * transient noise, so retrying the same call doesn't help. Rather than
 * fight the model, this raw schema accepts that shape and llmClient
 * normalizes it: status defaults to "continue" when an action is present
 * and status is omitted.
 */
export const RawDecisionSchema = DecisionSchema.extend({ status: StatusSchema.optional() });
export type RawDecision = z.infer<typeof RawDecisionSchema>;

export interface GroundingResult {
  found: boolean;
  x: number;
  y: number;
}
