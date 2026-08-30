import type { ActionType } from "../core/artifact.js";

// Explicit, configurable allowlist (brief §3.4). Enforced inside
// ReplayEngine before every navigate and before every action type — not
// merely a config file the executor happens to respect. A replay that
// tries to leave the allowlisted origin/paths, or use an action type that
// isn't permitted, gets a hard_failure, not a warning.

export interface AllowlistConfig {
  allowedOrigins: string[];
  allowedPathPrefixes: string[];
  allowedActionTypes: ActionType[];
}

export class Allowlist {
  constructor(private readonly config: AllowlistConfig) {}

  isUrlAllowed(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (!this.config.allowedOrigins.includes(parsed.origin)) return false;
    return this.config.allowedPathPrefixes.some((prefix) => parsed.pathname.startsWith(prefix));
  }

  isActionTypeAllowed(type: ActionType): boolean {
    return this.config.allowedActionTypes.includes(type);
  }
}

export function defaultAllowlist(baseOrigin: string): Allowlist {
  return new Allowlist({
    allowedOrigins: [baseOrigin],
    allowedPathPrefixes: ["/modern", "/legacy", "/"],
    allowedActionTypes: ["click", "fill", "selectOption", "navigate", "observe"]
  });
}
