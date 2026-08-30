# CHANGELOG.md

Chronological log of what was built, in order. Not a commit-by-commit diff —
a narrative a future session (or a reviewer) can use to understand sequence
and reasoning without re-reading every file.

## 2026-08-30

- Repo scaffolded: TypeScript (ESM, strict), Vitest, Zod, Playwright,
  `@anthropic-ai/sdk`. `git init`'d for incremental commit history.
- Confirmed three design forks with the user before building on top of them:
  - **Risky-action gating**: single status-gated policy. `draft` artifacts
    pause on risky steps for a synchronous CLI confirmation; `approved`
    artifacts run risky steps unattended (still allowlist-checked, still
    logged as risky).
  - **Human handoff mechanism**: headed Playwright window + CLI pause/resume,
    with a page-injected event listener (via `page.exposeFunction`) logging
    the human's manual actions during the handoff window. Same session, no
    second process or proxy.
  - **Discovery/vision model**: `claude-sonnet-5` (the brief's literal
    `claude-sonnet-4-6` is not a currently valid model ID).
- Built the target app (`/modern` + `/legacy` on one shared `business.ts`),
  `Surface`/`CapabilityArtifact` core types, `DomSurface`, `ReplayEngine` +
  outcome taxonomy, `FakeSurface`, and the safety/escalation/logging layers,
  with 32 unit tests passing against `FakeSurface` (no browser, no API key).
  Then built the discovery loop, `VisionSurface`, and the CLI entry points.

### Real discovery run #1 — and the bugs it found

Per the brief's non-negotiable, ran real discovery against the live
`/modern` app with a real Anthropic API key. This surfaced a sequence of
real bugs, each fixed and re-run for real (never papered over):

1. **Infinite re-fill loop.** The model kept re-filling the search box
   forever. Root cause: `Observation.visibleText` came from
   `document.body.innerText`, which does not include form field *values* —
   so after a `fill`, the model had no way to see its own action had taken
   effect, and kept retrying. Fixed by adding `currentValue` to
   `DomSurface`'s per-element observation ([`domSurface.ts`](src/surfaces/domSurface.ts)).
2. **No parameterization.** The first successful run hardcoded `M1001`,
   `"Emergency Fund"`, `250` directly into the artifact — not reusable, and
   silently violating the "artifacts are PII-free by construction" design.
   Fixed with explicit prompt guidance to use `paramRef` for any
   goal-specific value.
3. **Data-specific checkpoints.** Checkpoints echoed run-specific *generated*
   data (`"SA0001"`, `"$250.00"`, even the looked-up member's *name*) that
   would never recur on a different run. Rather than trust prompt compliance
   alone, added a deterministic generalization pass
   ([`artifactCompiler.ts`](src/discovery/artifactCompiler.ts)) that
   substitutes known literal param values back to `"{{paramName}}"` in every
   checkpoint after the fact.
4. **Checkpoints on `fill`/`selectOption` can never pass.** Same root cause
   as #1, one level up: a checkpoint verifying a fill's effect checks
   `visibleText`, which never contains it. Fixed by having the compiler
   unconditionally null out checkpoints on fill/selectOption steps — the
   action's own ok/error result is already the correct verification.
5. **Missing initial navigation step.** `discover.ts` navigated the surface
   to the start URL *before* calling the discovery loop, so that navigation
   was never recorded as a step. `ReplayEngine` deliberately never
   auto-navigates (an artifact must be fully self-contained), so replay hit
   `hard_failure` on step 1 against a blank page. Fixed by having
   `runDiscovery` record the initial navigation as `step-0` itself.
6. **Model omits `status`.** Reproducible across separate runs (not
   transient noise): on a turn where it clearly intends to continue, the
   model sometimes returns only `thought` + `action`, omitting the
   schema-required `status` field. Fixed by making `status` optional in the
   raw parse and defaulting to `"continue"` when `action` is present
   (`RawDecisionSchema` in [`types.ts`](src/discovery/types.ts)) — rather
   than fighting a reproducible model behavior with retries.
7. **Fake clicks to "read" a value.** The discovery tool schema never
   exposed `observe` as an action type (even though `Surface`/`ReplayEngine`
   already fully supported it), so the model clicked the very element it
   wanted to extract text from, repeatedly, while iterating on its regex —
   producing a bloated, semantically wrong artifact. Fixed by exposing
   `observe` to the model.
8. **Unbounded extraction "refinement."** Even with `observe` available, the
   model kept re-emitting near-identical extraction patterns because it had
   no way to know whether one had already matched. Fixed by having discovery
   actually test each extraction pattern against the live page immediately
   and feed the concrete result (`matched: <value>` / `did NOT match`) back
   into the model's own history.
9. **`NaN` from currency formatting.** A real run against member M1003
   ($15,320.00 — comma-formatted via `toLocaleString`) produced
   `Number("15,320.00") === NaN`. Fixed by stripping separators before
   coercion in `ReplayEngine.extract()`.
10. **Locator strategies can embed run-specific data too.** The `/modern`
    app's "View" link uses a per-row `data-testid="view-member-M1001"` — not
    just the action's value, but the *locator itself* needed
    `"{{memberId}}"` substitution. Extended both `resolveActionTemplate`
    ([`checkpoint.ts`](src/core/checkpoint.ts)) and the compiler's
    generalization pass to cover every string field of every locator
    strategy, not just checkpoint values.
11. **Greedy extraction regex swallowed trailing punctuation.** A
    model-authored pattern captured `"75.00."` (including the sentence-ending
    period) instead of `"75.00"`, producing `NaN` again. Rather than chase
    ever-more-precise LLM-authored regexes, made numeric extraction robust
    by default: pull the actual numeric substring out of whatever the
    capture group returned, and skip the field (not `NaN`) if there isn't a
    clean one.
12. **Business outcomes only checked after a successful action.** A replay
    against nonexistent member M9999 came back `hard_failure` ("no element
    matched") instead of `business_outcome`, because the "no results" page
    that resulted from the *previous* step simply has no row to click next
    — and business/escalation rules were only ever evaluated after a
    checkpoint failure, never before attempting to resolve the *next*
    step's locator. Fixed by checking the current observation against
    `businessOutcomes`/`escalationTriggers` before attempting each step's
    action too, not only after ([`replayEngine.ts`](src/replay/replayEngine.ts)).

Each of these has a regression test in `test/` and is narrated with its
fix inline in the relevant source file. See
[evidence/INDEX.md](evidence/INDEX.md) for the full set of real run logs,
including the failing ones, in chronological order.

### Real discovery run #2 — VisionSurface against `/legacy`

Built `VisionSurface` and ran a second, separate real discovery goal
("look up a member's balance") against `/legacy`, driven entirely by
screenshot + Claude-vision coordinate grounding. Two more real bugs:

13. **Raced navigation.** `page.mouse.click()` (unlike Playwright's
    `Locator.click()`) doesn't auto-wait for a resulting navigation, so the
    very next `observe()` call raced `/legacy`'s `location.href` navigation
    and threw "Execution context was destroyed." Fixed with
    `page.waitForLoadState("load")` after every VisionSurface action
    (harmless no-op when nothing navigated), plus a shared retry-once
    helper (`readBodyText` in
    [`pageUtils.ts`](src/surfaces/pageUtils.ts)) used by both `DomSurface`
    and `VisionSurface` as a second line of defense.
14. **Terminal decision missing required fields.** The model reached
    `goal_met` but omitted `terminalSignatureText`, which
    `artifactCompiler` requires — this previously surfaced as an
    unhandled crash well after the fact, outside the discovery loop. Fixed
    by validating terminal-state completeness inside the loop itself and,
    same pattern as the missing-`status` fix, giving the model one more
    turn with an explicit correction rather than failing the run.

The resulting artifact (`artifacts/lookup-balance-legacy.json`) replayed
successfully against a member (M1006) never used during its discovery
(M1002), proving the vision-grounded replay path is genuinely
deterministic and reusable too, not just the DOM path.

### Hardening pass — post-submission gap check

Reviewed the assignment for remaining gaps rather than treating the first
working version as final:

- **Test coverage.** `discoveryLoop.ts` and `artifactCompiler.ts` — the
  two modules responsible for most of the bugs above — had zero unit
  tests; only real, ad-hoc runs had ever exercised them. Extracted a
  minimal `LlmDecider` interface ([`llmClient.ts`](src/discovery/llmClient.ts))
  so `discoveryLoop` can be driven by a scripted fake LLM with no API key,
  and added `test/discoveryLoop.test.ts` (stop conditions, paramRef/literal
  bookkeeping, the missing-terminal-field retry) and
  `test/artifactCompiler.test.ts` (the generalization pass, directly —
  literal substitution into checkpoints and every locator strategy field,
  the fill/selectOption checkpoint-nulling rule, versioning, rule
  append/replace). 54 tests now pass, up from 36, still with no browser
  and no API key.
- **`npm audit`**: 5 vulnerabilities (3 moderate, 1 high, 1 critical), all
  transitive through `vitest`'s bundled `vite`/`esbuild` (a dev-server CORS
  issue with no real exposure here, but labeled severely). Ran
  `npm audit fix --force` (vitest 2.1.3 → 4.1.11); re-ran the full suite —
  all 54 tests still pass, `npm audit` now reports 0 vulnerabilities.
- **Git history re-verified clean**: scanned the full history (not just the
  working tree) for the API key that briefly landed in `.env.example`
  before the first commit — confirmed it never entered any commit.
- **Clean-room verification**: cloned the repo fresh into a scratch
  directory, ran `npm install` and `npx playwright install chromium` from
  scratch, and executed every command in README.md's three numbered
  sections against that clone — a real discovery run, a real interactive
  risky-step replay, and all three error-path replays
  (`business_outcome`/`escalated`/`hard_failure`) — confirming there's no
  hidden state dependency on the directory the system was originally built
  in. Also confirmed a fresh main-flow discovery run correctly preserves a
  pre-existing artifact's `businessOutcomes`/`escalationTriggers` rules
  rather than discarding them.

### Compliance pass against the actual assignment PDF

Everything above was built from a paraphrased brief. Reading the real
assignment document directly surfaced two concrete deviations, both fixed:

- **REPORT.md heading mismatch.** The assignment requires the exact
  heading `Heterogeneity & multi-tenant`; this repo had
  `Heterogeneity & multi-tenant reuse`. The brief is explicit that exact
  headings matter ("we read a lot of submissions side by side") — fixed.
- **Missing wall-clock timeout.** §3.1 requires discovery to stop on "max
  steps, timeout, dead-end"; only max-steps and consecutive-failures were
  implemented. Added `timeoutMs` to `DiscoveryStopCondition`
  (default 5 minutes), checked at the top of every loop iteration before
  the next model call, with a regression test.

Also confirmed against the real document (no changes needed): the
`success`/`business_outcome`/`escalated`/`hard_failure` four-way taxonomy
is a deliberate refinement of the assignment's baseline
business-outcome/recoverable/hard-failure split, not a deviation from it —
recoverable conditions are still absorbed silently via retry and never
become a caller-visible outcome, and `escalated` exists as a distinct,
justified value alongside `hard_failure` because §3.6 evaluates the
escalation mechanism separately and in depth; folding it into
`hard_failure` would have made that mechanism less visible in the result
contract, not more correct. The draft/approved status gate also happens to
satisfy the "Confidence & approval" optional stretch goal from §8,
incidentally — it was built as part of the core safety design, not
pursued as an extra.

Not yet actionable without the repo owner: §11 (Submission) requires
pushing to a **public** GitHub repo and emailing the link to
`assignments@interface.ai`, with the repo URL on its own line, sent from
the address applied with, and no zip file. The draft email created earlier
in this session predates having read this section and doesn't yet reflect
it.
