import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "./args.js";
import { CapabilityArtifactSchema } from "../core/artifact.js";

// Flips an artifact's status from draft to approved. This is the explicit
// human sign-off gate: only after this does ReplayEngine run the
// artifact's risky steps unattended (see safety/riskGate.ts).

function main() {
  const args = parseArgs(process.argv.slice(2));
  const artifactPath = args.artifact;
  if (!artifactPath) {
    console.error(`Usage: npm run approve -- --artifact <path>`);
    process.exit(1);
  }

  const artifact = CapabilityArtifactSchema.parse(JSON.parse(readFileSync(artifactPath, "utf8")));
  if (artifact.status === "approved") {
    console.log(`"${artifact.id}" v${artifact.version} is already approved.`);
    return;
  }

  const updated = { ...artifact, status: "approved" as const };
  CapabilityArtifactSchema.parse(updated);
  writeFileSync(artifactPath, JSON.stringify(updated, null, 2));
  console.log(`Approved "${artifact.id}" v${artifact.version}. Risky steps will now run unattended.`);
}

main();
