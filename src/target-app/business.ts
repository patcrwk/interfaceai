// Shared business logic for the credit union back-office member-servicing
// flow. Both the /modern and /legacy variants call into this module — it is
// the "one shared business-logic layer, rendered as two variants" the brief
// asks for. Neither variant may contain business rules of its own.

export type SubAccountType = "savings" | "checking" | "cd";

export interface SubAccount {
  id: string;
  type: SubAccountType;
  nickname: string;
  balance: number;
}

export interface Member {
  id: string;
  name: string;
  balance: number;
  accounts: SubAccount[];
  /**
   * Simulates a real back-office condition where a member's account has a
   * compliance/fraud hold that blocks self-service account opening and
   * requires a supervisor override. Used to produce a realistic
   * "escalated" / permission-denial outcome for replay, distinct from a
   * plain "member not found" business outcome.
   */
  complianceHold: boolean;
}

let nextSubAccountSeq = 1;

// Simulates a known, transient interstitial ("record is loading from core
// banking, please wait") that a real back-office UI would show once per
// session before settling. Deterministic (keyed by member id, not random)
// so it's reproducible in tests and in the real discovery/replay runs: the
// artifact records a `recoverable` rule that dismisses it automatically
// rather than escalating.
const MEMBERS_WITH_INTERSTITIAL = new Set(["M1007"]);
let interstitialPending = new Map<string, boolean>();

export function consumeInterstitial(memberId: string): boolean {
  const pending = interstitialPending.get(memberId) ?? false;
  if (pending) {
    interstitialPending.set(memberId, false);
    return true;
  }
  return false;
}

function seedMembers(): Member[] {
  return [
    { id: "M1001", name: "Alice Nguyen", balance: 4210.55, accounts: [], complianceHold: false },
    { id: "M1002", name: "Brian Osei", balance: 128.9, accounts: [], complianceHold: false },
    { id: "M1003", name: "Carla Reyes", balance: 15320.0, accounts: [], complianceHold: false },
    { id: "M1004", name: "Dennis Farah", balance: 902.15, accounts: [], complianceHold: false },
    { id: "M1005", name: "Elena Popescu", balance: 60.0, accounts: [], complianceHold: false },
    { id: "M1006", name: "Frank Whitmore", balance: 7754.32, accounts: [], complianceHold: false },
    { id: "M1007", name: "Grace Kim", balance: 233.1, accounts: [], complianceHold: false },
    {
      id: "M1008",
      name: "Harold Vance",
      balance: 41010.0,
      accounts: [],
      complianceHold: true // deliberately reserved: exercises the compliance-hold / escalation path
    }
  ];
}

// Module-level in-memory store. Resets on process restart, which is fine —
// this app exists only as a target for the automation to drive, not as a
// system of record.
let members: Member[] = seedMembers();

export function resetStore(): void {
  members = seedMembers();
  nextSubAccountSeq = 1;
  interstitialPending = new Map(
    [...MEMBERS_WITH_INTERSTITIAL].map((id) => [id, true])
  );
}
resetStore();

export function searchMembers(query: string): Member[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return members.filter(
    (m) => m.id.toLowerCase() === q || m.name.toLowerCase().includes(q)
  );
}

export function getMember(id: string): Member | undefined {
  return members.find((m) => m.id.toLowerCase() === id.toLowerCase());
}

export interface OpenSubAccountInput {
  type: SubAccountType;
  nickname: string;
  initialDeposit: number;
}

export type OpenSubAccountResult =
  | { ok: true; subAccount: SubAccount }
  | { ok: false; reason: "member_not_found" }
  | { ok: false; reason: "compliance_hold"; message: string }
  | { ok: false; reason: "invalid_input"; message: string };

export function openSubAccount(
  memberId: string,
  input: OpenSubAccountInput
): OpenSubAccountResult {
  const member = getMember(memberId);
  if (!member) return { ok: false, reason: "member_not_found" };

  if (member.complianceHold) {
    return {
      ok: false,
      reason: "compliance_hold",
      message:
        "This member's account has an active compliance hold. Opening a new sub-account requires supervisor override and cannot be completed through self-service."
    };
  }

  if (!input.nickname || input.nickname.trim().length === 0) {
    return { ok: false, reason: "invalid_input", message: "Nickname is required." };
  }
  if (!Number.isFinite(input.initialDeposit) || input.initialDeposit < 0) {
    return { ok: false, reason: "invalid_input", message: "Initial deposit must be a non-negative number." };
  }
  if (!["savings", "checking", "cd"].includes(input.type)) {
    return { ok: false, reason: "invalid_input", message: "Unknown account type." };
  }

  const subAccount: SubAccount = {
    id: `SA${String(nextSubAccountSeq++).padStart(4, "0")}`,
    type: input.type,
    nickname: input.nickname.trim(),
    balance: input.initialDeposit
  };
  member.accounts.push(subAccount);
  return { ok: true, subAccount };
}
