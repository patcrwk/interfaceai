// The four-way replay outcome taxonomy (brief §3.3). A discriminated union
// returned by ReplayEngine.run() — callers switch on `.kind`, they never
// catch an exception to learn what happened. The only thing ReplayEngine
// throws for is a genuine programming error (bad artifact shape that
// somehow slipped past Zod validation); every expected runtime condition,
// including outright failure, is a normal return value.

export interface EvidenceRef {
  /** Path to a saved screenshot, relative to the evidence directory. */
  screenshotPath?: string;
  /** Identifies where in the structured log stream this event was recorded. */
  logRef: string;
}

export type ReplayOutcome =
  | { kind: "success"; outputs: Record<string, unknown> }
  | {
      kind: "business_outcome";
      /** Matches a businessOutcomes[].label from the artifact, e.g. "member_not_found". */
      label: string;
      message: string;
      outputs: Record<string, unknown>;
    }
  | {
      kind: "escalated";
      reason: string;
      stepId: string;
      evidence: EvidenceRef;
    }
  | {
      kind: "hard_failure";
      stepId: string;
      expected: string;
      observed: string;
      evidence: EvidenceRef;
    };
