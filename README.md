# interface.ai Computer-Use Automation — Take-Home

Discovery-to-deterministic-replay automation for a credit union back-office
member-servicing flow. An LLM drives a real browser once to complete a goal
("discovery"); that run is recorded as a typed `CapabilityArtifact`;
afterward the artifact replays deterministically — no model in the decision
loop — returning one of four structured outcomes.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, [CHANGELOG.md](CHANGELOG.md)
for the full build narrative (including every real bug found and fixed
along the way), and [REPORT.md](REPORT.md) for the design write-up.

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
```

Copy `.env.example` to `.env` and add your own Anthropic API key (needed
only for `discover` and for `replay` of a `vision`-target artifact —
`typecheck`, `test`, and DOM-target `replay` need no key at all):

```bash
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=sk-ant-...
```

## Commands

```bash
npm run typecheck      # no browser, no API key
npm test                # no browser, no API key — 36 tests against FakeSurface
npm run dev:app         # starts the target app on http://localhost:4173
                        #   /modern/  — clean DOM, for DomSurface
                        #   /legacy/  — no clean DOM, for VisionSurface
```

`dev:app` must be running in one terminal before `discover` or `replay` in
another. The target app is in-memory and resets on restart; you can also
force a reset mid-session with `curl -X POST http://localhost:4173/__reset`.

### 1. Run a discovery goal (real Anthropic API call, real browser)

```bash
npm run discover -- --goal "Search for member M1001, open their record, open a new Savings sub-account for them with nickname \"Emergency Fund\" and an initial deposit of 250, then confirm and complete opening the account." --target modern --capability-id open-subaccount
```

Add `--headed` to watch the browser. `--target legacy` drives the same flow
via `VisionSurface`. Saves/updates `artifacts/<capability-id>.json` as a
`draft`. A goal aimed at a known edge case instead of the main flow appends
a `business_outcome`/`escalation` rule to an existing artifact — see
[REPORT.md](REPORT.md) "Artifact schema" and
[evidence/INDEX.md](evidence/INDEX.md) for the two probe goals actually
used (`M9999` / `M1008`).

### 2. Replay the resulting artifact (deterministic, no model)

```bash
npm run replay -- --artifact artifacts/open-subaccount.json --params '{"memberId":"M1002","nickname":"Rainy Day","initialDeposit":75}' --interactive
```

`--interactive` attaches a live CLI operator: a `draft` artifact's risky
step pauses for a `[y/N]` confirmation before running (no operator attached
→ fails closed, never runs risky steps unattended). Once you're satisfied,
approve it:

```bash
npm run approve -- --artifact artifacts/open-subaccount.json
npm run replay -- --artifact artifacts/open-subaccount.json --params '{"memberId":"M1003","nickname":"College Fund","initialDeposit":1000}'
```

An `approved` artifact's risky steps now run unattended, with no
`--interactive` needed. Note both replays above use different `memberId`s
than the discovery run did — the artifact is a genuinely reusable
capability, not a recording of one specific run.

### 3. Replay that hits an error/escalation

```bash
# business_outcome — a legitimate non-error result, not a failure
npm run replay -- --artifact artifacts/open-subaccount.json --params '{"memberId":"M9999","nickname":"x","initialDeposit":0}'

# escalated — a recognized blocked state (compliance hold), handed to a human
npm run replay -- --artifact artifacts/open-subaccount.json --params '{"memberId":"M1008","nickname":"Test","initialDeposit":100}'

# hard_failure — missing required input params
npm run replay -- --artifact artifacts/open-subaccount.json --params '{}'
```

Add `--interactive --headed` to the escalation case to see the real
human-handoff mechanism: the browser stays open, the CLI prints an
intervention request with a screenshot path, and pressing Enter (vs. typing
`abort`) determines whether replay re-checks the step or gives up.

All four outcomes, plus the second artifact/surface (`VisionSurface`
against `/legacy`), are captured for real in [`/evidence`](evidence/INDEX.md).
