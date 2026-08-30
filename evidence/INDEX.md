# Evidence index

Everything under `evidence/` is a real run against the live target app with
a real Anthropic API key — nothing here is hand-written or scripted. The
`evidence/logs/` directory contains **every** discovery and replay run made
while building this system, in chronological order, including the ones that
failed. They're kept rather than deleted because the failures are the most
concrete evidence that discovery is real: each one is a genuine bug found by
actually running the system, fixed in the code, and re-run. See
[CHANGELOG.md](../CHANGELOG.md) for the full narrative of what each bug was
and how it was fixed.

## Canonical files (the current, fully-correct artifact and its replays)

**Artifact**: [`artifacts/open-subaccount.json`](artifacts/open-subaccount.json) — v2, `approved`, discovered by `claude-sonnet-5`.

v2 was run independently by the repo owner (not the building session) from
the exact `discover` command in README.md — the same command anyone
following the README would type — which is why it declares no
`outputs` (the earlier v1 discovery run used a more elaborate goal that
asked for balance extraction; the README's own example goal doesn't). Its
`businessOutcomes`/`escalationTriggers` rules carried forward unchanged
from v1, since a fresh main-flow discovery replaces the happy-path steps
but preserves previously-learned edge-case rules
(`discovery/artifactCompiler.ts`).

**Discovery runs**:

| Log | Goal | Result |
|---|---|---|
| `logs/discovery-1788106235838.jsonl` | Open a sub-account for M1001 (README's exact example command, run by the repo owner) | `goal_met` — v2 main artifact steps |
| `logs/discovery-1788104570931.jsonl` | Look up nonexistent member M9999 | `business_outcome` — `member_not_found` rule (carried into v2) |
| `logs/discovery-1788104584444.jsonl` | Attempt to open a sub-account for M1008 | `escalation` — `compliance_hold_blocked` rule (carried into v2) |

**Replay runs**, all against v2, all with input params never used during
any discovery run (proving genuine reuse, not replay of a memorized trace):

| Log | Params | Outcome |
|---|---|---|
| `logs/replay-1788106279315.jsonl` | repo owner's own choice, interactive, artifact still `draft` | `success` — real CLI risk-gate confirmation (`[y/N]`) before the risky step |
| `logs/replay-1788106682375.jsonl` | M9999 | `business_outcome` (`member_not_found`) |
| `logs/replay-1788106683846.jsonl` | M1008 | `escalated` (`compliance_hold_blocked`), artifact `approved` so replay reaches the real compliance-hold page rather than failing closed on the risk gate — see `screenshots/escalation-step-8-1788106684452.png` |
| `logs/replay-1788106685286.jsonl` | `{}` (missing required params) | `hard_failure` at the `$input` gate |

All screenshots referenced by an `escalated`/`hard_failure` outcome's
`evidence.screenshotPath` live in `evidence/screenshots/`. The v1 replay
logs (`replay-1788104542143.jsonl` through `replay-1788104801917.jsonl`,
including the ones demonstrating output extraction) are kept in
`evidence/logs/` as part of the historical record described below, since
they're what originally validated extraction, unattended approved replay,
and the pre-fix bugs — just superseded as "canonical" by the v2 runs above.

## VisionSurface / `/legacy` (second artifact, second surface)

**Artifact**: [`artifacts/lookup-balance-legacy.json`](artifacts/lookup-balance-legacy.json) — v1, `draft`, discovered entirely via screenshot + Claude-vision coordinate grounding against the deliberately clean-DOM-free `/legacy` variant.

| Log | What | Result |
|---|---|---|
| `logs/discovery-1788105187698.jsonl` | Real discovery: "look up M1002's balance" against `/legacy` | `goal_met` in 5 steps |
| `logs/replay-1788105229591.jsonl` | Real replay with M1006 — a member never used during discovery | `success` — `{memberBalance: 7754.32}` |

The replay reusing a different member than discovery is the same proof
point as the `/modern` artifact: the recorded plan generalizes, it isn't a
memorized trace of one specific run.

## Everything else in `evidence/logs/`

The remaining ~39 files are earlier attempts made while getting the above
right — real API calls against the real app that surfaced real bugs
(infinite fill loops, un-parameterized checkpoints, a per-row `data-testid`
baked into a locator, `NaN` from comma-formatted currency, a greedy
extraction regex, and a business-outcome page with no element to click
next). Each is a genuine discovery or replay attempt, not a fabricated
failure. See CHANGELOG.md for the blow-by-blow.
