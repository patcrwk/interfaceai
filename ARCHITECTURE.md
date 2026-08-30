# ARCHITECTURE.md

Module map and data flow. Updated as the system is built; see
[CHANGELOG.md](CHANGELOG.md) for the chronological log of what changed when.

## Directory layout

```
src/
  target-app/       Express app: shared business logic + two rendered
                     variants (/modern, /legacy). The "real system" the
                     agent drives.
  core/              Surface interface, CapabilityArtifact Zod schema,
                     shared types (outcome taxonomy, risk classification).
  surfaces/          Surface implementations: DomSurface, VisionSurface,
                     FakeSurface (in-memory, used only by unit tests).
  discovery/         The goal-driven discovery loop + Anthropic client.
  replay/            ReplayEngine: deterministic artifact execution.
  safety/            Allowlist enforcement, redaction, risk classification.
  escalation/        Human handoff: pause/resume + injected event logging.
  logging/           Structured JSONL logger used by both discovery + replay.
  cli/               Entry points: discover.ts, replay.ts, approve.ts.
test/                Vitest unit tests, all against FakeSurface.
artifacts/           Saved CapabilityArtifact JSON files.
evidence/            Real discovery/replay run logs, screenshots, artifacts.
```

## Data flow

1. **Discovery**: `cli/discover.ts` launches a headed Playwright browser,
   wraps the page in a `DomSurface` or `VisionSurface`, and hands it to
   `discovery/discoveryLoop.ts` along with a natural-language goal. The loop
   observes the surface, asks Claude what to do next, acts, and repeats until
   the goal is met or a stopping condition fires. Every step is logged. On
   success, the recorded steps are assembled into a `CapabilityArtifact`
   (status: `draft`) and saved to `artifacts/`.

2. **Replay**: `cli/replay.ts` loads a `CapabilityArtifact`, validates it
   against the Zod schema, and hands it to `replay/replayEngine.ts` with
   caller-supplied input params. The engine walks the recorded steps in
   order, resolving each element via its locator fallback chain, verifying
   per-step checkpoints, and returns one of four outcomes. No LLM call is
   ever made here.

3. **Escalation**: if replay (or discovery) hits a condition it can't resolve
   deterministically, `escalation/handoff.ts` pauses the automation loop on
   the live page, prints an intervention request to the CLI (which
   capability/goal, current step, why it stopped, screenshot path), and
   injects a page-side event listener so the human's manual clicks/inputs are
   still logged. Resuming hands control back to the same `Surface`/page.

## Key seams (see REPORT.md for the full design rationale)

- `Surface` is the single interface both `DomSurface` and `VisionSurface`
  implement (`observe`, `act`, `screenshot`, ...). Discovery and replay code
  are written against `Surface`, never against a concrete implementation —
  this is also the seam a future frameset-based legacy app or a native
  desktop accessibility-tree surface would plug into.
- `CapabilityArtifact` is the seam between "how we perceived/acted on a
  surface during discovery" and "what replay executes." Replay never touches
  a `Surface`'s discovery-time state, only what was recorded in the artifact.
- Outcome taxonomy (`success` / `business_outcome` / `escalated` /
  `hard_failure`) is a return value, not an exception hierarchy — callers of
  `ReplayEngine.run()` get a discriminated union, not a try/catch.
