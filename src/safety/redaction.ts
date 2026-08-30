// Redaction layer. Runs on every write to the log stream (see
// logging/logger.ts — Logger.log() calls this unconditionally, there is no
// call site that writes without going through it). Two complementary
// passes:
//
//   1. Key-based: certain field names are always redacted regardless of
//      what they contain (password, token, ssn, ...).
//   2. Value-based: literal values supplied as capability input params
//      (member IDs, names, dollar amounts — presumptively sensitive in a
//      bank back office) are redacted wherever they appear in free text,
//      even embedded inside a longer string like page text content.
//
// Note this only protects the *log stream*. Saved CapabilityArtifacts never
// contain literal runtime values in the first place — see core/artifact.ts
// — so there is nothing to redact there by design, not by scrubbing.

const DEFAULT_SENSITIVE_FIELD_NAMES = new Set([
  "password",
  "token",
  "apiKey",
  "api_key",
  "ssn",
  "creditCard",
  "credit_card",
  "secret"
]);

// Matches common opaque-secret shapes (API keys, tokens) so a credential
// that leaks into a log line even under an innocuous field name still gets
// caught.
const SECRET_LIKE_PATTERN = /\b(sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;

export function redactKeys(
  value: unknown,
  sensitiveFieldNames: Set<string> = DEFAULT_SENSITIVE_FIELD_NAMES,
  keyHint?: string
): unknown {
  if (typeof value === "string") {
    if (keyHint && sensitiveFieldNames.has(keyHint)) return "[REDACTED]";
    return value.replace(SECRET_LIKE_PATTERN, "[REDACTED:secret-like]");
  }
  if (Array.isArray(value)) return value.map((v) => redactKeys(v, sensitiveFieldNames));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactKeys(v, sensitiveFieldNames, k);
    }
    return out;
  }
  return value;
}

/** Replaces every occurrence of a known-sensitive literal value with a labeled placeholder. */
export function redactLiteralValues(text: string, valueToLabel: Map<string, string>): string {
  let out = text;
  for (const [value, label] of valueToLabel) {
    if (!value) continue;
    out = out.split(value).join(`[REDACTED:${label}]`);
  }
  return out;
}

function deepRedactLiteralValues(value: unknown, valueToLabel: Map<string, string>): unknown {
  if (typeof value === "string") return redactLiteralValues(value, valueToLabel);
  if (Array.isArray(value)) return value.map((v) => deepRedactLiteralValues(v, valueToLabel));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepRedactLiteralValues(v, valueToLabel);
    return out;
  }
  return value;
}

/** The single choke point: apply both passes, in order, to a value about to be written to the log. */
export function redactForLog(value: unknown, sensitiveValues: Map<string, string>): unknown {
  return redactKeys(deepRedactLiteralValues(value, sensitiveValues));
}

/** Builds the value->label map for a capability invocation's params, so literal PII/business data never lands in log text. */
export function sensitiveValueMapFromParams(params: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    map.set(String(value), name);
  }
  return map;
}
