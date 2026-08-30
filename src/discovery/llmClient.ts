import Anthropic from "@anthropic-ai/sdk";
import type { ElementSummary } from "../core/surface.js";
import { RawDecisionSchema, type Decision, type GroundingResult } from "./types.js";

// The only two places in this codebase an LLM is ever called: deciding the
// next discovery step, and grounding an element description against a
// screenshot for VisionSurface. Neither is ever called from ReplayEngine's
// control flow — see replay/replayEngine.ts's header comment for why
// VisionSurface's per-step grounding call doesn't compromise replay
// determinism.

export const DISCOVERY_MODEL = "claude-sonnet-5";

const DECIDE_TOOL: Anthropic.Tool = {
  name: "decide",
  description:
    "Decide the single next action to take toward the goal, or declare the run finished (goal met, a business outcome, an escalation-worthy block) or stuck.",
  input_schema: {
    type: "object",
    properties: {
      thought: { type: "string", description: "Brief reasoning about the current page and what to do next." },
      status: {
        type: "string",
        enum: ["continue", "goal_met", "business_outcome", "escalation", "stuck"],
        description:
          "'continue' to take another action. 'goal_met' if the goal is now visibly achieved. 'business_outcome' if the page shows a legitimate non-error terminal result (e.g. 'no such record'). 'escalation' if the page shows a recognized blocked/needs-human-judgment state (e.g. a compliance hold). 'stuck' if you cannot proceed and don't recognize the state as any of the above."
      },
      action: {
        type: "object",
        description: "Required when status is 'continue'.",
        properties: {
          type: {
            type: "string",
            enum: ["click", "fill", "selectOption", "navigate", "observe"],
            description: "Use 'observe' to extract/verify something on the CURRENT page without interacting with it — do not click an element merely to inspect or re-read its text."
          },
          value: {
            type: "string",
            description: "For fill/selectOption: the literal value to type/select for THIS trial run. For navigate: the URL."
          },
          paramRef: {
            type: "string",
            description:
              "Set this when `value` is data that should vary per future invocation of this capability (e.g. a member ID, a dollar amount) rather than being fixed. Use a short camelCase name; it becomes an input parameter of the saved capability."
          },
          paramType: { type: "string", enum: ["string", "number", "boolean"] },
          locatorDescription: {
            type: "string",
            description: "Human-readable description of the target element. Required for click/fill/selectOption."
          },
          strategies: {
            type: "array",
            description:
              "Ordered most-robust-first fallback chain for locating the element. Prefer role+accessible-name first, then label, then testId, then visible text, then a CSS selector only as a last resort.",
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["role", "label", "testId", "text", "css"] },
                role: { type: "string" },
                name: { type: "string" },
                label: { type: "string" },
                testId: { type: "string" },
                text: { type: "string" },
                selector: { type: "string" }
              },
              required: ["kind"]
            }
          },
          rationale: { type: "string", description: "Why this fallback order was chosen for this element." },
          risk: {
            type: "string",
            enum: ["safe", "risky"],
            description: "'risky' if this action is irreversible or has a real-world side effect (e.g. submitting a form that creates/changes a record)."
          },
          riskRationale: { type: "string" },
          checkpoint: {
            type: "object",
            description: "How to verify this action had the expected effect.",
            properties: {
              kind: { type: "string", enum: ["textVisible", "textNotVisible", "urlMatches"] },
              value: { type: "string" },
              description: { type: "string" }
            },
            required: ["kind", "value", "description"]
          },
          extract: {
            type: "array",
            description: "Values worth capturing as capability outputs from the page resulting from this action.",
            items: {
              type: "object",
              properties: {
                outputField: { type: "string" },
                description: { type: "string" },
                type: { type: "string", enum: ["string", "number", "boolean"] },
                pattern: { type: "string", description: "Regex with exactly one capture group, matched against the page's visible text." }
              },
              required: ["outputField", "description", "type", "pattern"]
            }
          }
        },
        required: ["type", "risk", "riskRationale"]
      },
      terminalLabel: { type: "string", description: "Short snake_case label for a business_outcome/escalation, e.g. member_not_found." },
      terminalMessage: { type: "string", description: "Human-readable message describing the terminal state." },
      terminalSignatureText: {
        type: "string",
        description:
          "A literal, distinctive substring of the CURRENT page's visible text that uniquely identifies this terminal state. Used to recognize this same state automatically in future runs."
      },
      reason: { type: "string", description: "Required when status is 'stuck': why you cannot proceed." }
    },
    required: ["thought", "status"]
  }
};

const GROUND_TOOL: Anthropic.Tool = {
  name: "ground",
  description: "Report the pixel coordinates of the described element in the provided screenshot.",
  input_schema: {
    type: "object",
    properties: {
      found: { type: "boolean" },
      x: { type: "number", description: "Pixel x-coordinate, from the left edge of the image." },
      y: { type: "number", description: "Pixel y-coordinate, from the top edge of the image." }
    },
    required: ["found", "x", "y"]
  }
};

export interface DecideParams {
  goal: string;
  historySummary: string[];
  visibleText: string;
  interactiveElements?: ElementSummary[];
  screenshotBase64?: string;
}

/**
 * The slice of LlmClient that discoveryLoop actually depends on. Extracted
 * so discoveryLoop's control flow (stop conditions, paramRef bookkeeping,
 * the missing-terminal-field retry) can be unit-tested against a scripted
 * fake — see test/discoveryLoop.test.ts — without a real API key. Nothing
 * about VisionSurface's grounding call is part of this interface; that
 * stays on the concrete LlmClient.
 */
export interface LlmDecider {
  decide(params: DecideParams): Promise<Decision>;
}

export class LlmClient implements LlmDecider {
  private readonly client: Anthropic;

  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY ?? "") {
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env before running discovery.");
    }
    this.client = new Anthropic({ apiKey });
  }

  async decide(params: DecideParams): Promise<Decision> {
    // The model occasionally returns a tool call missing a required field
    // (observed in the first real discovery run under this schema). That's
    // a formatting hiccup, not a decision to relitigate, so retry the same
    // call a couple of times before giving up rather than aborting the run.
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.decideOnce(params);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async decideOnce(params: DecideParams): Promise<Decision> {
    const content: Anthropic.MessageParam["content"] = [];
    let text = `Goal: ${params.goal}\n\nSteps taken so far:\n${
      params.historySummary.length ? params.historySummary.map((s, i) => `${i + 1}. ${s}`).join("\n") : "(none yet)"
    }\n\nCurrent page visible text:\n${params.visibleText.slice(0, 4000)}`;

    if (params.interactiveElements) {
      text += `\n\nInteractive elements on the current page (JSON):\n${JSON.stringify(params.interactiveElements).slice(0, 4000)}`;
    }
    content.push({ type: "text", text });

    if (params.screenshotBase64) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: params.screenshotBase64 }
      });
    }

    const response = await this.client.messages.create({
      model: DISCOVERY_MODEL,
      max_tokens: 2000,
      system:
        "You are driving a real web back-office UI, one action at a time, to accomplish a stated goal. " +
        "You only see one page at a time and must call the `decide` tool every turn. Never guess at outcomes " +
        "you have not observed. Only click a 'submit'/'confirm' style control after reviewing what it will do — " +
        "classify such actions as risky. Prefer the most robust locator strategy available (role+name over a raw CSS selector).\n\n" +
        "You are recording a REUSABLE capability, not a one-off script. This has two consequences:\n" +
        "1. Parameterize goal-specific data. Any value you type that came from THIS goal's specific instance " +
        "(an ID, a name, a dollar amount, a nickname — anything a future caller might supply differently) MUST " +
        "have `paramRef` set to a short camelCase name. Only omit paramRef for a value that is genuinely fixed " +
        "regardless of who calls this capability (e.g. always selecting the same dropdown option). If in doubt, " +
        "set paramRef — an artifact with no input parameters at all is almost certainly wrong.\n" +
        "2. Never hardcode data that will differ on a future run into a checkpoint. There are two safe patterns: " +
        "(a) to verify a field now shows an input you supplied, reference it as \"{{paramName}}\" using the same " +
        "name you gave paramRef — e.g. checkpoint value \"{{memberId}}\", not the literal ID you happened to use " +
        "this run; (b) to verify a success/result page, use a STABLE substring that will be true on every future " +
        "run regardless of generated data — e.g. \"Sub-Account Opened\" or \"opened with a balance of\", never a " +
        "specific generated ID or dollar figure like \"SA0001\" or \"$250.00\" (those are assigned per-run and will " +
        "never recur). The same rule applies to terminalSignatureText when you finish: pick a fixed phrase from " +
        "the page's static copy, not anything computed or supplied this run.\n\n" +
        "This also applies to LOOKED-UP data, not just data you typed: e.g. after searching for a member, do not " +
        "verify the detail page loaded by checking for that member's NAME (a different memberId looks up a " +
        "different name, so a checkpoint hardcoding today's name will fail every future run). Instead check for " +
        "something structural that is true for ANY record — a section heading like \"Member\", a field label, or " +
        "\"{{memberId}}\" itself (the ID is usually still shown on the page).\n\n" +
        "Do not set a checkpoint on a fill or selectOption action: a form field's value is never part of the " +
        "page's visible text, so such a checkpoint can never be verified either now or on replay. The action's " +
        "own success/failure is already sufficient verification for fill/selectOption. Only set checkpoints on " +
        "click/navigate actions, to verify the page that results from them.\n\n" +
        "Every extraction you request is tested immediately against the live page and the result is appended to " +
        "the step's entry in your history as either 'matched: <value>' or 'did NOT match'. Once history shows an " +
        "extraction matched, it is done — do not repeat the same or a re-worded extraction; move on to the next " +
        "part of the goal. Only retry an extraction if history shows it did NOT match.",
      tools: [DECIDE_TOOL],
      tool_choice: { type: "tool", name: "decide" },
      messages: [{ role: "user", content }]
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) throw new Error(`Model did not return a decide tool call (stop_reason: ${response.stop_reason}).`);
    const parsed = RawDecisionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      throw new Error(
        `decide tool call failed schema validation (stop_reason: ${response.stop_reason}): ${parsed.error.message}\nRaw input: ${JSON.stringify(toolUse.input)}`
      );
    }
    const raw = parsed.data;
    if (raw.status) return raw as Decision;
    if (raw.action) return { ...raw, status: "continue" };
    throw new Error(`decide tool call omitted status with no action to imply it. Raw input: ${JSON.stringify(toolUse.input)}`);
  }

  async groundElement(screenshotBase64: string, description: string, imageWidth: number, imageHeight: number): Promise<GroundingResult> {
    const response = await this.client.messages.create({
      model: DISCOVERY_MODEL,
      max_tokens: 500,
      system: `You locate UI elements in screenshots. The image is exactly ${imageWidth}x${imageHeight} pixels. Call the \`ground\` tool with the pixel coordinates of the CENTER of the described element.`,
      tools: [GROUND_TOOL],
      tool_choice: { type: "tool", name: "ground" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Find this element: ${description}` },
            { type: "image", source: { type: "base64", media_type: "image/png", data: screenshotBase64 } }
          ]
        }
      ]
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) throw new Error("Model did not return a ground tool call.");
    const input = toolUse.input as GroundingResult;
    return { found: Boolean(input.found), x: Number(input.x), y: Number(input.y) };
  }
}
