import "dotenv/config";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "./args.js";
import { CapabilityArtifactSchema } from "../core/artifact.js";
import { LlmClient } from "../discovery/llmClient.js";
import { EscalationHandoff } from "../escalation/handoff.js";
import { Logger } from "../logging/logger.js";
import { ReplayEngine } from "../replay/replayEngine.js";
import { defaultAllowlist } from "../safety/allowlist.js";
import { sensitiveValueMapFromParams } from "../safety/redaction.js";
import { CliRiskGate } from "../safety/riskGate.js";
import { DomSurface } from "../surfaces/domSurface.js";
import { VisionSurface } from "../surfaces/visionSurface.js";

// Deterministic replay of a saved CapabilityArtifact. No LLM decides
// anything here (VisionSurface's per-step grounding call is perception,
// not decision — see replay/replayEngine.ts). --interactive attaches a
// live CLI operator for the risk-gate confirmation and any escalation
// handoff; without it, draft risky steps fail closed and escalations
// resolve immediately to `escalated` rather than blocking.

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact;
  const paramsJson = args.params ?? "{}";
  const interactive = args.interactive === "true";
  const headed = args.headed === "true" || interactive;

  if (!artifactPath) {
    console.error(`Usage: npm run replay -- --artifact <path> --params '<json>' [--interactive] [--headed]`);
    process.exit(1);
  }

  const artifact = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, "utf8")));
  const params = JSON.parse(paramsJson) as Record<string, unknown>;

  const runId = `replay-${Date.now()}`;
  const sensitiveValues = sensitiveValueMapFromParams(params);
  const logger = new Logger(path.join("evidence", "logs", `${runId}.jsonl`), runId, sensitiveValues);

  const llm = artifact.target.surface === "vision" ? new LlmClient() : undefined;
  const surface =
    artifact.target.surface === "dom"
      ? await DomSurface.launch({ headless: !headed })
      : await VisionSurface.launch(llm!, { headless: !headed });

  const evidenceDir = path.join("evidence", "screenshots");
  mkdirSync(evidenceDir, { recursive: true });

  const allowlist = defaultAllowlist(new URL(artifact.target.baseUrl).origin);
  const riskGate = new CliRiskGate(interactive);
  const handoff = new EscalationHandoff(surface, logger, interactive, evidenceDir);
  const engine = new ReplayEngine({ surface, allowlist, riskGate, logger, handoff, evidenceDir, runId });

  console.log(`Replaying "${artifact.id}" v${artifact.version} (${artifact.status}) | Log: evidence/logs/${runId}.jsonl`);

  try {
    const outcome = await engine.run(artifact, params);
    console.log(`\nOutcome: ${outcome.kind}`);
    console.log(JSON.stringify(outcome, null, 2));
    process.exitCode = outcome.kind === "success" || outcome.kind === "business_outcome" ? 0 : 1;
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
