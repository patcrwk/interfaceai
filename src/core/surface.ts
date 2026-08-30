import type { ActionSpec, ActionType, LocatorSpec, LocatorStrategy } from "./artifact.js";

// The Surface abstraction. Both DomSurface (clean DOM, role/label/testId
// locators) and VisionSurface (screenshot + coordinate grounding) implement
// this same interface, and so does FakeSurface (in-memory, used only by
// unit tests). Discovery and replay code is written against this interface
// and never against a concrete implementation — see ARCHITECTURE.md
// "Key seams" for why this is also the extension point for a frameset-based
// legacy app or a native desktop accessibility-tree surface.
//
// Locator/action shapes live in core/artifact.ts (the schema that gets
// persisted) and are re-exported here so Surface implementations and
// artifact code share one definition.

export type { ActionSpec, ActionType, LocatorSpec, LocatorStrategy };

export interface ElementSummary {
  tag: string;
  role?: string;
  accessibleName?: string;
  testId?: string;
  text?: string;
  /** Current value of an input/textarea/select — not reflected in visibleText, so this is the only way a decision-maker can confirm a prior fill took effect. */
  currentValue?: string;
}

export interface Observation {
  url: string;
  title: string;
  /**
   * Full visible text content of the page. Used for checkpoint
   * verification and business-outcome/escalation detection — this works
   * identically for both DOM variants, since even the deliberately messy
   * /legacy markup still has real text content.
   */
  visibleText: string;
  /**
   * DomSurface-only: a serialized list of interactive elements (role,
   * accessible name, testId, text) the discovery loop reasons over to pick
   * a locator strategy. Left undefined by VisionSurface (which reasons over
   * a screenshot instead) and FakeSurface.
   */
  interactiveElements?: ElementSummary[];
}

export interface ActionResult {
  ok: boolean;
  /** Which strategy in the locator's fallback chain actually resolved the element, if any. */
  strategyUsed?: LocatorStrategy["kind"];
  error?: string;
}

export interface Surface {
  readonly kind: "dom" | "vision" | "fake";

  navigate(url: string): Promise<void>;

  observe(): Promise<Observation>;

  /** PNG bytes of the current viewport. DomSurface uses this only for escalation evidence; VisionSurface uses it for every grounding call too. */
  screenshot(): Promise<Buffer>;

  act(action: ActionSpec): Promise<ActionResult>;

  close(): Promise<void>;

  /**
   * Escape hatch for the escalation/handoff module only: exposes the raw
   * Playwright Page so it can inject a human-action event listener during a
   * live handoff. Core engine logic (ReplayEngine, discovery loop) must
   * never call this — it only exists so DomSurface/VisionSurface can be
   * instrumented without widening the Surface contract every other
   * consumer depends on. FakeSurface returns undefined.
   */
  getPlaywrightPage?(): import("playwright").Page | undefined;
}
