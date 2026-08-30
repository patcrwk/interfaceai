import type { Page } from "playwright";

/**
 * Shared by DomSurface and VisionSurface. A page.evaluate() can race an
 * in-flight navigation and throw "Execution context was destroyed" — a
 * real /legacy discovery run hit exactly this, immediately after a raw
 * page.mouse.click() triggered a location.href navigation with nothing to
 * make the caller wait for it. Waiting for load state after every action
 * (see visionSurface.ts) closes most of that race; this is a cheap second
 * line of defense for whatever's left (e.g. a slow client-side redirect).
 */
export async function readBodyText(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.body.innerText);
  } catch (err) {
    if (String(err).includes("Execution context was destroyed")) {
      await page.waitForLoadState("load").catch(() => {});
      return page.evaluate(() => document.body.innerText);
    }
    throw err;
  }
}
