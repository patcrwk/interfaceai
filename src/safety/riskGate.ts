import { createInterface } from "node:readline/promises";
import type { CapabilityArtifact, Step } from "../core/artifact.js";

// The confirmed policy (see CHANGELOG.md 2026-08-30): a single status-gated
// rule, not two separate mechanisms. `draft` artifacts pause on every risky
// step for a synchronous operator confirmation; `approved` artifacts run
// risky steps unattended. There is no third path — an unattended run of a
// draft artifact fails closed on its first risky step rather than silently
// treating "no operator available" as approval.

export interface RiskGate {
  authorize(artifact: CapabilityArtifact, step: Step): Promise<boolean>;
}

export class CliRiskGate implements RiskGate {
  constructor(private readonly interactive: boolean) {}

  async authorize(artifact: CapabilityArtifact, step: Step): Promise<boolean> {
    if (artifact.status === "approved") return true;

    if (!this.interactive) {
      // Fail closed: a draft artifact's risky step must never run unattended.
      return false;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n[RISK GATE] Artifact "${artifact.id}" is DRAFT. Step "${step.id}" is classified RISKY.`);
      console.log(`  ${step.description}`);
      console.log(`  Rationale: ${step.riskRationale}`);
      const answer = await rl.question("Proceed with this step? [y/N] ");
      return answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  }
}

/** Used only by unit tests that aren't exercising the gate itself. */
export class AlwaysApproveRiskGate implements RiskGate {
  async authorize(): Promise<boolean> {
    return true;
  }
}

/** Used only by unit tests exercising the fail-closed path deterministically. */
export class AlwaysDenyRiskGate implements RiskGate {
  async authorize(): Promise<boolean> {
    return false;
  }
}
