import { Router } from "express";
import {
  consumeInterstitial,
  getMember,
  openSubAccount,
  searchMembers,
  type SubAccountType
} from "../business.js";
import { escapeHtml, formatCurrency } from "../html.js";

// The /modern variant: semantic HTML, labeled inputs, data-testid hooks.
// This is what DomSurface drives — role/label/text locators should work
// reliably here, which is the point of the comparison against /legacy.

const router = Router();

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; color: #1a1a2e; }
  h1 { font-size: 1.4rem; }
  label { display: block; font-weight: 600; margin-top: 1rem; }
  input, select { display: block; font-size: 1rem; padding: 0.4rem; margin-top: 0.25rem; width: 100%; box-sizing: border-box; }
  button { margin-top: 1.25rem; font-size: 1rem; padding: 0.5rem 1.2rem; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; border-bottom: 1px solid #ccc; padding: 0.5rem; }
  .banner { padding: 0.75rem 1rem; border-radius: 4px; margin-top: 1rem; }
  .banner-hold { background: #fff3cd; border: 1px solid #ffca2c; }
  .banner-notfound { background: #f8d7da; border: 1px solid #f1aeb5; }
  .banner-success { background: #d1e7dd; border: 1px solid #a3cfbb; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

router.get("/", (_req, res) => {
  res.send(
    page(
      "Member Search",
      `<h1>Member Search</h1>
       <form action="/modern/members" method="get" data-testid="search-form">
         <label for="q">Search by member ID or name</label>
         <input id="q" name="q" type="text" data-testid="search-input" autofocus />
         <button type="submit" data-testid="search-submit">Search</button>
       </form>`
    )
  );
});

router.get("/members", (req, res) => {
  const q = String(req.query.q ?? "");
  const results = searchMembers(q);
  const rows = results
    .map(
      (m) => `<tr>
        <td>${escapeHtml(m.id)}</td>
        <td>${escapeHtml(m.name)}</td>
        <td><a href="/modern/members/${escapeHtml(m.id)}" data-testid="view-member-${escapeHtml(m.id)}">View</a></td>
      </tr>`
    )
    .join("\n");

  res.send(
    page(
      "Search Results",
      `<h1>Search Results for "${escapeHtml(q)}"</h1>
       <nav><a href="/modern/">New search</a></nav>
       ${
         results.length === 0
           ? `<p data-testid="no-results" class="banner banner-notfound">No members matched "${escapeHtml(q)}".</p>`
           : `<table data-testid="results-table">
                <thead><tr><th>ID</th><th>Name</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
              </table>`
       }`
    )
  );
});

router.get("/members/:id", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.send(
      page(
        "Member Not Found",
        `<h1>Member Not Found</h1>
         <p data-testid="member-not-found" class="banner banner-notfound">
           No member found with ID "${escapeHtml(req.params.id)}".
         </p>
         <nav><a href="/modern/">New search</a></nav>`
      )
    );
    return;
  }

  if (consumeInterstitial(member.id)) {
    res.send(
      page(
        "Loading Member Record",
        `<h1>Loading Member Record</h1>
         <p data-testid="interstitial-message">Retrieving record from core banking. This may take a moment.</p>
         <a href="/modern/members/${escapeHtml(member.id)}" data-testid="interstitial-continue">Continue</a>`
      )
    );
    return;
  }

  const accountRows = member.accounts
    .map(
      (a) => `<tr><td>${escapeHtml(a.id)}</td><td>${escapeHtml(a.type)}</td><td>${escapeHtml(a.nickname)}</td><td>${formatCurrency(a.balance)}</td></tr>`
    )
    .join("\n");

  res.send(
    page(
      `Member ${member.id}`,
      `<h1>${escapeHtml(member.name)} (${escapeHtml(member.id)})</h1>
       <p data-testid="member-balance">Primary balance: <strong>${formatCurrency(member.balance)}</strong></p>
       <table data-testid="subaccounts-table">
         <thead><tr><th>Account ID</th><th>Type</th><th>Nickname</th><th>Balance</th></tr></thead>
         <tbody>${accountRows}</tbody>
       </table>
       <nav>
         <a href="/modern/members/${escapeHtml(member.id)}/subaccounts/new" data-testid="open-subaccount-link">Open Sub-Account</a>
         <a href="/modern/">New search</a>
       </nav>`
    )
  );
});

router.get("/members/:id/subaccounts/new", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.status(404).send(page("Member Not Found", `<p data-testid="member-not-found">No member found.</p>`));
    return;
  }
  res.send(
    page(
      "Open Sub-Account",
      `<h1>Open Sub-Account for ${escapeHtml(member.name)}</h1>
       <form action="/modern/members/${escapeHtml(member.id)}/subaccounts/new" method="post" data-testid="open-subaccount-form">
         <label for="type">Account type</label>
         <select id="type" name="type" data-testid="account-type">
           <option value="savings">Savings</option>
           <option value="checking">Checking</option>
           <option value="cd">Certificate of Deposit</option>
         </select>
         <label for="nickname">Nickname</label>
         <input id="nickname" name="nickname" type="text" data-testid="account-nickname" />
         <label for="initialDeposit">Initial deposit (USD)</label>
         <input id="initialDeposit" name="initialDeposit" type="number" min="0" step="0.01" data-testid="account-deposit" />
         <button type="submit" data-testid="review-submit">Review</button>
       </form>`
    )
  );
});

router.post("/members/:id/subaccounts/new", (req, res) => {
  const member = getMember(req.params.id);
  if (!member) {
    res.status(404).send(page("Member Not Found", `<p data-testid="member-not-found">No member found.</p>`));
    return;
  }
  const type = String(req.body.type ?? "") as SubAccountType;
  const nickname = String(req.body.nickname ?? "");
  const initialDeposit = Number(req.body.initialDeposit ?? "");

  res.send(
    page(
      "Confirm Sub-Account",
      `<h1>Confirm New Sub-Account</h1>
       <p>Please review before submitting. This action is irreversible.</p>
       <table>
         <tbody>
           <tr><th>Member</th><td data-testid="confirm-member">${escapeHtml(member.name)} (${escapeHtml(member.id)})</td></tr>
           <tr><th>Type</th><td data-testid="confirm-type">${escapeHtml(type)}</td></tr>
           <tr><th>Nickname</th><td data-testid="confirm-nickname">${escapeHtml(nickname)}</td></tr>
           <tr><th>Initial deposit</th><td data-testid="confirm-deposit">${formatCurrency(initialDeposit || 0)}</td></tr>
         </tbody>
       </table>
       <form action="/modern/members/${escapeHtml(member.id)}/subaccounts/confirm" method="post" data-testid="confirm-form">
         <input type="hidden" name="type" value="${escapeHtml(type)}" />
         <input type="hidden" name="nickname" value="${escapeHtml(nickname)}" />
         <input type="hidden" name="initialDeposit" value="${escapeHtml(initialDeposit)}" />
         <button type="submit" data-testid="confirm-submit">Confirm and Open Account</button>
       </form>
       <nav><a href="/modern/members/${escapeHtml(member.id)}/subaccounts/new" data-testid="edit-link">Edit</a></nav>`
    )
  );
});

router.post("/members/:id/subaccounts/confirm", (req, res) => {
  const type = String(req.body.type ?? "") as SubAccountType;
  const nickname = String(req.body.nickname ?? "");
  const initialDeposit = Number(req.body.initialDeposit ?? "");

  const result = openSubAccount(req.params.id, { type, nickname, initialDeposit });

  if (result.ok) {
    res.send(
      page(
        "Sub-Account Opened",
        `<h1>Sub-Account Opened</h1>
         <p data-testid="success-banner" class="banner banner-success">
           Account ${escapeHtml(result.subAccount.id)} (${escapeHtml(result.subAccount.type)}) opened with a balance of ${formatCurrency(result.subAccount.balance)}.
         </p>
         <nav><a href="/modern/members/${escapeHtml(req.params.id)}">Back to member</a></nav>`
      )
    );
    return;
  }

  if (result.reason === "member_not_found") {
    res.send(page("Member Not Found", `<p data-testid="member-not-found" class="banner banner-notfound">No member found with ID "${escapeHtml(req.params.id)}".</p>`));
    return;
  }
  if (result.reason === "compliance_hold") {
    res.send(
      page(
        "Compliance Hold",
        `<h1>Unable to Open Account</h1>
         <p data-testid="compliance-hold-banner" class="banner banner-hold">${escapeHtml(result.message)}</p>
         <nav><a href="/modern/members/${escapeHtml(req.params.id)}">Back to member</a></nav>`
      )
    );
    return;
  }
  res.status(400).send(
    page(
      "Invalid Input",
      `<p data-testid="invalid-input-banner" class="banner banner-notfound">${escapeHtml(result.message)}</p>`
    )
  );
});

export default router;
