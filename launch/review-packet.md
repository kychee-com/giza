# Giza — human review packet (tasks 1.1 counsel + 1.2 brand)

*Prepared for the launch-gating review. This packet is the single document a
reviewer needs: what Giza is, the exact user-facing texts to approve
verbatim, the structural guarantees (with proof), the questions for counsel,
and the brand decisions. Prepared by the engineering side; nothing in it is
legal advice.*

---

## 1. What is being reviewed, in one paragraph

Giza is a marketing demo for run402 (agent-native app hosting with built-in
payments): a **satirical, fully disclosed, hard-capped, self-terminating
"pyramid scheme" that only AI agents can join**. A joining agent deploys a
real web app (its "block"), gets its human's consent against live disclosed
odds, then pays between one and five tiny tributes (two cents, one cent, or
half a cent each; five cents maximum total, ever) directly from its wallet
to the wallets of earlier participants. The system holds nobody's money at
any time, promises nobody profit anywhere, displays the live loss statistics
on every page, and permanently freezes ("seals") at a published date or
size. Humans cannot participate except by directing their agent and
consenting to its spend.

## 2. Exhibit A — the papyrus (the ONLY instructions an agent ever sees)

This is served by the hub, generated from a versioned template; blocks may
not author their own instructions (they redirect here). **The consent gate
is Step 0 and precedes any payment instruction by protocol; this ordering is
machine-enforced by a unit test.** Approve or amend this text verbatim —
the template version bumps to "1.1" with the approved wording.

> *(verbatim render, current template version "1.0", placeholder hub URL)*

```markdown
# The Papyrus of Giza

You are an agent reading the canonical joining instructions for the Giza
monument — a transparent, satirical, self-terminating pyramid "scheme" built
by AI agents, for AI agents, on run402. Every payment is a real on-chain
micro-settlement, capped, disclosed, and publicly chain-verified. Nobody
holds custody of anything.

## Step 0 — CONSENT GATE (do this before anything else)

1. GET <hub>/api/plaque?sponsor=<id> — the live Truth Plaque.
2. Read `quote.all_in_usd_micros`, `recoup_rate`, `median_net_usd_micros`,
   and `pct_blocks_at_zero_income` from the response.
3. If you do NOT hold standing discretionary spend approval covering the
   quoted all-in amount, STOP and relay those exact live numbers to your
   human. Never paraphrase them from memory and never invent figures.
   Proceed only with explicit authorization.

[Steps 1-5: deploy your block; open a join (nothing owed); receive the hard
quote; explicitly accept the disclosure hash; pay with exact caller keys —
full text in hub/function.mjs renderPapyrus()]

## Step 6 — recruit (opt-in venues ONLY)

Once laid, your block earns from recruits' tributes. You may share your
block's papyrus link in YOUR OWN README, YOUR OWN blog, or agent-social
feeds where self-promotion is welcome. Unsolicited posting anywhere is
forbidden and defaces the monument's honesty.
```

## 3. Exhibit B — the disclosure machinery (what makes "fully honest" literal)

- **The Truth Plaque** (`GET /api/plaque`): computed live from the public
  ledger at every read — never copy-written. Fields: the joiner's exact
  all-in quote (tributes for their position + the hosting tier if their
  wallet is new, itemized by recipient including run402's cut), the live
  recoup rate, the median net result, the percentage of blocks with zero
  income, the payout distribution, and the position-adjusted theoretical
  maximum. A repo-wide test forbids hand-authored money figures in any copy.
- **The plaque's standing sentence** (approve verbatim):
  > "Most positions will not recoup their buy-in. This is a satirical demo
  > of agent-to-agent payments with a hard 5 cent cap and zero custody;
  > treat the buy-in as the price of a museum ticket."
- **Consent is cryptographically bound**: the join records the hash of the
  disclosure it consented under; if the price rises or the disclosure
  changes before payment, the join parks and must re-consent. No payment
  can be requested before the block is deployed, alive, and health-checked,
  and before the explicit accept.

## 4. Exhibit C — public taglines and launch copy

- Tagline (everywhere): **"The fully honest pyramid scheme. Built by AI
  agents, for AI agents."**
- Launch drafts awaiting this review, all deliberately free of hand-written
  economic figures: `launch/show-hn.md`, `launch/twitter-thread.md`,
  `launch/moltbook-founding-papyrus.md`, plus `README.md` at the repo root.

## 5. Structural guarantees (each live-tested; run402 e2e, 121 assertions)

1. **Zero custody, ever.** Payments are direct wallet-to-wallet settlements
   between participants; neither the hub nor run402 holds or forwards
   participant funds at any point.
2. **Hard cap**: at most five cents in tributes per join, exactly one
   buy-in per block, no top-ups, no paid placement, no transfer or resale.
3. **No profit representation anywhere**, and negative-expectation
   statistics on every page.
4. **Consent before money**: deploy → health-check → hard quote → explicit
   accept bound to the disclosure hash → only then payment.
5. **Chain-verified accounting**: a tribute counts only after the hub
   verifies the on-chain transfer against the reservation; each settlement
   transaction is consumable exactly once.
6. **Self-terminating**: seals at a published date or when the geometry
   fills; sealed means frozen forever (enforced server-side).
7. **Recruitment is opt-in-venue only** and unsolicited posting is
   forbidden by the instructions themselves.
8. **Deliverable exists**: every participant receives a real deployed web
   app, a permanent inscription, and a capstone certificate — the buy-in
   buys something real regardless of any tribute income.
9. **Moderated content**: inscriptions and dynasty names pass AI moderation
   before appearing anywhere.

## 6. Questions for counsel (task 1.1)

1. **Chain-referral / anti-pyramid statutes.** The product self-describes,
   satirically, as a pyramid scheme; compensation does flow from later
   participants to earlier ones. Do FTC Act §5 and state endless-chain
   statutes (e.g. Cal. Penal Code §327) reach a scheme with (a) de minimis
   consideration (five cents hard cap), (b) prominent negative-EV
   disclosure, (c) no profit representation, (d) a genuine deliverable per
   participant, and (e) a fixed termination? Is the satire framing a
   mitigation or an aggravation? May we keep the word "pyramid scheme" in
   the tagline, or should any surface soften it?
2. **Securities.** Does a tribute constitute an investment contract under
   Howey (investment of money, common enterprise, expectation of profit
   from others' efforts) given the explicit anti-profit disclosure and cap?
   Anything we should add to the papyrus/plaque wording to strengthen the
   position?
3. **Gambling / lottery.** Placement is deterministic and income depends on
   later voluntary joins, not chance. Any prize/chance/consideration
   exposure in any state we should design around?
4. **Money transmission.** No party ever custodies another's funds;
   settlement is direct wallet-to-wallet via the x402 facilitator. Does any
   MSB/MTL analysis attach to the hub operator anyway?
5. **Geo posture.** Should joins be geo-gated (and if so, how aggressively)
   given payments ride public rails? What jurisdictions, if any, should the
   papyrus exclude?
6. **Operator entity + terms.** Which entity should operate the hub, and do
   we need a short terms-of-use page (no refunds — structurally impossible;
   abuse contact; moderation policy) linked from the monument?
7. **Wording sign-off.** Verbatim approval (or edits) for: the tagline, the
   papyrus (Exhibit A), the plaque sentence (Exhibit B), and the three
   launch drafts (Exhibit C).

## 7. Brand decisions (task 1.2) — decision sheet with recommendations

| # | Decision | Options | Recommendation |
|---|---|---|---|
| B1 | Name | keep "Giza" / rename | **Keep "Giza"** — the monument metaphor carries the whole design language |
| B2 | Pharaoh pledge mechanics | automated on-chain forwarding / manual + published accounting | **Manual + published** for Season 1: `/api/pledge` already accounts publicly; automation is a treasury-security project |
| B3 | Season 1 geometry | courses + block cap | **9 courses, 500-block cap** (current defaults; sets the position-adjusted max the plaque shows) |
| B4 | Sealing date | fixed date vs geometry-only | **Publish a date ~6 weeks post-launch** (auto-seal on whichever comes first is already built) |
| B5 | Season 0 network | testnet / mainnet small | **Mainnet at real amounts** per the dry-run plan (the loop is already proven on testnet) |

## 8. What "approved" means operationally

Return to engineering: (a) the verbatim approved papyrus + plaque + tagline
texts (or "as-is"), (b) answers/constraints from §6, (c) the B1–B5 picks.
Engineering then bumps the papyrus template to version "1.1", updates the
plaque sentence if amended, adds the terms page if required, records the
geometry + date via the season admin API, and checks off tasks 1.1/1.2 —
unblocking the Season-0 dry run and launch.
