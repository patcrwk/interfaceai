import { createInterface } from "node:readline/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Surface } from "../core/surface.js";
import type { Logger } from "../logging/logger.js";

// Human-in-the-loop handoff (brief §3.6). The confirmed mechanism: the
// browser runs headed, so the human is looking at the *same* live page the
// automation was driving — not a fresh session. When raised, this pauses
// the automated loop, prints an intervention request (capability/goal,
// step, reason, screenshot), and injects a page-side listener via
// `page.exposeFunction` so any manual clicks/inputs the human makes while
// they have the wheel are still logged. Resuming removes the listener and
// hands control back to the caller (ReplayEngine re-checks the step's
// checkpoint to see whether the human resolved it).
//
// "Who is currently allowed to act on the page?" (see REPORT.md
// "Escalation & handoff"): exactly one party at a time. The automation
// loop is synchronously blocked on the CLI prompt for the entire handoff
// window — it does not race the human for control, because it makes no
// further Surface calls until `raise()` resolves. The human is only ever
// "allowed to act" between the prompt appearing and it being answered.

export interface HandoffRequest {
  capabilityId: string;
  goal: string;
  stepId: string;
  reason: string;
}

export interface HandoffResult {
  resumed: boolean;
  screenshotPath: string;
  /** Log ref of the escalation_raised event, for ReplayOutcome.evidence.logRef. */
  logRef: string;
}

export class EscalationHandoff {
  constructor(
    private readonly surface: Surface,
    private readonly logger: Logger,
    private readonly interactive: boolean,
    private readonly evidenceDir: string
  ) {}

  async raise(request: HandoffRequest): Promise<HandoffResult> {
    const screenshotPath = await this.captureScreenshot(request.stepId);
    const logRef = this.logger.log({ event: "escalation_raised", ...request, screenshotPath });

    if (!this.interactive) {
      // No operator attached: raise the intervention request and evidence,
      // then return immediately rather than blocking a headless run
      // forever. In a real deployment this is where a ticket/queue entry
      // would be created for a human to pick up asynchronously.
      return { resumed: false, screenshotPath, logRef };
    }

    console.log(`\n=== HUMAN INTERVENTION REQUESTED ===`);
    console.log(`Capability : ${request.capabilityId}`);
    console.log(`Goal       : ${request.goal}`);
    console.log(`Step       : ${request.stepId}`);
    console.log(`Reason     : ${request.reason}`);
    console.log(`Screenshot : ${screenshotPath}`);
    console.log(`The browser window is live. Take manual action there if you can resolve this.`);

    const removeInstrumentation = await this.instrument();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let resumed = false;
    try {
      const answer = await rl.question(`Press Enter to resume automated replay, or type "abort": `);
      resumed = answer.trim().toLowerCase() !== "abort";
    } finally {
      rl.close();
      await removeInstrumentation();
    }
    this.logger.log({ event: "escalation_resumed", stepId: request.stepId, resumed });
    return { resumed, screenshotPath, logRef };
  }

  private async captureScreenshot(stepId: string): Promise<string> {
    mkdirSync(this.evidenceDir, { recursive: true });
    const buf = await this.surface.screenshot();
    const filePath = path.join(this.evidenceDir, `escalation-${stepId}-${Date.now()}.png`);
    writeFileSync(filePath, buf);
    return filePath;
  }

  private async instrument(): Promise<() => Promise<void>> {
    const page = this.surface.getPlaywrightPage?.();
    if (!page) return async () => {};

    await page.exposeFunction("__reportHumanAction", (info: Record<string, unknown>) => {
      this.logger.log({ event: "human_action", ...info });
    });
    await page.evaluate(() => {
      const w = window as unknown as { __humanActionListener?: (e: Event) => void };
      w.__humanActionListener = (e: Event) => {
        const target = e.target as HTMLElement | null;
        const report = (window as unknown as { __reportHumanAction: (i: Record<string, unknown>) => void })
          .__reportHumanAction;
        report({
          type: e.type,
          tag: target?.tagName,
          id: target?.id || undefined,
          name: (target as HTMLInputElement | null)?.name || undefined,
          text: target?.textContent?.slice(0, 80)
        });
      };
      document.addEventListener("click", w.__humanActionListener, true);
      document.addEventListener("input", w.__humanActionListener, true);
      document.addEventListener("change", w.__humanActionListener, true);
    });

    return async () => {
      await page
        .evaluate(() => {
          const w = window as unknown as { __humanActionListener?: (e: Event) => void };
          if (w.__humanActionListener) {
            document.removeEventListener("click", w.__humanActionListener, true);
            document.removeEventListener("input", w.__humanActionListener, true);
            document.removeEventListener("change", w.__humanActionListener, true);
          }
        })
        .catch(() => {
          // Page may have navigated away during the handoff; nothing to clean up.
        });
    };
  }
}
