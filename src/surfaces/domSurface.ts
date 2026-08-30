import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import type { ActionResult, ActionSpec, LocatorSpec, LocatorStrategy, Observation, Surface } from "../core/surface.js";
import { readBodyText } from "./pageUtils.js";

// DomSurface: role/label/testId/text/css locators with a fallback chain,
// for a clean-DOM target (/modern). Element resolution happens live against
// the current page on every call — there's no caching of a stale selector
// result across steps.

export class DomSurface implements Surface {
  readonly kind = "dom" as const;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page
  ) {}

  static async launch(opts: { headless?: boolean } = {}): Promise<DomSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext();
    const page = await context.newPage();
    return new DomSurface(browser, context, page);
  }

  getPlaywrightPage(): Page {
    return this.page;
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async observe(): Promise<Observation> {
    const visibleText = await readBodyText(this.page);
    const interactiveElements = await this.page.evaluate(() => {
      const nodes = document.querySelectorAll<HTMLElement>(
        "a, button, input, select, textarea, [role], [data-testid], [onclick]"
      );
      const out: {
        tag: string;
        role?: string;
        accessibleName?: string;
        testId?: string;
        text?: string;
        currentValue?: string;
      }[] = [];
      nodes.forEach((el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute("role") ?? undefined;
        const testId = el.getAttribute("data-testid") ?? undefined;
        const ariaLabel = el.getAttribute("aria-label") ?? undefined;
        const placeholder = (el as HTMLInputElement).placeholder || undefined;
        const text = el.innerText?.trim().slice(0, 80) || undefined;
        const accessibleName = ariaLabel || placeholder || text;
        // innerText does NOT reflect form field values (an <input>'s typed
        // value isn't part of the rendered text), so without this a model
        // has no way to see that a fill it already performed took effect —
        // it will just keep re-filling the same field. Surfacing the live
        // .value here is what fixed that in the first real discovery run.
        const currentValue =
          tag === "input" || tag === "textarea" || tag === "select"
            ? (el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value || undefined
            : undefined;
        out.push({ tag, role, accessibleName, testId, text, currentValue });
      });
      return out.slice(0, 60);
    });
    return { url: this.page.url(), title: await this.page.title(), visibleText, interactiveElements };
  }

  async screenshot(): Promise<Buffer> {
    return this.page.screenshot();
  }

  async act(action: ActionSpec): Promise<ActionResult> {
    if (action.type === "navigate") {
      if (!action.value) return { ok: false, error: "navigate action missing value" };
      try {
        await this.navigate(action.value);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
    if (action.type === "observe") return { ok: true };
    if (!action.locator) return { ok: false, error: `action type "${action.type}" requires a locator` };

    const resolved = await this.resolve(action.locator);
    if (!resolved) return { ok: false, error: `No element matched locator: ${action.locator.description}` };
    const { locator, strategyUsed } = resolved;

    try {
      if (action.type === "click") {
        await locator.click({ timeout: 5000 });
      } else if (action.type === "fill") {
        await locator.fill(action.value ?? "", { timeout: 5000 });
      } else if (action.type === "selectOption") {
        await locator.selectOption(action.value ?? "", { timeout: 5000 });
      }
      return { ok: true, strategyUsed };
    } catch (err) {
      return { ok: false, error: String(err), strategyUsed };
    }
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  private async resolve(
    spec: LocatorSpec
  ): Promise<{ locator: Locator; strategyUsed: LocatorStrategy["kind"] } | null> {
    for (const strategy of spec.strategies) {
      const locator = this.buildLocator(strategy);
      if (!locator) continue; // e.g. visionDescription — not applicable to DomSurface
      try {
        const count = await locator.count();
        if (count > 0) return { locator: locator.first(), strategyUsed: strategy.kind };
      } catch {
        // Malformed selector for this strategy; fall through to the next one in the chain.
      }
    }
    return null;
  }

  private buildLocator(strategy: LocatorStrategy): Locator | null {
    switch (strategy.kind) {
      case "role":
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return this.page.getByRole(strategy.role as any, { name: strategy.name });
      case "label":
        return this.page.getByLabel(strategy.label);
      case "testId":
        return this.page.getByTestId(strategy.testId);
      case "text":
        return this.page.getByText(strategy.text);
      case "css":
        return this.page.locator(strategy.selector);
      case "visionDescription":
        return null;
    }
  }
}
