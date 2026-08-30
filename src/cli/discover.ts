import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./args.js";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "../core/artifact.js";
import { appendBusinessOutcome, appendEscalationTrigger, compileGoalMetArtifact } from "../discovery/artifactCompiler.js";
import { runDiscovery } from "../discovery/discoveryLoop.js";
import { LlmClient } from "../discovery/llmClient.js";
import { Logger } from "../logging/logger.js";
import { DomSurface } from "../surfaces/domSurface.js";
import { VisionSurface } from "../surfaces/visionSurface.js";

// Real, LLM-driven discovery run against the live target app. Never
// pre-scripted: each step is a genuine Anthropic API call deciding what to
// do next, executed for real against the running Express server.
//
// A goal that completes (status "goal_met") produces or replaces the main
// artifact. A goal aimed at a known edge case (status "business_outcome"
// or "escalation") appends a rule to an existing artifact instead — see
// discovery/artifactCompiler.ts and README.md for why three short, real
// discovery runs (one happy path, two edge-case probes) are how this
// artifact's full outcome taxonomy gets populated, rather than one run
// with hand-authored edge cases bolted on afterward.

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const goal = args.goal;
  const target = (args.target ?? "modern") as "modern" | "legacy";
  const capabilityId = args["capability-id"] ?? "open-subaccount";
  const baseUrl = args["base-url"] ?? "http://localhost:4173";
  const headed = args.headed === "true";

  if (!goal) {
    console.error(
      `Usage: npm run discover -- --goal "..." --target modern|legacy [--capability-id id] [--base-url url] [--headed]`
    );
    process.exit(1);
  }

  const runId = `discovery-${Date.now()}`;
  const logger = new Logger(path.join("evidence", "logs", `${runId}.jsonl`), runId);
  const llm = new LlmClient();
  const startUrl = `${baseUrl}/${target}/`;

  const surface = target === "modern" ? await DomSurface.launch({ headless: !headed }) : await VisionSurface.launch(llm, { headless: !headed });

  try {
    logger.log({ event: "discovery_start", goal, target, startUrl, runId });
    console.log(`Discovery started. Goal: "${goal}" | Target: ${target} | Log: evidence/logs/${runId}.jsonl`);

    const result = await runDiscovery(surface, llm, goal, startUrl, logger);

    const artifactPath = path.join("artifacts", `${capabilityId}.json`);
    const existing: CapabilityArtifact | undefined = existsSync(artifactPath)
      ? CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, "utf8")))
      : undefined;

    if (result.terminal.kind === "goal_met") {
      const artifact = compileGoalMetArtifact({
        capabilityId,
        goal,
        target: { surface: target === "modern" ? "dom" : "vision", baseUrl: `${baseUrl}/${target}` },
        discoveryRunId: runId,
        result,
        existing
      });
      CapabilityArtifactSchema.parse(artifact);
      mkdirSync("artifacts", { recursive: true });
      writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
      console.log(`\nGoal met in ${result.steps.length} steps. Artifact saved: ${artifactPath} (v${artifact.version}, status draft)`);
    } else if (result.terminal.kind === "business_outcome" || result.terminal.kind === "escalation") {
      if (!existing) {
        console.error(
          `No existing artifact "${capabilityId}" to attach this ${result.terminal.kind} rule to. Run the main goal-directed discovery first.`
        );
        process.exitCode = 1;
        return;
      }
      const updated =
        result.terminal.kind === "business_outcome"
          ? appendBusinessOutcome(existing, result.terminal)
          : appendEscalationTrigger(existing, result.terminal);
      CapabilityArtifactSchema.parse(updated);
      writeFileSync(artifactPath, JSON.stringify(updated, null, 2));
      console.log(`\n${result.terminal.kind} rule "${result.terminal.label}" added to ${artifactPath}.`);
    } else {
      console.error(`\nDiscovery stuck: ${result.terminal.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
