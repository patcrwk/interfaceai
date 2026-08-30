import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactForLog } from "../safety/redaction.js";

// Structured JSON-lines logger. Every action taken during discovery or
// replay, and why, goes through here — and every write is redacted first
// (see safety/redaction.ts). `log()` returns a ref string identifying the
// exact line, so ReplayOutcome.evidence.logRef can point back to it.

export interface LogEvent {
  event: string;
  [key: string]: unknown;
}

export class Logger {
  private seq = 0;

  constructor(
    private readonly filePath: string,
    private readonly runId: string,
    private readonly sensitiveValues: Map<string, string> = new Map()
  ) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  log(event: LogEvent): string {
    this.seq += 1;
    const ref = `${this.runId}#${this.seq}`;
    const redacted = redactForLog(event, this.sensitiveValues) as Record<string, unknown>;
    const record = { ts: new Date().toISOString(), runId: this.runId, seq: this.seq, ref, ...redacted };
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf8");
    return ref;
  }
}
