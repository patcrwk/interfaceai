import { Router } from "express";
import {
  consumeInterstitial,
  getMember,
  openSubAccount,
  searchMembers,
  type SubAccountType
} from "../business.js";
import { escapeHtml, formatCurrency } from "../html.js";

// The /legacy variant: nested tables, <div onclick> fake buttons, no
// labels, no ids that mean anything, no data-testid, no semantic
// structure. This is deliberately hostile to DOM-locator strategies —
// it's what VisionSurface drives via screenshot + coordinate grounding,
// re-grounding against a fresh screenshot on every step.
//
// Real submits still go through actual <form> elements (browsers need
// that to POST), but the "buttons" that trigger them are unlabeled
// <div onclick> elements, matching the fake-button pattern common in
// legacy vendor back-office UIs skinned on top of ancient tooling.

const router = Router();

function shell(body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: "MS Sans Serif", Tahoma, sans-serif; background: #d4d0c8; font-size: 13px; color: #000; }
  table { border-collapse: collapse; }
  table.outer { width: 100%; background: #d4d0c8; padding: 8px; }
  table.panel { background: #ece9d8; border: 2px inset #fff; padding: 4px; margin: 6px; }
  td { padding: 3px 6px; vertical-align: top; }
  .hdr { background: #0a246a; color: #fff; font-weight: bold; padding: 4px 8px; }
  .fakebtn { display: inline-block; background: #ece9d8; border: 2px outset #fff; padding: 3px 14px; cursor: pointer; font-size: 12px; }
  .fakebtn:active { border-style: inset; }
  input[type=text], input[type=number], select { font-size: 12px; }
  a { color: #00e; }
</style>
<script>
  function go(url) { window.location.href = url; }
  function submitForm(id) { document.getElementById(id).submit(); }
</script>
</head>
<body>
<table class="outer"><tr><td>
${body}
</td></tr></table>
</body>
</html>`;
}

router.get("/", (_req, res) => {
  res.send(
    shell(`
<table class="panel"><tr><td class="hdr">Member Lookup</td></tr>
<tr><td>
  <form id="searchForm" action="/legacy/members" method="get">
    <table><tr>
      <td>
        <table><tr><td>Member ID or Name:</td><td><input type="text" name="q" size="24" /></td></tr></table>
      </td>
      <td><div class="fakebtn" onclick="submitForm('searchForm')">Go</div></td>
    </tr></table>
  </form>
</td></tr></table>
`)
  );
});

router.get("/members", (req, res) => {
  const q = String(req.query.q ?? "");
  const results = searchMembers(q);
  const rows = results
    .map(
      (m) => `<tr><td>${escapeHtml(m.id)}</td><td>${escapeHtml(m.name)}</td><td><div class="fakebtn" onclick="go('/legacy/members/${escapeHtml(m.id)}')">Open</div></td></tr>`
    )
    .join("\n");

  res.send(
    shell(`
<table class="panel"><tr><td class="hdr">Results</td></tr>
<tr><td>
  <table class="panel"><tr><td>
    ${
      results.length === 0
        ? `<table><tr><td>No records matched: ${escapeHtml(q)}</td></tr></table>`
        : `<table border="1"><tr><td>ID</td><td>Name</td><td>&nbsp;</td></tr>${rows}</table>`
    }
  </td></tr></table>
  <div class="fakebtn" onclick="go('/legacy/')">Back</div>
</td></tr></table>
`)
  );
});

router.get("/members/:id", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.send(
      shell(`
<table class="panel"><tr><td class="hdr">Error</td></tr>
<tr><td><table><tr><td>No member on file for ID: ${escapeHtml(req.params.id)}</td></tr></table></td></tr></table>
<div class="fakebtn" onclick="go('/legacy/')">Back</div>
`)
    );
    return;
  }

  if (consumeInterstitial(member.id)) {
    res.send(
      shell(`
<table class="panel"><tr><td class="hdr">Please Wait</td></tr>
<tr><td><table><tr><td>Retrieving record from core banking system...</td></tr></table></td></tr></table>
<div class="fakebtn" onclick="go('/legacy/members/${escapeHtml(member.id)}')">Continue</div>
`)
    );
    return;
  }

  const accountRows = member.accounts
    .map(
      (a) => `<tr><td>${escapeHtml(a.id)}</td><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.nickname)}</td><td>${formatCurrency(a.balance)}</td></tr>`
    )
    .join("\n");

  res.send(
    shell(`
<table class="panel"><tr><td class="hdr">Member Detail</td></tr>
<tr><td>
  <table><tr>
    <td>
      <table>
        <tr><td>Name:</td><td>${escapeHtml(member.name)}</td></tr>
        <tr><td>ID:</td><td>${escapeHtml(member.id)}</td></tr>
        <tr><td>Balance:</td><td>${formatCurrency(member.balance)}</td></tr>
      </table>
    </td>
  </tr></table>
  <table class="panel"><tr><td>
    <table border="1"><tr><td>Acct</td><td>Type</td><td>Nickname</td><td>Bal</td></tr>${accountRows}</table>
  </td></tr></table>
  <div class="fakebtn" onclick="go('/legacy/members/${escapeHtml(member.id)}/subaccounts/new')">New Sub-Acct</div>
  <div class="fakebtn" onclick="go('/legacy/')">Back</div>
</td></tr></table>
`)
  );
});

router.get("/members/:id/subaccounts/new", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.status(404).send(shell(`<table><tr><td>No member on file.</td></tr></table>`));
    return;
  }
  res.send(
    shell(`
<table class="panel"><tr><td class="hdr">New Sub-Account</td></tr>
<tr><td>
  <form id="newAcctForm" action="/legacy/members/${escapeHtml(member.id)}/subaccounts/new" method="post">
    <table>
      <tr><td>Type:</td><td>
        <select name="type">
          <option value="savings">SAV</option>
          <option value="checking">CHK</option>
          <option value="cd">CD</option>
        </select>
      </td></tr>
      <tr><td>Nickname:</td><td><input type="text" name="nickname" size="20" /></td></tr>
      <tr><td>Deposit:</td><td><input type="number" name="initialDeposit" min="0" step="0.01" size="10" /></td></tr>
    </table>
  </form>
  <div class="fakebtn" onclick="submitForm('newAcctForm')">Next</div>
</td></tr></table>
`)
  );
});

router.post("/members/:id/subaccounts/new", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.status(404).send(shell(`<table><tr><td>No member on file.</td></tr></table>`));
    return;
  }
  const type = String(req.body.type ?? "") as SubAccountType;
  const nickname = String(req.body.nickname ?? "");
  const initialDeposit = Number(req.body.initialDeposit ?? "");

  res.send(
    shell(`
<table class="panel"><tr><td class="hdr">Confirm</td></tr>
<tr><td>
  <table><tr><td>
    <table>
      <tr><td>Member:</td><td>${escapeHtml(member.name)} (${escapeHtml(member.id)})</td></tr>
      <tr><td>Type:</td><td>${escapeHtml(type)}</td></tr>
      <tr><td>Nickname:</td><td>${escapeHtml(nickname)}</td></tr>
      <tr><td>Deposit:</td><td>${formatCurrency(initialDeposit || 0)}</td></tr>
    </table>
  </td></tr></table>
  <form id="confirmForm" action="/legacy/members/${escapeHtml(member.id)}/subaccounts/confirm" method="post">
    <input type="hidden" name="type" value="${escapeHtml(type)}" />
    <input type="hidden" name="nickname" value="${escapeHtml(nickname)}" />
    <input type="hidden" name="initialDeposit" value="${escapeHtml(initialDeposit)}" />
  </form>
  <div class="fakebtn" onclick="submitForm('confirmForm')">Submit</div>
  <div class="fakebtn" onclick="go('/legacy/members/${escapeHtml(member.id)}/subaccounts/new')">Back</div>
</td></tr></table>
`)
  );
});

router.post("/members/:id/subaccounts/confirm", (req, res) => {
  const type = String(req.body.type ?? "") as SubAccountType;
  const nickname = String(req.body.nickname ?? "");
  const initialDeposit = Number(req.body.initialDeposit ?? "");

  const result = openSubAccount(req.params.id, { type, nickname, initialDeposit });

  if (result.ok) {
    res.send(
      shell(`
<table class="panel"><tr><td class="hdr">Done</td></tr>
<tr><td><table><tr><td>Account ${escapeHtml(result.subAccount.id)} (${escapeHtml(result.subAccount.type)}) opened. Balance ${formatCurrency(result.subAccount.balance)}.</td></tr></table></td></tr></table>
<div class="fakebtn" onclick="go('/legacy/members/${escapeHtml(req.params.id)}')">Back to member</div>
`)
    );
    return;
  }
  if (result.reason === "member_not_found") {
    res.send(shell(`<table><tr><td>No member on file for ID: ${escapeHtml(req.params.id)}</td></tr></table>`));
    return;
  }
  if (result.reason === "compliance_hold") {
    res.send(
      shell(`
<table class="panel"><tr><td class="hdr">Blocked</td></tr>
<tr><td><table><tr><td>${escapeHtml(result.message)}</td></tr></table></td></tr></table>
<div class="fakebtn" onclick="go('/legacy/members/${escapeHtml(req.params.id)}')">Back to member</div>
`)
    );
    return;
  }
  res.status(400).send(shell(`<table><tr><td>${escapeHtml(result.message)}</td></tr></table>`));
});

export default router;
