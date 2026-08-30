import type { CapabilityArtifact } from "../../src/core/artifact.js";
import { FakeSurface, type FakeScreen } from "../../src/surfaces/fakeSurface.js";

// A small in-memory mirror of the real "open sub-account" flow, used by
// every ReplayEngine test. It reproduces the same four scenarios the real
// target app supports: happy path, member-not-found (business_outcome),
// compliance-hold (escalated), and a one-time interstitial (recoverable).

export const BASE_URL = "http://fake.local";

export function makeFixtureSurface(): FakeSurface {
  const state: { memberId?: string; interstitialShown: boolean } = { interstitialShown: false };

  const screens: FakeScreen[] = [
    {
      url: `${BASE_URL}/search`,
      text: () => "Member Search",
      elements: [
        { strategies: [{ kind: "testId", testId: "search-input" }], onSetValue: (value) => (state.memberId = value) },
        { strategies: [{ kind: "testId", testId: "search-submit" }], onClick: (s) => s.goto(`${BASE_URL}/results`) }
      ]
    },
    {
      url: `${BASE_URL}/results`,
      text: () => "Search Results",
      elements: [
        {
          strategies: [{ kind: "testId", testId: "view-member" }],
          onClick: (s) => {
            if (state.memberId === "M9999") {
              s.goto(`${BASE_URL}/notfound`);
              return;
            }
            if (state.memberId === "M1007" && !state.interstitialShown) {
              s.goto(`${BASE_URL}/interstitial`);
              return;
            }
            s.goto(`${BASE_URL}/detail`);
          }
        }
      ]
    },
    {
      url: `${BASE_URL}/interstitial`,
      text: () => "Retrieving record from core banking",
      elements: [
        {
          strategies: [{ kind: "testId", testId: "interstitial-continue" }],
          onClick: (s) => {
            state.interstitialShown = true;
            s.goto(`${BASE_URL}/detail`);
          }
        }
      ]
    },
    {
      url: `${BASE_URL}/notfound`,
      text: () => `No member found with ID "${state.memberId}"`,
      elements: []
    },
    {
      url: `${BASE_URL}/detail`,
      text: () => "Member detail. BALANCE:$4210",
      elements: [
        { strategies: [{ kind: "testId", testId: "open-subaccount-link" }], onClick: (s) => s.goto(`${BASE_URL}/confirm`) }
      ]
    },
    {
      url: `${BASE_URL}/confirm`,
      text: () => "Confirm new sub-account",
      elements: [
        {
          strategies: [{ kind: "testId", testId: "confirm-submit" }],
          onClick: (s) => {
            if (state.memberId === "M1008") {
              s.goto(`${BASE_URL}/hold`);
              return;
            }
            s.goto(`${BASE_URL}/success`);
          }
        }
      ]
    },
    { url: `${BASE_URL}/hold`, text: () => "COMPLIANCE HOLD: supervisor override required", elements: [] },
    { url: `${BASE_URL}/success`, text: () => "Sub-account opened. NEW_BALANCE:$500", elements: [] }
  ];

  return new FakeSurface(screens, `${BASE_URL}/search`);
}

export function makeFixtureArtifact(overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  const artifact: CapabilityArtifact = {
    id: "open-subaccount-test",
    version: 1,
    status: "draft",
    goal: "Open a sub-account for a member",
    target: { surface: "dom", baseUrl: BASE_URL },
    createdAt: new Date().toISOString(),
    discoveredBy: { model: "test", discoveryRunId: "test-run" },
    inputParams: [{ name: "memberId", type: "string", description: "Member ID", required: true }],
    outputs: [
      { name: "balance", type: "number", description: "Balance read from detail page", required: false },
      { name: "newBalance", type: "number", description: "New sub-account balance after opening", required: false }
    ],
    steps: [
      {
        id: "navigate-search",
        description: "Go to member search",
        action: { type: "navigate", value: `${BASE_URL}/search` },
        risk: "safe",
        riskRationale: "Read-only navigation.",
        checkpoint: { kind: "textVisible", value: "Member Search", description: "Search page loaded" },
        recoverable: [],
        extract: []
      },
      {
        id: "fill-search",
        description: "Type the member ID into the search box",
        action: {
          type: "fill",
          locator: {
            description: "Search input",
            strategies: [{ kind: "testId", testId: "search-input" }],
            rationale: "testId is stable"
          },
          value: "{{memberId}}"
        },
        risk: "safe",
        riskRationale: "Filling a search box has no side effects.",
        checkpoint: null,
        recoverable: [],
        extract: []
      },
      {
        id: "submit-search",
        description: "Submit the search",
        action: {
          type: "click",
          locator: {
            description: "Search button",
            strategies: [{ kind: "testId", testId: "search-submit" }],
            rationale: "testId is stable"
          }
        },
        risk: "safe",
        riskRationale: "Search is read-only.",
        checkpoint: { kind: "textVisible", value: "Search Results", description: "Results page loaded" },
        recoverable: [],
        extract: []
      },
      {
        id: "open-member",
        description: "Open the member record",
        action: {
          type: "click",
          locator: {
            description: "View member link",
            strategies: [{ kind: "testId", testId: "view-member" }],
            rationale: "testId is stable"
          }
        },
        risk: "safe",
        riskRationale: "Viewing a member record is read-only.",
        checkpoint: { kind: "textVisible", value: "BALANCE:", description: "Member detail page loaded" },
        recoverable: [
          {
            description: "Dismiss the 'retrieving record' interstitial",
            match: { kind: "textVisible", value: "Retrieving record", description: "Interstitial shown" },
            handling: "dismissAndRetry",
            dismissAction: {
              type: "click",
              locator: {
                description: "Continue button",
                strategies: [{ kind: "testId", testId: "interstitial-continue" }],
                rationale: "testId is stable"
              }
            },
            maxAttempts: 3
          }
        ],
        extract: [{ outputField: "balance", pattern: "BALANCE:\\$(\\d+)", transform: "number" }]
      },
      {
        id: "open-subaccount-link",
        description: "Navigate to the open-sub-account form",
        action: {
          type: "click",
          locator: {
            description: "Open Sub-Account link",
            strategies: [{ kind: "testId", testId: "open-subaccount-link" }],
            rationale: "testId is stable"
          }
        },
        risk: "safe",
        riskRationale: "Only navigates to a form; nothing is submitted yet.",
        checkpoint: { kind: "textVisible", value: "Confirm new sub-account", description: "Confirmation page loaded" },
        recoverable: [],
        extract: []
      },
      {
        id: "confirm-submit",
        description: "Submit the new sub-account",
        action: {
          type: "click",
          locator: {
            description: "Confirm and open account button",
            strategies: [{ kind: "testId", testId: "confirm-submit" }],
            rationale: "testId is stable"
          }
        },
        risk: "risky",
        riskRationale: "Irreversibly opens a new financial account for the member.",
        checkpoint: { kind: "textVisible", value: "Sub-account opened", description: "Success page loaded" },
        recoverable: [],
        extract: [{ outputField: "newBalance", pattern: "NEW_BALANCE:\\$(\\d+)", transform: "number" }]
      }
    ],
    overallCheckpoint: { kind: "textVisible", value: "Sub-account opened", description: "Flow completed successfully" },
    businessOutcomes: [
      {
        label: "member_not_found",
        match: { kind: "textVisible", value: "No member found", description: "Not-found page shown" },
        message: "No such member."
      }
    ],
    escalationTriggers: [
      {
        label: "compliance_hold",
        match: { kind: "textVisible", value: "COMPLIANCE HOLD", description: "Compliance hold page shown" },
        reason: "Member has a compliance hold; requires supervisor override."
      }
    ],
    riskSummary: { hasRiskySteps: true, justification: "Opening a sub-account is an irreversible financial action." }
  };
  return { ...artifact, ...overrides };
}
