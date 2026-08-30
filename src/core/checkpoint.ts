import type { Checkpoint, LocatorSpec, LocatorStrategy } from "./artifact.js";
import type { ActionSpec, Observation } from "./surface.js";

/**
 * Evaluated against Observation.visibleText / .url, which both DomSurface
 * and VisionSurface populate identically — so checkpoints, business-outcome
 * rules, and escalation-trigger rules all work the same regardless of which
 * surface recorded/replays the artifact.
 */
export function evaluateCheckpoint(checkpoint: Checkpoint, observation: Observation): boolean {
  switch (checkpoint.kind) {
    case "textVisible":
      return observation.visibleText.includes(checkpoint.value);
    case "textNotVisible":
      return !observation.visibleText.includes(checkpoint.value);
    case "urlMatches":
      return new RegExp(checkpoint.value).test(observation.url);
  }
}

/** Replaces "{{paramName}}" placeholders in a string with caller-supplied param values. */
export function resolveTemplate(value: string, params: Record<string, unknown>): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
    if (!(name in params)) {
      throw new Error(`Template references unknown param "${name}"`);
    }
    return String(params[name]);
  });
}

/**
 * A locator strategy's own fields can embed run-specific data too — not
 * just the action's value. A real discovery run against /modern showed
 * this directly: the "View" link's data-testid is per-row
 * ("view-member-M1001"), so the recorded testId strategy itself needed
 * "{{memberId}}" substitution, not just the fill value. Resolved
 * unconditionally; resolveTemplate is a no-op on a string with no
 * placeholders.
 */
function resolveStrategyTemplate(strategy: LocatorStrategy, params: Record<string, unknown>): LocatorStrategy {
  switch (strategy.kind) {
    case "role":
      return { ...strategy, role: resolveTemplate(strategy.role, params), name: resolveTemplate(strategy.name, params) };
    case "label":
      return { ...strategy, label: resolveTemplate(strategy.label, params) };
    case "testId":
      return { ...strategy, testId: resolveTemplate(strategy.testId, params) };
    case "text":
      return { ...strategy, text: resolveTemplate(strategy.text, params) };
    case "css":
      return { ...strategy, selector: resolveTemplate(strategy.selector, params) };
    case "visionDescription":
      return { ...strategy, description: resolveTemplate(strategy.description, params) };
  }
}

function resolveLocatorTemplate(locator: LocatorSpec, params: Record<string, unknown>): LocatorSpec {
  return { ...locator, strategies: locator.strategies.map((s) => resolveStrategyTemplate(s, params)) };
}

export function resolveActionTemplate(action: ActionSpec, params: Record<string, unknown>): ActionSpec {
  const value = action.value === undefined ? undefined : resolveTemplate(action.value, params);
  const locator = action.locator ? resolveLocatorTemplate(action.locator, params) : action.locator;
  return { ...action, value, locator };
}

/**
 * Checkpoints may reference "{{paramName}}" too, e.g. verifying that a
 * search input now shows the member ID that was passed in. Applied
 * unconditionally (it's a no-op for a checkpoint with no placeholders) so
 * callers don't need to special-case it.
 */
export function resolveCheckpointTemplate(checkpoint: Checkpoint, params: Record<string, unknown>): Checkpoint {
  if (!checkpoint.value.includes("{{")) return checkpoint;
  return { ...checkpoint, value: resolveTemplate(checkpoint.value, params) };
}
