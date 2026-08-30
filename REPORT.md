# REPORT.md

## Architecture

The system has a strict one-way dependency: **discovery produces artifacts,
replay consumes them, and nothing in replay's call graph can reach the
Anthropic API.** Concretely:

- **`Surface`** ([`core/surface.ts`](src/core/surface.ts)) is the single
  interface both discovery and replay code are written against:
  `navigate`, `observe`, `screenshot`, `act`, `close`. `DomSurface`
  implements it with Playwright role/label/testId/text/css locators over a
  real browser; `VisionSurface` implements it with screenshot + Claude
  vision coordinate grounding, re-grounding on every single call rather
  than trusting a cached coordinate; `FakeSurface` implements it in memory
  for unit tests. Nothing above this interface knows or cares which one
  it's holding.
- **The discovery loop** ([`discovery/discoveryLoop.ts`](src/discovery/discoveryLoop.ts))
  observes the current `Surface`, asks Claude (via forced tool-use, never
  free-text parsing) for exactly one next action or a terminal verdict,
  executes it for real, and repeats until the goal is met or a stopping
  condition fires (max steps, a wall-clock timeout, consecutive failures, or
  the model declaring itself stuck).
- **`CapabilityArtifact`** ([`core/artifact.ts`](src/core/artifact.ts)) is
  the typed record discovery produces — see "Artifact schema" below.
- **`ReplayEngine`** ([`replay/replayEngine.ts`](src/replay/replayEngine.ts))
  walks an artifact's steps deterministically and returns one of four
  structured outcomes — see "Determinism & error handling."
- **Safety, redaction, and escalation** are separate modules
  (`safety/allowlist.ts`, `safety/redaction.ts`, `safety/riskGate.ts`,
  `escalation/handoff.ts`) that `ReplayEngine` composes rather than
  hand-rolling itself.
- **The target app** (`target-app/`) is one Express server with one shared
  `business.ts` module, rendered as `/modern` (semantic HTML, `data-testid`,
  for `DomSurface`) and `/legacy` (nested tables, `<div onclick>` fake
  buttons, for `VisionSurface`) — the stand-in for "one vendor product,
  many tenant skins."

## Artifact schema

An artifact ([example](artifacts/open-subaccount.json)) has: `id`,
`version`, `status` (`draft`/`approved`), the discovery `goal`, `target`
(surface + base URL), `discoveredBy` (model + a run ID pointing back into
`evidence/logs`), typed `inputParams`/`outputs`, an ordered `steps` array,
an `overallCheckpoint`, and two rule arrays: `businessOutcomes` and
`escalationTriggers`.

Each **step** carries: an `action` (type + optional `locator` + optional
templated `value`), a `risk` classification with a `riskRationale`, a
nullable `checkpoint`, zero or more `recoverable` rules, and zero or more
`extract` rules. A **locator** is a `description`, a `rationale` for why
this element was targeted this way, and an ordered **fallback chain** of
strategies: `role` (accessibility semantics — survives styling/copy
changes) → `label` → `testId` (stable but a real vendor UI may not have
one) → `text` (fragile to copy/i18n) → `css` (most brittle) →
`visionDescription` (the only strategy `VisionSurface` understands, since
`/legacy` has nothing else to fall back to). `DomSurface` tries each
strategy in order and records which one actually resolved.

`inputParams`/`outputs` are declared as a small typed field list
(`{name, type, description, required}`) and `compileFieldSchema()`
compiles them into a **real Zod object schema** — the same schema both
validates a caller's input params and validates what replay actually
extracted, so "typed outputs" is enforced, not just documented.

**Artifacts are PII-free by construction, not by scrubbing.** Any value
that varies per invocation (a member ID, a nickname, a dollar amount) is
recorded as `"{{paramName}}"`, never as the literal value typed during
discovery. This isn't just prompt discipline — three real discovery runs
showed the model doesn't apply it consistently everywhere (see
CHANGELOG.md bugs #2, #3, #10), so `discovery/artifactCompiler.ts` runs a
deterministic generalization pass after the fact: it knows which literal
values map to which params and substitutes them back into every
checkpoint and every locator strategy field, closing gaps the model leaves
open.

## Determinism & error handling

**No model call ever decides *what* to do during replay.** The one model
call that can occur during replay — `VisionSurface`'s per-step grounding
("where on this screenshot is X") — only answers a perception question with
a fixed, non-negotiable action already chosen by the artifact; it never
chooses the next action or judges success. Its output isn't perfectly
reproducible (vision models have some variance), which is exactly why the
*outcome* is still verified deterministically afterward: a checkpoint is a
plain substring/regex test against `Observation.visibleText`/`.url`, so
even if grounding clicks the wrong pixel, the resulting page won't match
the expected checkpoint and replay reports `hard_failure`/`escalated` with
exact expected-vs-observed text — it never silently reports `success` on a
misclick.

The four outcomes are classified by one fixed cascade, run after every
step (`ReplayEngine.runStep`/`checkStepOutcome`):

1. **Allowlist/schema violations → `hard_failure`, no handoff.** A
   guardrail breach needs a config or artifact fix, not a live override.
2. **The step's action can't be resolved/executed at all → checked against
   `businessOutcomes`/`escalationTriggers` *before* failing.** This one
   took a real bug to find (CHANGELOG.md #12): a replay against a
   nonexistent member came back `hard_failure` ("no element matched")
   instead of `business_outcome`, because a "no results" page left by the
   *previous* step simply has no row to click next — the divergence shows
   up as "nothing to act on," not as a failed checkpoint after a
   successful action. Business/escalation rules are now checked against
   the page *before* attempting each step's action, not only after.
3. **Checkpoint fails after a successful action →** recoverable rules are
   tried first (known interstitials, auto-dismissed and logged, never
   escalated); then `businessOutcomes` (a short-circuit to a legitimate
   non-error result); then `escalationTriggers` or an unrecognized failure,
   both of which raise a live handoff.
4. **Risky step, `draft` artifact, operator declines → `escalated`.**

Numeric `extract` is deliberately defensive rather than trusting a
model-authored regex verbatim: it strips thousands separators and pulls
the actual numeric substring out of the capture group, skipping the field
rather than emitting `NaN` if the group is dirty. Both cases (`"15,320.00"`,
and a greedy pattern that captured `"75.00."` including a sentence-ending
period) came from real replay runs, not hypotheticals.

## Heterogeneity & multi-tenant

**Extending `Surface` to a frameset legacy app**: `DomSurface` would need
frame-aware resolution — Playwright's `page.frame()`/`frameLocator()` make
this mechanical, and `LocatorStrategy` would gain an optional frame hint.
Nothing above `Surface` changes, because `Observation`/`Checkpoint` already
operate on flattened text/URL, not DOM structure.

**Extending to a native desktop app**: a new `AccessibilityTreeSurface`
would implement `Surface` using the OS accessibility API (macOS
Accessibility API / Windows UI Automation) instead of the DOM. This maps
onto the schema almost for free — `role`+`name` *is* the accessibility-tree
concept already, so the same locator fallback chain and the same
`CapabilityArtifact` shape apply unchanged; only the `Surface`
implementation is new. A vision-grounded surface generalizes even more
directly, since "screenshot + pixel coordinates" doesn't care whether the
pixels came from a browser or a native window.

**The seam** is exactly this split: `Surface` is "how we perceive/act on a
*this* surface"; `CapabilityArtifact` is "the recorded flow," expressed
purely in terms of locator descriptions, text checkpoints, and typed
params/outputs — nothing in an artifact is DOM-specific.

**Reusing an artifact across tenants of the same vendor product**: point
`target.baseUrl` at the other tenant's instance and replay as-is. The
fallback-chain ordering is specifically designed for this — a
whitelabeled tenant is far more likely to have kept the same accessibility
roles/labels than the same CSS classes or copy text, so `role`/`label`
strategies survive rebranding that would break `css`/`text` strategies.
**Detecting drift without re-recording**: this doesn't need a separate
mechanism — it's already the `hard_failure`/`escalated` outcome plus the
structured log. A spike in `hard_failure` for one tenant replaying an
artifact that works everywhere else *is* the drift signal, with the exact
expected-vs-observed text attached. **Specialization** would be a small
per-tenant override file that appends additional locator-strategy
fallbacks or additional `businessOutcomes`/`escalationTriggers` entries
without touching the base artifact — the schema's arrays are additive by
design, so this needs no new schema, just a merge step analogous to
`artifactCompiler.ts`'s existing append-a-rule-to-an-artifact logic.

## Escalation & handoff

**Two distinct mechanisms, not one.** A risky step on a `draft` artifact
is an *approval* gate (`safety/riskGate.ts`): a synchronous `[y/N]` CLI
prompt, no browser control changes hands. A stuck/blocked replay is a
*handoff* (`escalation/handoff.ts`): the browser runs headed, so a human
is looking at the exact same live page the automation was driving — not a
fresh session. Raising one pauses the automation loop, prints the
capability/goal/step/reason plus a screenshot path, and injects a listener
into the page via `page.exposeFunction` so any manual clicks/inputs the
human makes are still logged as `human_action` events. Resuming removes
the listener and `ReplayEngine` re-checks the step's checkpoint to see
whether the human actually fixed it.

**Who is allowed to act on the page, at any point?** Exactly one party,
and it's determined by control flow, not a flag: the automation loop makes
zero further `Surface` calls between raising a handoff and `raise()`
resolving — it's synchronously blocked on the CLI prompt for that entire
window. The human is only ever "allowed to act" in that window; the moment
they resume, the loop is the only thing calling `Surface` again. There's
no period where both could plausibly be acting at once.

An unattended (non-interactive) run never blocks: a handoff still logs the
intervention request and screenshot, then returns `escalated` immediately
— in a real deployment this is where an async ticket would be raised for
a human to pick up later, rather than holding a synchronous call open
indefinitely.

## Safety

**Allowlist**, enforced in `ReplayEngine` itself before every `navigate`
and before every action type — not a config file the executor happens to
respect (`safety/allowlist.ts`, tested in `test/allowlist.test.ts`).

**Risk gating policy** (confirmed with the user before building): a single
status-gated rule rather than two separate mechanisms. `draft` artifacts
pause every risky step for a live confirmation; `approved` artifacts run
risky steps unattended, still allowlist-checked, still logged as risky. An
unattended run of a `draft` artifact **fails closed** on its first risky
step — there is no "no operator, so just proceed" path. This gives a
natural lifecycle (discover → review the plain-English `riskRationale` on
each step → approve → trust unattended) instead of two independent knobs
that could disagree with each other.

**Redaction** runs at one choke point — `Logger.log()` — not
opportunistically at call sites (`safety/redaction.ts`). Two passes: known
sensitive field names are always masked, and every literal value supplied
as a capability input param is masked wherever it appears in free text
(so page text containing a member's name or ID is redacted in the log
even though the log entry's *structure* isn't a `password`/`token` field).
This is a backstop, though — the stronger guarantee is structural:
artifacts never contain literal invocation data in the first place (see
"Artifact schema"), so there's nothing to redact there by construction.

## Cuts

Explicitly out of scope, per the brief: no queue infrastructure, no
multi-tenant plumbing, no real operator console (the CLI prompt is the
"minimal/mock operator surface"), no desktop `Surface` implementation.

- **`VisionSurface.selectOption`** is a best-effort keyboard jump-select
  against a native `<select>`'s visible option text; it works for short,
  distinct labels but was not exercised in the real evidence run (the
  demonstrated `/legacy` flow only needed click + fill). A dropdown-heavy
  vision flow would need more work.
- **Discovery dead-ends stop and report**, rather than triggering the full
  live-handoff mechanism. Handoff is built for replay, where it matters for
  unattended production automation; a discovery run is already an
  interactive, supervised CLI session, so "stop and let the operator decide
  what to try next" is a reasonable, much simpler behavior there.
- **No visual/screenshot redaction** — only page *text* is redacted in
  logs. A screenshot attached to `escalated`/`hard_failure` evidence could
  still show PII on screen; out of scope for this exercise.
- **Two recorded artifacts, not a library.** `open-subaccount` (risky,
  `/modern`) and `lookup-balance-legacy` (read-only, `/legacy`) are enough
  to exercise every outcome and both surfaces; a real system would have
  many more.
- **`npm audit` flags a handful of moderate/high transitive vulnerabilities**
  (mostly from Playwright's dependency tree) that weren't investigated —
  acceptable for a local take-home target, not something to ship as-is.
- Approving an artifact is per-version; appending a `businessOutcomes`/
  `escalationTriggers` rule from a probe run does **not** revoke an
  existing `approved` status (only a full goal-directed rediscovery resets
  status to `draft`). A stricter production policy might want every rule
  addition to require re-approval too — a reasonable tightening this
  exercise didn't need.
