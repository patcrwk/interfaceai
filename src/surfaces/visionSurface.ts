import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { ActionResult, ActionSpec, Observation, Surface } from "../core/surface.js";
import type { LlmClient } from "../discovery/llmClient.js";
import { readBodyText } from "./pageUtils.js";

// VisionSurface: screenshot + Claude vision coordinate grounding, for the
// deliberately clean-DOM-free /legacy target. Every act() call re-grounds
// against a FRESH screenshot — coordinates are never cached or reused
// across steps, since /legacy's layout shifts with content length (a
// different member ID or nickname changes surrounding text and can move
// everything below it).
//
// Known scope cut (see REPORT.md "Cuts"): selectOption is implemented via
// a keyboard jump-select against the native <select>'s visible option
// text, which only works reliably for short, distinct option labels and
// was not exercised in the real discovery/replay evidence run — the
// demonstrated /legacy flow only needed click + fill.

export const VISION_VIEWPORT = { width: 1280, height: 900 };

export class VisionSurface implements Surface {
  readonly kind = "vision" as const;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly llm: LlmClient
  ) {}

  static async launch(llm: LlmClient, opts: { headless?: boolean } = {}): Promise<VisionSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext({ viewport: VISION_VIEWPORT });
    const page = await context.newPage();
    return new VisionSurface(browser, context, page, llm);
  }

  getPlaywrightPage(): Page {
    return this.page;
  }

  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "load" });
  }

  async observe(): Promise<Observation> {
    const visibleText = await readBodyText(this.page);
    return { url: this.page.url(), title: await this.page.title(), visibleText };
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

    const visionStrategy = action.locator?.strategies.find((s) => s.kind === "visionDescription");
    if (!visionStrategy || visionStrategy.kind !== "visionDescription") {
      return { ok: false, error: "VisionSurface requires a visionDescription locator strategy" };
    }

    const screenshotBuf = await this.screenshot();
    const grounding = await this.llm.groundElement(
      screenshotBuf.toString("base64"),
      visionStrategy.description,
      VISION_VIEWPORT.width,
      VISION_VIEWPORT.height
    );
    if (!grounding.found) {
      return {
        ok: false,
        error: `Vision grounding could not find: ${visionStrategy.description}`,
        strategyUsed: "visionDescription"
      };
    }

    try {
      if (action.type === "click") {
        await this.page.mouse.click(grounding.x, grounding.y);
      } else if (action.type === "fill") {
        await this.page.mouse.click(grounding.x, grounding.y);
        await this.page.keyboard.press("Control+A").catch(() => {});
        await this.page.keyboard.type(action.value ?? "");
      } else if (action.type === "selectOption") {
        await this.page.mouse.click(grounding.x, grounding.y);
        await this.page.keyboard.type(action.value ?? "");
        await this.page.keyboard.press("Enter").catch(() => {});
      }
      // Unlike Playwright's Locator.click(), a raw page.mouse.click() does
      // not auto-wait for a resulting navigation. A real discovery run
      // against /legacy hit "Execution context was destroyed" on the very
      // next observe() call, racing a click's location.href navigation.
      // Waiting for load state here (a no-op if nothing navigated) closes
      // that race for every action type uniformly.
      await this.page.waitForLoadState("load").catch(() => {});
      return { ok: true, strategyUsed: "visionDescription" };
    } catch (err) {
      return { ok: false, error: String(err), strategyUsed: "visionDescription" };
    }
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }
}
