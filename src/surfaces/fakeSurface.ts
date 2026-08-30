import type { ActionResult, ActionSpec, LocatorSpec, LocatorStrategy, Observation, Surface } from "../core/surface.js";

// In-memory Surface used only by unit tests. Lets tests define a tiny
// screen graph (url -> text + interactive elements) and drive ReplayEngine
// against it without a browser or network — this is what "npm test must
// run with no browser and no API key" is exercised against.

export interface FakeElement {
  strategies: LocatorStrategy[];
  onClick?: (surface: FakeSurface) => void;
  onSetValue?: (value: string, surface: FakeSurface) => void;
}

export interface FakeScreen {
  url: string;
  /** Lazy so it can reflect state mutated by earlier onClick/onSetValue handlers. */
  text: () => string;
  elements: FakeElement[];
}

function strategiesEqual(a: LocatorStrategy, b: LocatorStrategy): boolean {
  if (a.kind !== b.kind) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export class FakeSurface implements Surface {
  readonly kind = "fake" as const;
  private screens: Map<string, FakeScreen>;
  private currentUrl: string;

  constructor(screens: FakeScreen[], startUrl: string) {
    this.screens = new Map(screens.map((s) => [s.url, s]));
    this.currentUrl = startUrl;
  }

  goto(url: string): void {
    if (!this.screens.has(url)) {
      throw new Error(`FakeSurface: no screen registered for "${url}"`);
    }
    this.currentUrl = url;
  }

  async navigate(url: string): Promise<void> {
    this.goto(url);
  }

  async observe(): Promise<Observation> {
    const screen = this.requireScreen();
    return { url: this.currentUrl, title: screen.url, visibleText: screen.text() };
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(`fake-screenshot:${this.currentUrl}`);
  }

  async act(action: ActionSpec): Promise<ActionResult> {
    if (action.type === "navigate") {
      if (action.value === undefined) return { ok: false, error: "navigate action missing value" };
      try {
        this.goto(action.value);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    if (action.type === "observe") {
      return { ok: true };
    }

    if (!action.locator) return { ok: false, error: `action type "${action.type}" requires a locator` };
    const screen = this.requireScreen();
    const resolved = this.resolve(screen, action.locator);
    if (!resolved) {
      return { ok: false, error: `No element matched locator: ${action.locator.description}` };
    }
    const { element, strategyUsed } = resolved;

    if (action.type === "click") {
      element.onClick?.(this);
    } else if (action.type === "fill" || action.type === "selectOption") {
      element.onSetValue?.(action.value ?? "", this);
    }
    return { ok: true, strategyUsed };
  }

  async close(): Promise<void> {
    // nothing to release
  }

  private requireScreen(): FakeScreen {
    const screen = this.screens.get(this.currentUrl);
    if (!screen) throw new Error(`FakeSurface: unknown current url "${this.currentUrl}"`);
    return screen;
  }

  private resolve(
    screen: FakeScreen,
    locator: LocatorSpec
  ): { element: FakeElement; strategyUsed: LocatorStrategy["kind"] } | null {
    for (const strategy of locator.strategies) {
      const match = screen.elements.find((el) => el.strategies.some((s) => strategiesEqual(s, strategy)));
      if (match) return { element: match, strategyUsed: strategy.kind };
    }
    return null;
  }
}
