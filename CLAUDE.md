# CLAUDE.md

Conventions for working in this repo (interface.ai computer-use take-home).

## What this repo is

A discovery-to-deterministic-replay system for automating a legacy back-office
UI. An LLM drives the real UI once ("discovery") to complete a goal; that run
is recorded as a typed `CapabilityArtifact`; afterward the artifact replays
without any model in the loop ("replay"), returning one of four structured
outcomes (`success` / `business_outcome` / `escalated` / `hard_failure`).

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map and data flow, and
[REPORT.md](REPORT.md) for the design write-up (written last, once decisions
were final).

## Ground rules

- **Never fake a discovery run.** The discovery loop must actually drive a
  live Playwright browser against the real local target app. No pre-scripted
  step lists standing in for a real run.
- **No model in replay.** `ReplayEngine` must never call the Anthropic API or
  make any judgment call. If replay needs a decision it can't make
  deterministically from the artifact, that's an `escalated` outcome, not an
  LLM call.
- **Unit tests never touch a browser or the network.** `npm test` and
  `npm run typecheck` must both pass with no `ANTHROPIC_API_KEY` set and no
  Playwright browser installed. Tests exercise the `Surface` interface via
  `FakeSurface` (in-memory), never `DomSurface`/`VisionSurface` directly.
- **Redact on write, not opportunistically.** Anything that persists to disk
  (artifacts, logs) goes through the redaction layer first. Don't add a
  one-off redaction call at a call site; extend the redaction layer instead.
- **Two target-app variants, one business layer.** `/modern/*` and
  `/legacy/*` in `src/target-app` must share the same data/business logic
  module. If a change to one variant requires touching business logic, it
  belongs in the shared layer, not duplicated per variant.
- **Judgment calls get flagged, not silently made.** This repo was built
  interactively; genuine design forks (safety gating policy, handoff
  mechanism, model ID) were confirmed with the user before implementation.
  If you hit a similarly consequential fork, surface it rather than picking
  silently.

## Commands

- `npm run typecheck` — no browser, no API key required.
- `npm test` — no browser, no API key required.
- `npm run dev:app` — starts the target app (both `/modern` and `/legacy`).
- `npm run discover -- --goal "..." --target modern|legacy` — real LLM
  discovery run against the live target app. Requires `ANTHROPIC_API_KEY`.
- `npm run replay -- --artifact <path> --params '<json>'` — deterministic
  replay of a saved artifact. Requires Playwright's chromium browser
  installed (`npx playwright install chromium`), no API key.
- `npm run approve -- --artifact <path>` — flips an artifact's status from
  `draft` to `approved`, unlocking unattended replay of its risky steps.

## Status

Complete: target app, `Surface`/`CapabilityArtifact` core, `DomSurface`,
`VisionSurface`, `ReplayEngine` + outcome taxonomy, safety/escalation/
logging layers, 36 passing unit tests, real discovery/replay evidence for
both surfaces under `/evidence`. See [CHANGELOG.md](CHANGELOG.md) for the
full build narrative and [REPORT.md](REPORT.md) for the design write-up.
