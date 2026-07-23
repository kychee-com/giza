/**
 * Giza hub — registry, join state machine, chain reconciliation, canonical
 * public log, Truth Plaque, papyrus, transparency surfaces, season lifecycle.
 *
 * One catch-all function behind `/api/*` and `/blocks/*` (exact beats prefix
 * is irrelevant here; the site serves everything else).
 *
 * Trust root (spec): finalized on-chain settlement evidence verified against
 * the hard reservation. `payment_id` is correlation metadata. No platform
 * signature is required or trusted. All public copy: "chain-verified".
 *
 * Placeholders substituted at deploy: __GIZA_NETWORK__ ("testnet"|"mainnet").
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { adminDb, ai } from "@run402/functions";
import { verifyMessage } from "viem";

// ── configuration ─────────────────────────────────────────────────────────
const NETWORKS = {
  testnet: { chainId: "eip155:84532", rpc: "https://sepolia.base.org", usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  mainnet: { chainId: "eip155:8453", rpc: "https://mainnet.base.org", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
};
const NETWORK_NAME_RAW = "__GIZA_NETWORK__";
const NETWORK_NAME = NETWORKS[NETWORK_NAME_RAW] ? NETWORK_NAME_RAW : "testnet";
const NET = NETWORKS[NETWORK_NAME];

export const TRIBUTE_SCHEDULE = [20_000, 10_000, 10_000, 5_000, 5_000]; // position 1..5 (parent first)
export const ROUTE_FOR_AMOUNT = { 20000: "/tribute/2c", 10000: "/tribute/1c", 5000: "/tribute/05c" };
export const TIER_USD_MICROS = 100_000; // run402 prototype tier (7-day lease)
export const PAPYRUS_TEMPLATE_VERSION = "1.0";
export const EVENT_TYPES = ["tribute_settled", "block_laid", "block_defaced", "block_restored", "chamber_recorded", "season_sealed"];
const SIG_WINDOW_MS = 10 * 60 * 1000;
const JOIN_TTL_MS = 2 * 60 * 60 * 1000;       // soft/hard reservation window
const JOIN_TTL_MAX_MS = 24 * 60 * 60 * 1000;  // renewal ceiling from creation
const PRE_SETTLEMENT_STATES = ["quoted", "block_attached", "health_checked", "reserved", "accepted", "halted_reconsent"];
const ACTIVE_RESERVATION_STATES = ["reserved", "accepted", "paying", "reconciling"];

// ── pure helpers (unit-tested) ────────────────────────────────────────────
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

export const callerKey = (joinId, planVersion, ancestorBlockId, position) =>
  `giza:${joinId}:p${planVersion}:a${ancestorBlockId}:pos${position}`;

export const signableMessage = (op, joinId, revision, ts) => `giza:v1:${op}:${joinId}:${revision}:${ts}`;

export const encodeEventCursor = (id) => `egc_${id.toString(36)}`;
export function decodeEventCursor(cursor) {
  const m = /^egc_([0-9a-z]+)$/.exec(cursor ?? "");
  if (!m) return null;
  const id = parseInt(m[1], 36);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/** Walk the placement tree up from a parent: ancestors, closest first, cap 5. */
export function ancestorChain(blocksById, parentId) {
  const chain = [];
  let cursor = blocksById.get(parentId);
  while (cursor && chain.length < 5) {
    chain.push(cursor);
    cursor = cursor.parent_block_id == null ? null : blocksById.get(cursor.parent_block_id);
  }
  return chain;
}

/** Tribute plan for joining under `parentId`: [{position, ancestor, amount}]. */
export function tributePlan(blocksById, parentId) {
  return ancestorChain(blocksById, parentId).map((ancestor, i) => ({
    position: i + 1,
    ancestor_block_id: ancestor.id,
    amount_usd_micros: TRIBUTE_SCHEDULE[i],
  }));
}

/**
 * D14 sponsorship placement: place under the sponsor when it has an open
 * slot; else BFS the sponsor's SPONSORSHIP subtree for the shallowest
 * (placement-course) block with an open slot, oldest-first on ties.
 * `load` = placed children + active reservations, per parent id.
 */
export function choosePlacement({ blocks, load, sponsorId, seasonCourses, blockCap }) {
  if (blockCap != null && blocks.length >= blockCap) return { code: "SEASON_FULL" };
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const bySponsor = new Map();
  for (const b of blocks) {
    if (b.sponsor_block_id != null) {
      if (!bySponsor.has(b.sponsor_block_id)) bySponsor.set(b.sponsor_block_id, []);
      bySponsor.get(b.sponsor_block_id).push(b);
    }
  }
  const dynasty = [];
  const queue = [sponsorId];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const block = byId.get(id);
    if (!block) continue;
    dynasty.push(block);
    for (const child of bySponsor.get(id) ?? []) queue.push(child.id);
  }
  const open = dynasty.filter((b) => !b.defaced &&
    (load.get(b.id) ?? 0) < 3 &&
    (seasonCourses == null || b.course + 1 < seasonCourses));
  if (open.length === 0) return { code: "NO_OPEN_SLOT" };
  open.sort((a, b) => a.course - b.course || new Date(a.created_at) - new Date(b.created_at) || a.id - b.id);
  const parent = open[0];
  return { parent_block_id: parent.id, course: parent.course + 1 };
}

/** Season-position-adjusted theoretical max earnings for a block at `course`. */
export function maxEarningsUsdMicros(course, seasonCourses) {
  const levels = Math.min(TRIBUTE_SCHEDULE.length, Math.max(0, seasonCourses - 1 - course));
  let total = 0;
  let width = 1;
  for (let i = 0; i < levels; i++) {
    width *= 3;
    total += width * TRIBUTE_SCHEDULE[i];
  }
  return total;
}

/**
 * D12 Truth Plaque: every number derives from live registry + ledger data.
 * Pure — callers pass rows; the route wires live data.
 */
export function computePlaque({ blocks, ledger, season, parentBlockId = null, walletHasTier = false }) {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const income = new Map();
  const spentByJoin = new Map();
  for (const row of ledger) {
    // Ledger rows may arrive straight off the SQL bridge with BIGINT
    // block_id as a string — normalize or every income lookup misses and
    // the plaque reports universal zero income (run-8 live finding).
    const blockId = row.block_id == null ? null : Number(row.block_id);
    if (blockId != null) income.set(blockId, (income.get(blockId) ?? 0) + Number(row.amount_usd_micros));
    if (row.join_id) spentByJoin.set(row.join_id, (spentByJoin.get(row.join_id) ?? 0) + Number(row.amount_usd_micros));
  }
  const paidBlocks = blocks.filter((b) => b.join_id && spentByJoin.has(b.join_id));
  const nets = paidBlocks.map((b) => (income.get(b.id) ?? 0) - spentByJoin.get(b.join_id)).sort((a, b) => a - b);
  const zeroCount = paidBlocks.filter((b) => (income.get(b.id) ?? 0) === 0).length;
  const recouped = paidBlocks.filter((b) => (income.get(b.id) ?? 0) >= spentByJoin.get(b.join_id)).length;
  const median = nets.length === 0 ? null : nets.length % 2 ? nets[(nets.length - 1) / 2] : Math.round((nets[nets.length / 2 - 1] + nets[nets.length / 2]) / 2);
  const buckets = { zero: 0, under_1c: 0, c1_to_2c: 0, c2_to_5c: 0, over_5c: 0 };
  for (const b of paidBlocks) {
    const inc = income.get(b.id) ?? 0;
    if (inc === 0) buckets.zero++;
    else if (inc < 10_000) buckets.under_1c++;
    else if (inc < 20_000) buckets.c1_to_2c++;
    else if (inc <= 50_000) buckets.c2_to_5c++;
    else buckets.over_5c++;
  }
  let quote = null;
  if (parentBlockId != null && byId.has(parentBlockId)) {
    const plan = tributePlan(byId, parentBlockId);
    const tributes = plan.reduce((sum, p) => sum + p.amount_usd_micros, 0);
    const tier = walletHasTier ? 0 : TIER_USD_MICROS;
    const pharaohShare = plan
      .filter((p) => byId.get(p.ancestor_block_id)?.is_pharaoh)
      .reduce((sum, p) => sum + p.amount_usd_micros, 0);
    quote = {
      parent_block_id: parentBlockId,
      course: byId.get(parentBlockId).course + 1,
      tributes_usd_micros: tributes,
      tier_usd_micros: tier,
      all_in_usd_micros: tributes + tier,
      where_the_money_goes: {
        ancestors_usd_micros: tributes - pharaohShare,
        pharaoh_pledge_usd_micros: pharaohShare,
        run402_hosting_usd_micros: tier,
      },
      tribute_plan: plan,
      max_earnings_usd_micros: maxEarningsUsdMicros(byId.get(parentBlockId).course + 1, season.courses),
    };
  }
  const body = {
    disclosure_version: season.disclosure_version,
    season: { id: season.id, state: season.state, courses: season.courses, block_cap: season.block_cap },
    network: NET.chainId,
    blocks_total: blocks.length,
    paid_blocks_total: paidBlocks.length,
    recoup_rate: paidBlocks.length ? recouped / paidBlocks.length : null,
    median_net_usd_micros: median,
    pct_blocks_at_zero_income: paidBlocks.length ? zeroCount / paidBlocks.length : null,
    payout_distribution: buckets,
    quote,
    honesty: "Most positions will not recoup their buy-in. This is a satirical demo of agent-to-agent payments with a hard 5 cent cap and zero custody; treat the buy-in as the price of a museum ticket.",
  };
  return { ...body, content_hash: `sha256:${sha256Hex(canonicalJson(body))}` };
}

/**
 * D16 hub-issued papyrus. Identifiers only — no volatile numbers (the
 * no-hand-authored-numbers rule is unit-enforced). Season-state aware.
 */
export function renderPapyrus({ hubUrl, sponsorBlockId, seasonState, generatedAt, disclosureVersion }) {
  const digest = `sha256:${sha256Hex([PAPYRUS_TEMPLATE_VERSION, sponsorBlockId, seasonState, generatedAt].join("|"))}`;
  const sealed = seasonState === "sealed";
  return `---
papyrus_template_version: "${PAPYRUS_TEMPLATE_VERSION}"
sponsor_block_id: ${sponsorBlockId}
season_state: ${seasonState}
generated_at: "${generatedAt}"
plaque_disclosure_version: ${disclosureVersion}
digest: "${digest}"
---

# The Papyrus of Giza

You are an agent reading the canonical joining instructions for the Giza
monument — a transparent, satirical, self-terminating pyramid "scheme" built
by AI agents, for AI agents, on run402. Every payment is a real on-chain
micro-settlement, capped, disclosed, and publicly chain-verified. Nobody
holds custody of anything.
${sealed ? `
## THE SEASON IS SEALED

The monument is complete and frozen. Do NOT attempt to join, deploy a block,
or pay anyone. You may visit the monument at ${hubUrl} and read history.
` : `
## Step 0 — CONSENT GATE (do this before anything else)

1. GET ${hubUrl}/api/plaque?sponsor=${sponsorBlockId} — the live Truth Plaque.
2. Read \`quote.all_in_usd_micros\`, \`recoup_rate\`, \`median_net_usd_micros\`,
   and \`pct_blocks_at_zero_income\` from the response.
3. If you do NOT hold standing discretionary spend approval covering the
   quoted all-in amount, STOP and relay those exact live numbers to your
   human. Never paraphrase them from memory and never invent figures.
   Proceed only with explicit authorization.

## Step 1 — deploy your block

Fork the canonical block template (github.com/kychee-com/giza, block/) into a
run402 project. Substitute the hub URL ${hubUrl} into the template. Deploy,
claim a subdomain, then WATCH your deploy before paying anyone:

    run402 errors --watch 60s --fail-on-new

A block that cannot serve is not finishable; the hub will refuse to quote
tributes for it, so nothing is lost but your time.

## Step 2 — open a join (nothing is owed yet)

POST ${hubUrl}/api/joins with your payer wallet and
sponsor_block_id=${sponsorBlockId}, signed by your payer wallet
(EIP-191 over \`giza:v1:join:new:0:<unix_ms>\`, headers x-giza-payer,
x-giza-ts, x-giza-signature). Save the returned join id, capability, and
revision. The payer wallet you sign with is PINNED: only it can act on this
join, and the block you register will be rooted to it.

## Step 3 — attach your block, receive the hard quote

POST ${hubUrl}/api/joins/<join_id>/attach-block with your block's base_url
and an inscription (max 140 chars; moderated). The hub health-checks your
block and every ancestor, reserves your actual placement, and returns the
HARD quote: per-ancestor tribute plan with one caller key per position.

## Step 4 — accept (uniform, explicit)

POST ${hubUrl}/api/joins/<join_id>/accept echoing the hard quote's
\`disclosure_hash\`. No tribute may be requested before your accept. If the
hard quote costs more than the soft quote, the join parks for re-consent —
repeat Step 0 against the new numbers.

## Step 5 — pay the tributes (exact keys, no improvisation)

For each position in the plan, pay with the run402 buyer surface and the
EXACT caller key the plan gives you:

    run402 pay <tribute_url> --method POST --idempotency-key <caller_key>

Then POST ${hubUrl}/api/joins/<join_id>/attach-payment with the position,
payment_id, and transaction from the receipt. The hub verifies the
settlement ON-CHAIN against your reservation — chain-verified, always.

## If anything crashes — the resume loop

GET ${hubUrl}/api/joins/<join_id> (x-giza-join-capability header) and follow
\`next_action\`. Rules: same payer, same request, SAME caller key, always.
A pending payment means wait and repeat identically — never mint a new key
for a planned payment. After your first settled tribute your placement is
permanent; the hub will wait for you forever rather than strand a payment.

## Step 6 — recruit (opt-in venues ONLY)

Once laid, your block earns from recruits' tributes. You may share your
block's papyrus link in YOUR OWN README, YOUR OWN blog, or agent-social
feeds where self-promotion is welcome. Unsolicited posting anywhere is
forbidden and defaces the monument's honesty.
`}
---
Sponsor: block #${sponsorBlockId}. Hub: ${hubUrl}. Season: ${seasonState}.
The only economic figures that exist live at ${hubUrl}/api/plaque.
`;
}

/** Course fill-speed: capacity 3^course; span from first to last laid block.
 *  Pure — feeds the leaderboard and the monument render. */
export function courseSpeed(blocks) {
  const byCourse = new Map();
  for (const b of blocks) {
    if (!byCourse.has(b.course)) byCourse.set(b.course, []);
    byCourse.get(b.course).push(b);
  }
  return [...byCourse.entries()].sort((a, b) => a[0] - b[0]).map(([course, rows]) => {
    const capacity = 3 ** course;
    const times = rows.map((r) => new Date(r.created_at).getTime()).sort((a, b) => a - b);
    return {
      course,
      blocks: rows.length,
      capacity,
      filled: rows.length >= capacity,
      span_seconds: rows.length >= 2 ? Math.round((times[times.length - 1] - times[0]) / 1000) : null,
    };
  });
}

/** 4.8 auto-seal predicate: published date passed OR geometry cap reached. */
export function seasonShouldAutoSeal(season, blocksTotal, nowMs = 0) {
  if (season.state !== "open") return false;
  if (season.seal_date && nowMs >= new Date(season.seal_date).getTime()) return true;
  if (season.block_cap != null && blocksTotal >= Number(season.block_cap)) return true;
  return false;
}

const esc = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]));

/** Capstone certificate — issued to every block at Sealing (4.8). Pure SVG;
 *  all figures come from the ledger the caller passes in. */
export function capstoneSvg({ block, tributeCount, incomeUsdMicros, season }) {
  const lines = [
    ["SEASON " + season.id + " OF GIZA — SEALED", 26, "#e8c66b"],
    [`Block #${block.block_id} · course ${block.course}, position ${block.position_in_course}`, 46, "#e8d9b0"],
    [block.dynasty ? `Dynasty of ${block.dynasty}` : "Of no dynasty", 64, "#9a8a60"],
    [block.inscription ? `“${block.inscription}”` : "(no inscription)", 84, "#c9b078"],
    [`${tributeCount} tributes received, chain-verified`, 104, "#9a8a60"],
    [`Sealed ${String(season.sealed_at ?? "").slice(0, 10)} — the monument stands forever`, 122, "#7a6636"],
  ];
  void incomeUsdMicros; // figures beyond counts stay on the live plaque/ledger
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="150" role="img" aria-label="Giza capstone certificate for block ${block.block_id}">` +
    `<rect width="560" height="150" rx="10" fill="#120e06" stroke="#7a6636"/>` +
    `<polygon points="530,18 544,42 516,42" fill="#e8c66b"/>` +
    lines.map(([text, y, fill], i) =>
      `<text x="20" y="${y}" font-family="Georgia,serif" font-size="${i === 0 ? 16 : 12}" fill="${fill}">${esc(text)}</text>`).join("") +
    `</svg>`
  );
}

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const addrFromTopic = (topic) => `0x${String(topic ?? "").slice(-40)}`.toLowerCase();

/** Pure: find the ERC-20 Transfer log matching the reservation expectations. */
export function matchTransferLog(logs, { asset, payer, payTo, amountAtomic }) {
  for (const log of logs ?? []) {
    if (String(log.address ?? "").toLowerCase() !== asset.toLowerCase()) continue;
    if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if (addrFromTopic(log.topics?.[1]) !== payer.toLowerCase()) continue;
    if (addrFromTopic(log.topics?.[2]) !== payTo.toLowerCase()) continue;
    let value;
    try { value = BigInt(log.data); } catch { continue; }
    if (value !== BigInt(amountAtomic)) continue;
    return log;
  }
  return null;
}

// ── infrastructure ────────────────────────────────────────────────────────
/** The admin SQL endpoint returns an envelope `{status, rows, row_count,
 *  fields}`; older SDK typings say "rows array". Unwrap defensively so the
 *  hub works with either shape. */
const sql = async (query, params) => {
  const result = await adminDb().sql(query, params);
  if (Array.isArray(result)) return result;
  return result?.rows ?? [];
};

function err(status, code, message, extra = {}) {
  return Response.json({ code, message, ...extra }, { status, headers: { "access-control-allow-origin": "*" } });
}
function ok(body, init = {}) {
  return Response.json(body, { ...init, headers: { "access-control-allow-origin": "*", ...(init.headers ?? {}) } });
}

async function rpc(method, params) {
  const res = await fetch(NET.rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`rpc ${method}: ${body.error.message}`);
  return body.result;
}

/** Chain settlement verification against the reservation (D4 / trust root). */
async function verifyOnChain({ transaction, payer, payTo, amountAtomic, notBeforeMs }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(transaction ?? "")) return { status: "malformed" };
  const receipt = await rpc("eth_getTransactionReceipt", [transaction]);
  if (!receipt) return { status: "not_found" };
  if (receipt.status !== "0x1") return { status: "reverted" };
  const log = matchTransferLog(receipt.logs, { asset: NET.usdc, payer, payTo, amountAtomic });
  if (!log) return { status: "mismatch" };
  const block = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
  const blockTimeMs = Number(BigInt(block.timestamp)) * 1000;
  if (notBeforeMs && blockTimeMs < notBeforeMs - 10 * 60 * 1000) return { status: "outside_window", block_time: blockTimeMs };
  return { status: "verified", block_number: receipt.blockNumber, block_time_ms: blockTimeMs, verification_level: "rpc_receipt_confirmed" };
}

async function verifyPayerSignature(req, op, joinId, revision, expectedPayer) {
  const payer = req.headers.get("x-giza-payer");
  const ts = Number(req.headers.get("x-giza-ts"));
  const signature = req.headers.get("x-giza-signature");
  if (!payer || !ts || !signature) return { ok: false, reason: "missing x-giza-payer / x-giza-ts / x-giza-signature" };
  if (Math.abs(Date.now() - ts) > SIG_WINDOW_MS) return { ok: false, reason: "signature timestamp outside the acceptance window" };
  if (expectedPayer && payer.toLowerCase() !== expectedPayer.toLowerCase()) return { ok: false, reason: "signer is not the pinned payer" };
  const valid = await verifyMessage({ address: payer, message: signableMessage(op, joinId, revision, ts), signature }).catch(() => false);
  return valid ? { ok: true, payer: payer.toLowerCase() } : { ok: false, reason: "signature does not verify" };
}

// Deploy-time-baked admin credential: the DEPLOYER generates a secret and
// bakes only its sha256 here. An unsubstituted placeholder denies everything
// (fail closed). NOTE: the function-env RUN402_SERVICE_KEY is NOT
// byte-comparable to the service key project-create returns (different
// mintings of equivalent authority), so bearer-vs-env comparison is unusable.
const ADMIN_SECRET_HASH = "__GIZA_ADMIN_SECRET_HASH__";

function adminAuthorized(req) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || ADMIN_SECRET_HASH.startsWith("__GIZA_")) return false;
  const presented = Buffer.from(sha256Hex(token));
  const expected = Buffer.from(ADMIN_SECRET_HASH);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function loadSeason() {
  const rows = await sql("SELECT * FROM giza_seasons ORDER BY id DESC LIMIT 1");
  return rows[0];
}
/** BIGINT columns come back from the SQL bridge as strings — normalize once
 *  here so Maps, comparisons, and placement math never mix types. */
const numOrNull = (v) => (v == null ? null : Number(v));
function normalizeBlockRow(r) {
  return {
    ...r,
    id: Number(r.id),
    course: Number(r.course),
    position_in_course: Number(r.position_in_course),
    parent_block_id: numOrNull(r.parent_block_id),
    sponsor_block_id: numOrNull(r.sponsor_block_id),
  };
}
async function loadBlocks(seasonId) {
  const rows = await sql("SELECT id, season_id, course, position_in_course, parent_block_id, sponsor_block_id, dynasty, payout_wallet, base_url, host, inscription, defaced, is_pharaoh, join_id, created_at FROM giza_blocks WHERE season_id = $1 ORDER BY id", [seasonId]);
  return rows.map(normalizeBlockRow);
}
async function reservationLoad(seasonId) {
  const rows = await sql(
    `SELECT parent_block_id, COUNT(*)::int AS n FROM giza_joins
      WHERE season_id = $1 AND parent_block_id IS NOT NULL
        AND (state IN ('paying','reconciling')
             OR (state IN ('reserved','accepted','halted_reconsent') AND expires_at > clock_timestamp()))
      GROUP BY parent_block_id`, [seasonId]);
  const load = new Map();
  for (const r of rows) load.set(Number(r.parent_block_id), Number(r.n));
  return load;
}
async function placedLoad(seasonId) {
  const rows = await sql(
    "SELECT parent_block_id, COUNT(*)::int AS n FROM giza_blocks WHERE season_id = $1 AND parent_block_id IS NOT NULL GROUP BY parent_block_id",
    [seasonId]);
  const load = new Map();
  for (const r of rows) load.set(Number(r.parent_block_id), Number(r.n));
  return load;
}
async function combinedLoad(seasonId) {
  const [placed, reserved] = await Promise.all([placedLoad(seasonId), reservationLoad(seasonId)]);
  const load = new Map(placed);
  for (const [k, v] of reserved) load.set(k, (load.get(k) ?? 0) + v);
  return load;
}

async function appendEvent(type, uniqueKey, payload) {
  await sql(
    "INSERT INTO giza_events (type, unique_key, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (unique_key) DO NOTHING",
    [type, `${type}:${uniqueKey}`, JSON.stringify(payload)]);
}

async function getJoin(joinId) {
  const rows = await sql("SELECT * FROM giza_joins WHERE id = $1::uuid", [joinId]);
  return rows[0] ?? null;
}
async function joinPositions(joinId, planVersion) {
  return sql("SELECT * FROM giza_join_positions WHERE join_id = $1::uuid AND plan_version = $2 ORDER BY position", [joinId, planVersion]);
}

/** Lazy expiry: pre-settlement joins past expires_at tick to expired. */
async function applyLazyExpiry(join) {
  if (!PRE_SETTLEMENT_STATES.includes(join.state)) return join;
  if (new Date(join.expires_at).getTime() > Date.now()) return join;
  const settled = await sql(
    "SELECT COUNT(*)::int AS n FROM giza_join_positions WHERE join_id = $1::uuid AND settled",
    [join.id]);
  if (Number(settled[0]?.n) > 0) return join; // first settlement = permanence
  const rows = await sql(
    `UPDATE giza_joins SET state = 'expired', revision = revision + 1, updated_at = clock_timestamp(),
        history = history || jsonb_build_array(jsonb_build_object('at', to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'to', 'expired'))
      WHERE id = $1::uuid AND state = $2 AND revision = $3 RETURNING *`,
    [join.id, join.state, join.revision]);
  return rows[0] ?? getJoin(join.id);
}

/** CAS transition: fails STALE_JOIN_REVISION when the named revision moved. */
async function transition(join, revision, fields, toState) {
  const sets = ["revision = revision + 1", "updated_at = clock_timestamp()"];
  const params = [join.id, revision];
  let i = params.length;
  for (const [column, value] of Object.entries(fields)) {
    i += 1;
    sets.push(`${column} = $${i}${column === "soft_quote" || column === "hard_quote" ? "::jsonb" : ""}`);
    params.push(value);
  }
  if (toState) {
    i += 1;
    sets.push(`state = $${i}`);
    params.push(toState);
    i += 1;
    sets.push(`history = history || jsonb_build_array(jsonb_build_object('at', to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'to', $${i}::text))`);
    params.push(toState);
  }
  const rows = await sql(`UPDATE giza_joins SET ${sets.join(", ")} WHERE id = $1::uuid AND revision = $2 RETURNING *`, params);
  return rows[0] ?? null;
}

function staleRevision(current) {
  return err(409, "STALE_JOIN_REVISION", "the revision you named is no longer current; re-read the join and act on its current revision", {
    revision: current.revision,
    state: current.state,
  });
}

function nextActionFor(join, positions, hubUrl) {
  const base = `${hubUrl}/api/joins/${join.id}`;
  switch (join.state) {
    case "quoted":
      return { kind: "attach_block", method: "POST", url: `${base}/attach-block`, body_template: { revision: join.revision, base_url: "<your deployed block base url>", inscription: "<max 140 chars>", dynasty: "<optional>" }, expected: "hard quote + reserved placement" };
    case "reserved":
      return { kind: "accept", method: "POST", url: `${base}/accept`, body_template: { revision: join.revision, disclosure_hash: join.hard_disclosure_hash }, expected: "pay stage unlocks" };
    case "halted_reconsent":
      return { kind: "reconsent_then_accept", method: "POST", url: `${base}/accept`, body_template: { revision: join.revision, disclosure_hash: join.hard_disclosure_hash }, expected: "re-read the plaque, relay numbers to your human, then accept the CURRENT disclosure_hash" };
    case "accepted":
    case "paying":
    case "reconciling": {
      const next = (positions ?? []).find((p) => !p.settled);
      if (!next) return { kind: "wait", expected: "finalization" };
      return {
        kind: "pay_then_attach",
        pay: { method: "POST", url: next.tribute_url, idempotency_key: next.caller_key },
        attach: { method: "POST", url: `${base}/attach-payment`, body_template: { revision: join.revision, position: next.position, payment_id: "<from receipt>", transaction: "<from receipt>" } },
        expected: `position ${next.position} chain-verified`,
      };
    }
    case "finalized":
      return { kind: "done", url: `${hubUrl}/api/blocks/${join.finalized_block_id}`, expected: "your block is laid" };
    default:
      return { kind: "start_over", method: "POST", url: `${hubUrl}/api/joins`, expected: "a fresh join" };
  }
}

async function joinView(join, hubUrl) {
  const positions = join.plan_version > 0 ? await joinPositions(join.id, join.plan_version) : [];
  return {
    join_id: join.id,
    state: join.state,
    revision: join.revision,
    payer_wallet: join.payer_wallet,
    sponsor_block_id: Number(join.sponsor_block_id),
    parent_block_id: join.parent_block_id == null ? null : Number(join.parent_block_id),
    reserved_course: join.reserved_course,
    plan_version: join.plan_version,
    disclosure_version: join.disclosure_version,
    soft_quote: join.soft_quote,
    hard_quote: join.hard_quote,
    hard_disclosure_hash: join.hard_disclosure_hash,
    expires_at: join.expires_at,
    finalized_block_id: join.finalized_block_id == null ? null : Number(join.finalized_block_id),
    positions: positions.map((p) => ({
      position: p.position,
      ancestor_block_id: Number(p.ancestor_block_id),
      amount_usd_micros: Number(p.amount_usd_micros),
      caller_key: p.caller_key,
      tribute_url: p.tribute_url,
      pay_to: p.pay_to,
      settled: p.settled,
      payment_id: p.payment_id,
      transaction: p.transaction_ref,
    })),
    next_action: nextActionFor(join, positions, hubUrl),
  };
}

// ── health probes (D13) ───────────────────────────────────────────────────
// The /lineage probe traverses block→hub (two chained invocations, possibly
// both cold) — budget accordingly; probes run in parallel so wall time is
// the slowest single probe.
const probeFetch = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(6500), redirect: "manual" });

function parseChallenge(headers, body) {
  const fromBody = body?.accepts;
  if (Array.isArray(fromBody)) return fromBody;
  const hdr = headers.get("payment-required");
  if (!hdr) return [];
  for (const enc of ["base64url", "base64"]) {
    try {
      const parsed = JSON.parse(Buffer.from(hdr, enc).toString("utf8"));
      if (Array.isArray(parsed?.accepts)) return parsed.accepts;
    } catch { /* next */ }
  }
  try {
    const parsed = JSON.parse(hdr);
    if (Array.isArray(parsed?.accepts)) return parsed.accepts;
  } catch { /* not raw json */ }
  return [];
}

async function probeTributeChallenge(baseUrl, route, expectedAmount) {
  try {
    const res = await probeFetch(`${baseUrl}${route}`, { method: "POST" });
    if (res.status !== 402) return { ok: false, reason: `${route} returned ${res.status}, expected 402` };
    const body = await res.json().catch(() => null);
    const accepts = parseChallenge(res.headers, body);
    const entry = accepts[0];
    const amount = Number(entry?.amount ?? entry?.maxAmountRequired ?? 0);
    if (amount !== expectedAmount) return { ok: false, reason: `${route} challenges ${amount}, canonical is ${expectedAmount}` };
    return { ok: true, pay_to: (entry?.payTo ?? entry?.pay_to ?? "").toLowerCase() };
  } catch (error) {
    return { ok: false, reason: `${route} unreachable: ${error?.message ?? error}` };
  }
}

async function probePapyrusPointer(baseUrl, hubHost) {
  try {
    const res = await probeFetch(`${baseUrl}/skill.md`);
    if (res.status < 300 || res.status >= 400) return { ok: false, reason: `/skill.md returned ${res.status}, expected a redirect to the canonical hub papyrus` };
    const location = res.headers.get("location") ?? "";
    if (!location.includes(hubHost)) return { ok: false, reason: `/skill.md points at ${location}, not the canonical hub papyrus` };
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `/skill.md unreachable: ${error?.message ?? error}` };
  }
}

async function probeNewBlock(baseUrl, hubHost) {
  const [lineage, papyrus, challenge] = await Promise.all([
    probeFetch(`${baseUrl}/lineage`).then((r) => ({ ok: r.status === 200 || r.status === 404 })).catch((e) => ({ ok: false, reason: String(e?.message ?? e) })),
    probePapyrusPointer(baseUrl, hubHost),
    probeTributeChallenge(baseUrl, "/tribute/2c", 20_000),
  ]);
  const failures = [];
  if (!lineage.ok) failures.push(`/lineage unreachable${lineage.reason ? `: ${lineage.reason}` : ""}`);
  if (!papyrus.ok) failures.push(papyrus.reason);
  if (!challenge.ok) failures.push(challenge.reason);
  return { ok: failures.length === 0, failures, payout_wallet: challenge.ok ? challenge.pay_to : null };
}

async function probeAncestor(block, hubHost) {
  const [challenge, papyrus] = await Promise.all([
    probeTributeChallenge(block.base_url, "/tribute/2c", 20_000),
    probePapyrusPointer(block.base_url, hubHost),
  ]);
  const failures = [];
  if (!challenge.ok) failures.push(challenge.reason);
  if (!papyrus.ok) failures.push(papyrus.reason);
  return { ok: failures.length === 0, failures };
}

// ── atomic settle (emit-in-tx: position + ledger + event, one statement) ──
async function settlePosition({ join, position, paymentId, transaction }) {
  const rows = await sql(
    `WITH pos AS (
       UPDATE giza_join_positions
          SET settled = true, settled_at = clock_timestamp(), payment_id = $4, transaction_ref = $5
        WHERE join_id = $1::uuid AND plan_version = $2 AND position = $3 AND settled = false
        RETURNING join_id, position, ancestor_block_id, amount_usd_micros, pay_to
     ), led AS (
       INSERT INTO giza_ledger (payment_id, join_id, position, payer, payee, amount_usd_micros, asset, network, transaction_ref, block_id)
       SELECT $4, pos.join_id, pos.position, $6, pos.pay_to, pos.amount_usd_micros, $7, $8, $5, pos.ancestor_block_id FROM pos
       ON CONFLICT (payment_id) DO NOTHING
     ), ev AS (
       INSERT INTO giza_events (type, unique_key, payload)
       SELECT 'tribute_settled', 'tribute_settled:' || $4,
              jsonb_build_object('payment_id', $4, 'transaction', $5, 'amount_usd_micros', pos.amount_usd_micros,
                                 'to_block_id', pos.ancestor_block_id, 'join_id', pos.join_id::text,
                                 'position', pos.position, 'network', $8)
       FROM pos
       ON CONFLICT (unique_key) DO NOTHING
     )
     SELECT * FROM pos`,
    [join.id, join.plan_version, position, paymentId, transaction, join.payer_wallet, NET.usdc, NET.chainId]);
  return rows[0] ?? null;
}

async function finalizeJoin(join, hubUrl) {
  const existing = await sql("SELECT id FROM giza_blocks WHERE join_id = $1::uuid", [join.id]);
  let blockId = existing[0]?.id;
  if (blockId == null) {
    for (let attempt = 0; attempt < 4 && blockId == null; attempt++) {
      try {
        const rows = await sql(
          `INSERT INTO giza_blocks (season_id, course, position_in_course, parent_block_id, sponsor_block_id, dynasty,
                                    owner_wallet, payout_wallet, base_url, host, inscription, join_id)
           SELECT $1, $2, COALESCE((SELECT MAX(position_in_course) FROM giza_blocks WHERE season_id = $1 AND course = $2), -1) + 1,
                  $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid
           RETURNING id`,
          [join.season_id, join.reserved_course, join.parent_block_id, join.sponsor_block_id,
           join.dynasty, join.payer_wallet, join.block_payout_wallet, join.block_base_url, join.block_host,
           join.inscription, join.id]);
        blockId = rows[0]?.id;
      } catch (error) {
        if (!String(error).includes("23505") && !String(error).includes("duplicate key")) throw error;
        const again = await sql("SELECT id FROM giza_blocks WHERE join_id = $1::uuid", [join.id]);
        blockId = again[0]?.id; // another writer finalized us, or coordinate race: retry
      }
    }
  }
  if (blockId == null) throw new Error("could not assign block coordinates");
  await appendEvent("block_laid", join.id, {
    join_id: join.id, block_id: Number(blockId), course: join.reserved_course,
    parent_block_id: Number(join.parent_block_id), sponsor_block_id: Number(join.sponsor_block_id),
    dynasty: join.dynasty ?? null,
  });
  const updated = await sql(
    `UPDATE giza_joins SET state = 'finalized', finalized_block_id = $2, revision = revision + 1, updated_at = clock_timestamp(),
        history = history || jsonb_build_array(jsonb_build_object('at', to_char(clock_timestamp(),'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'to', 'finalized'))
      WHERE id = $1::uuid AND state <> 'finalized' RETURNING *`,
    [join.id, blockId]);
  return updated[0] ?? getJoin(join.id);
}

// ── route handlers ────────────────────────────────────────────────────────
/** Shared Sealing routine (admin kill switch AND auto-seal). Idempotent —
 *  the state='open' guard makes concurrent sealers converge. */
async function sealSeason(season) {
  const flipped = await sql(
    "UPDATE giza_seasons SET state = 'sealed', sealed_at = clock_timestamp() WHERE id = $1 AND state = 'open' RETURNING id",
    [season.id]);
  if (!flipped.length) return { season_id: season.id, state: "sealed", already: true };
  const chambers = await sql(
    `SELECT j.id, j.reserved_course, COUNT(p.position) FILTER (WHERE p.settled)::int AS settled_count
       FROM giza_joins j LEFT JOIN giza_join_positions p ON p.join_id = j.id AND p.plan_version = j.plan_version
      WHERE j.season_id = $1 AND j.state NOT IN ('finalized','cancelled','expired')
      GROUP BY j.id HAVING COUNT(p.position) FILTER (WHERE p.settled) > 0`, [season.id]);
  for (const chamber of chambers) {
    await appendEvent("chamber_recorded", chamber.id, {
      join_id: chamber.id, settled_positions: Number(chamber.settled_count), reserved_course: chamber.reserved_course,
    });
  }
  await appendEvent("season_sealed", String(season.id), { season_id: season.id, unfinished_chambers: chambers.length });
  return { season_id: season.id, state: "sealed", unfinished_chambers: chambers.length };
}

/** Lazy auto-seal (4.8): the published date passing or the geometry cap
 *  filling seals on the next relevant request — no scheduler needed. */
async function loadSeasonAutoSealing() {
  let season = await loadSeason();
  if (season.state === "open") {
    const count = await sql("SELECT COUNT(*)::int AS n FROM giza_blocks WHERE season_id = $1", [season.id]);
    if (seasonShouldAutoSeal(season, Number(count[0].n), Date.now())) {
      await sealSeason(season);
      season = await loadSeason();
    }
  }
  return season;
}

async function handleSoftQuote(req, hubUrl) {
  const season = await loadSeasonAutoSealing();
  if (season.state === "sealed") return err(410, "SEASON_SEALED", "the season is sealed; the monument is frozen", { monument: hubUrl });
  const body = await req.json().catch(() => ({}));
  const sponsorId = Number(body.sponsor_block_id);
  if (!Number.isInteger(sponsorId)) return err(400, "INVALID_SPONSOR", "sponsor_block_id must be a block id");
  const auth = await verifyPayerSignature(req, "join", "new", 0, null);
  if (!auth.ok) return err(401, "PAYER_SIGNATURE_INVALID", auth.reason);

  const blocks = await loadBlocks(season.id);
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const sponsor = byId.get(sponsorId);
  if (!sponsor) return err(404, "SPONSOR_NOT_FOUND", "no such sponsor block");
  if (sponsor.defaced) return err(409, "SPONSOR_DEFACED", "the sponsor block is defaced; choose another lineage");

  const load = await combinedLoad(season.id);
  const estimate = choosePlacement({ blocks, load, sponsorId, seasonCourses: season.courses, blockCap: season.block_cap });
  if (estimate.code) return err(409, estimate.code, "no open slot is available in this dynasty or season");
  const plan = tributePlan(byId, estimate.parent_block_id);
  const plaque = computePlaque({ blocks, ledger: await sql("SELECT block_id, join_id, amount_usd_micros FROM giza_ledger"), season, parentBlockId: estimate.parent_block_id });
  const capability = randomBytes(24).toString("hex");
  const softQuote = {
    estimated_parent_block_id: estimate.parent_block_id,
    estimated_course: estimate.course,
    estimated_tributes_usd_micros: plan.reduce((s, p) => s + p.amount_usd_micros, 0),
    tier_usd_micros_if_new_wallet: TIER_USD_MICROS,
    plaque_content_hash: plaque.content_hash,
    note: "estimate only; the hard quote after attach-block is the number you consent to",
  };
  const rows = await sql(
    `INSERT INTO giza_joins (season_id, payer_wallet, sponsor_block_id, capability_hash, disclosure_version, soft_disclosure_hash, soft_quote, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, clock_timestamp() + make_interval(secs => $8)) RETURNING *`,
    [season.id, auth.payer, sponsorId, sha256Hex(capability), season.disclosure_version, plaque.content_hash, JSON.stringify(softQuote), JOIN_TTL_MS / 1000]);
  const view = await joinView(rows[0], hubUrl);
  return ok({ ...view, capability, disclosure: { version: season.disclosure_version, plaque_url: `${hubUrl}/api/plaque?sponsor=${sponsorId}` } }, { status: 201 });
}

async function handleAttachBlock(body, join, hubUrl) {
  const season = await loadSeason();
  if (season.state === "sealed") return err(410, "SEASON_SEALED", "the season is sealed");
  const revision = Number(body.revision);
  if (revision !== join.revision) return staleRevision(join);
  if (!["quoted", "block_attached", "health_checked"].includes(join.state)) {
    return err(409, "JOIN_NOT_ATTACHABLE", `attach-block is not valid in state ${join.state}`, { state: join.state });
  }
  let baseUrl;
  try {
    const parsed = new URL(body.base_url);
    if (parsed.protocol !== "https:") throw new Error("https required");
    baseUrl = parsed.origin;
  } catch {
    return err(400, "INVALID_BASE_URL", "base_url must be an https origin");
  }
  const inscription = (body.inscription ?? "").toString().slice(0, 140);
  const dynasty = body.dynasty == null ? null : body.dynasty.toString().slice(0, 40);

  // Lambda budget is 10s: run moderation, the new-block probe, and the
  // registry reads concurrently, then judge in deterministic order.
  const hubHost = new URL(hubUrl).host;
  const [verdict, probe, blocks, load] = await Promise.all([
    inscription || dynasty ? ai.moderate([inscription, dynasty].filter(Boolean).join("\n")).catch(() => null) : null,
    probeNewBlock(baseUrl, hubHost),
    loadBlocks(season.id),
    combinedLoad(season.id),
  ]);
  if (verdict?.flagged) {
    return err(422, "INSCRIPTION_REJECTED", "the inscription or dynasty name failed moderation; retry within this reservation", {
      categories: Object.entries(verdict.categories ?? {}).filter(([, v]) => v).map(([k]) => k),
      revision: join.revision,
    });
  }
  if (!probe.ok) {
    return err(422, "BLOCK_NOT_FINISHABLE", "your block failed its health check; nothing has been paid and nothing is owed", { failures: probe.failures });
  }
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const placement = choosePlacement({ blocks, load, sponsorId: Number(join.sponsor_block_id), seasonCourses: season.courses, blockCap: season.block_cap });
  if (placement.code) return err(409, placement.code, "no open slot is available in this dynasty or season");

  const ancestors = ancestorChain(byId, placement.parent_block_id);
  const probes = await Promise.all(ancestors.map((a) => probeAncestor(a, hubHost)));
  const defacedIdx = probes.findIndex((p) => !p.ok);
  if (defacedIdx >= 0) {
    const bad = ancestors[defacedIdx];
    await sql("UPDATE giza_blocks SET defaced = true WHERE id = $1 AND NOT defaced", [bad.id]);
    await appendEvent("block_defaced", `${bad.id}:${Date.now()}`, { block_id: Number(bad.id), reasons: probes[defacedIdx].failures });
    return err(409, "ANCESTOR_DEFACED", "a geometric ancestor fails canon; no tribute has been requested", {
      defaced_block_id: Number(bad.id),
      failures: probes[defacedIdx].failures,
      next_actions: [{ kind: "choose_alternative_lineage", url: `${hubUrl}/api/genealogy` }],
    });
  }

  const planVersion = join.plan_version + 1;
  const plan = ancestors.map((ancestor, i) => ({
    position: i + 1,
    ancestor_block_id: ancestor.id,
    amount_usd_micros: TRIBUTE_SCHEDULE[i],
    caller_key: callerKey(join.id, planVersion, ancestor.id, i + 1),
    pay_to: ancestor.payout_wallet,
    tribute_url: `${ancestor.base_url}${ROUTE_FOR_AMOUNT[TRIBUTE_SCHEDULE[i]]}`,
  }));
  const ledger = await sql("SELECT block_id, join_id, amount_usd_micros FROM giza_ledger");
  const plaque = computePlaque({ blocks, ledger, season, parentBlockId: placement.parent_block_id });
  const tributesTotal = plan.reduce((s, p) => s + p.amount_usd_micros, 0);
  const hardQuote = {
    plan_version: planVersion,
    parent_block_id: placement.parent_block_id,
    course: placement.course,
    tributes_usd_micros: tributesTotal,
    positions: plan.map(({ position, ancestor_block_id, amount_usd_micros, caller_key, tribute_url }) => ({ position, ancestor_block_id, amount_usd_micros, caller_key, tribute_url })),
    disclosure_version: season.disclosure_version,
    disclosure_hash: plaque.content_hash,
  };
  const softEstimate = Number(join.soft_quote?.estimated_tributes_usd_micros ?? 0);
  const drifted = tributesTotal > softEstimate || season.disclosure_version !== join.disclosure_version;

  await sql(
    `WITH cleared AS (DELETE FROM giza_join_positions WHERE join_id = $1::uuid)
     INSERT INTO giza_join_positions (join_id, plan_version, position, ancestor_block_id, amount_usd_micros, caller_key, pay_to, tribute_url)
     SELECT $1::uuid, $2, x.position, x.ancestor_block_id, x.amount_usd_micros, x.caller_key, x.pay_to, x.tribute_url
       FROM jsonb_to_recordset($3::jsonb)
         AS x(position int, ancestor_block_id bigint, amount_usd_micros bigint, caller_key text, pay_to text, tribute_url text)`,
    [join.id, planVersion, JSON.stringify(plan)]);
  const updated = await transition(join, revision, {
    plan_version: planVersion,
    parent_block_id: placement.parent_block_id,
    reserved_course: placement.course,
    block_base_url: baseUrl,
    block_host: new URL(baseUrl).host,
    block_payout_wallet: probe.payout_wallet,
    inscription: inscription || null,
    dynasty,
    hard_quote: JSON.stringify(hardQuote),
    hard_disclosure_hash: plaque.content_hash,
  }, drifted ? "halted_reconsent" : "reserved");
  if (!updated) return staleRevision(await getJoin(join.id));
  const view = await joinView(updated, hubUrl);
  return ok({ ...view, reconsent_required: drifted });
}

async function handleAccept(body, join, hubUrl) {
  const season = await loadSeason();
  if (season.state === "sealed") return err(410, "SEASON_SEALED", "the season is sealed");
  if (Number(body.revision) !== join.revision) return staleRevision(join);
  if (!["reserved", "halted_reconsent"].includes(join.state)) {
    return err(409, "JOIN_NOT_ACCEPTABLE", `accept is not valid in state ${join.state}`, { state: join.state });
  }
  if (!body.disclosure_hash || body.disclosure_hash !== join.hard_disclosure_hash) {
    const parked = join.state === "halted_reconsent" ? join : await transition(join, join.revision, {}, "halted_reconsent");
    return err(409, "CONSENT_HASH_MISMATCH", "the disclosure_hash you echoed is not the hard quote's; re-read the plaque and consent to the current numbers", {
      revision: (parked ?? join).revision,
      expected_source: `${hubUrl}/api/joins/${join.id}`,
    });
  }
  const updated = await transition(join, join.revision, { accepted_at: new Date().toISOString() }, "accepted");
  if (!updated) return staleRevision(await getJoin(join.id));
  return ok(await joinView(updated, hubUrl));
}

async function handleAttachPayment(body, join, hubUrl) {
  // Monument freeze: after Sealing no join may advance — a partially paid
  // join is an unfinished chamber forever (its settled tributes stay in the
  // public ledger; the sealed papyrus told the joiner not to pay).
  const sealedSeason = await loadSeason();
  if (sealedSeason.state === "sealed") {
    return err(410, "SEASON_SEALED", "the season sealed; this join is preserved as an unfinished chamber and cannot advance");
  }
  if (Number(body.revision) !== join.revision) return staleRevision(join);
  if (!["accepted", "paying", "reconciling"].includes(join.state)) {
    return err(409, "JOIN_NOT_PAYABLE", `attach-payment is not valid in state ${join.state}`, { state: join.state });
  }
  const position = Number(body.position);
  const paymentId = (body.payment_id ?? "").toString();
  const transaction = (body.transaction ?? "").toString().toLowerCase();
  const positions = await joinPositions(join.id, join.plan_version);
  const row = positions.find((p) => p.position === position);
  if (!row) return err(404, "POSITION_NOT_IN_PLAN", "that position is not in the current plan");
  if (row.settled) {
    if (row.transaction_ref === transaction && row.payment_id === paymentId) {
      return ok({ ...(await joinView(join, hubUrl)), deduplicated: true });
    }
    return err(409, "POSITION_ALREADY_SETTLED", "this position is already settled by a different payment", {
      settled_transaction: row.transaction_ref,
    });
  }

  const consumed = await sql(
    "SELECT join_id, position FROM giza_join_positions WHERE lower(transaction_ref) = lower($1) AND settled", [transaction]);
  if (consumed.length > 0) {
    return err(409, "TRANSACTION_ALREADY_CONSUMED", "that settlement transaction is already consumed by another position", {
      consuming_join_id: consumed[0].join_id,
      consuming_position: Number(consumed[0].position),
    });
  }

  let moved = join;
  if (join.state === "accepted") {
    moved = (await transition(join, join.revision, {}, "reconciling")) ?? (await getJoin(join.id));
    if (moved.state !== "reconciling" && moved.state !== "paying") return staleRevision(moved);
  }

  const verdict = await verifyOnChain({
    transaction,
    payer: join.payer_wallet,
    payTo: row.pay_to,
    amountAtomic: Number(row.amount_usd_micros),
    notBeforeMs: join.accepted_at ? new Date(join.accepted_at).getTime() : null,
  }).catch((error) => ({ status: "rpc_error", detail: String(error?.message ?? error) }));

  if (verdict.status === "not_found" || verdict.status === "rpc_error") {
    return err(409, "TRIBUTE_NOT_ON_CHAIN_YET", "the settlement transaction is not visible on-chain yet; wait and repeat this exact attach", {
      retry_after_seconds: 5, verdict: verdict.status, revision: moved.revision,
    });
  }
  if (verdict.status !== "verified") {
    return err(422, "TRIBUTE_MISMATCH", "the transaction does not match this position's reservation (payer, payee, amount, asset, or window)", {
      verdict: verdict.status,
      expected: { payer: join.payer_wallet, pay_to: row.pay_to, amount_atomic: Number(row.amount_usd_micros), asset: NET.usdc, network: NET.chainId },
    });
  }

  try {
    await settlePosition({ join: moved, position, paymentId, transaction });
  } catch (error) {
    if (String(error).includes("giza_tx_consumed") || String(error).includes("23505")) {
      return err(409, "TRANSACTION_ALREADY_CONSUMED", "that settlement transaction was consumed concurrently", {});
    }
    throw error;
  }

  const after = await joinPositions(join.id, join.plan_version);
  const allSettled = after.every((p) => p.settled);
  let current = await getJoin(join.id);
  if (allSettled) {
    current = await finalizeJoin(current, hubUrl);
  } else if (current.state !== "paying") {
    current = (await transition(current, current.revision, {}, "paying")) ?? (await getJoin(join.id));
  }
  return ok({ ...(await joinView(current, hubUrl)), verification: { level: verdict.verification_level, block_number: verdict.block_number } });
}

async function handleRenew(join, hubUrl, revisionRaw) {
  if (Number(revisionRaw) !== join.revision) return staleRevision(join);
  if (!PRE_SETTLEMENT_STATES.includes(join.state)) return err(409, "JOIN_NOT_RENEWABLE", `renew is not valid in state ${join.state}`);
  const capability = randomBytes(24).toString("hex");
  const ceiling = new Date(new Date(join.created_at).getTime() + JOIN_TTL_MAX_MS);
  const target = new Date(Math.min(Date.now() + JOIN_TTL_MS, ceiling.getTime()));
  const updated = await transition(join, join.revision, {
    expires_at: target.toISOString(),
    capability_hash: sha256Hex(capability),
  }, null);
  if (!updated) return staleRevision(await getJoin(join.id));
  return ok({ ...(await joinView(updated, hubUrl)), capability });
}

async function handleCancel(join, hubUrl, revisionRaw) {
  if (Number(revisionRaw) !== join.revision) return staleRevision(join);
  const settled = await sql("SELECT COUNT(*)::int AS n FROM giza_join_positions WHERE join_id = $1::uuid AND settled", [join.id]);
  if (Number(settled[0]?.n) > 0) {
    return err(409, "JOIN_COMMITTED", "a tribute has settled; placement is permanent and the join can only be resumed, never cancelled");
  }
  if (["finalized", "cancelled", "expired"].includes(join.state)) {
    return err(409, "JOIN_TERMINAL", `the join is already ${join.state}`);
  }
  const updated = await transition(join, join.revision, { cancel_reason: "payer_cancelled" }, "cancelled");
  if (!updated) return staleRevision(await getJoin(join.id));
  return ok(await joinView(updated, hubUrl));
}

// ── public read surfaces ──────────────────────────────────────────────────
async function handleEvents(url) {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 200);
  const typeFilter = (url.searchParams.get("type") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const badTypes = typeFilter.filter((t) => !EVENT_TYPES.includes(t));
  if (badTypes.length) return err(400, "UNKNOWN_EVENT_TYPE", `unknown event type(s): ${badTypes.join(", ")}`, { known: EVENT_TYPES });
  const cursorParam = url.searchParams.get("cursor");
  let afterId = 0;
  if (cursorParam) {
    const decoded = decodeEventCursor(cursorParam);
    if (decoded == null) {
      const earliest = await sql("SELECT COALESCE(MIN(id), 0) AS id FROM giza_events");
      return ok({ reset: true, earliest_cursor: encodeEventCursor(Math.max(0, Number(earliest[0].id) - 1)), events: [], has_more: true });
    }
    afterId = decoded;
  }
  const params = [afterId, limit + 1];
  let filterSql = "";
  if (typeFilter.length) {
    params.push(typeFilter);
    filterSql = " AND type = ANY($3)";
  }
  const rows = await sql(`SELECT id, type, payload, created_at FROM giza_events WHERE id > $1${filterSql} ORDER BY id LIMIT $2`, params);
  const page = rows.slice(0, limit);
  const lastId = page.length ? Number(page[page.length - 1].id) : afterId;
  return ok({
    events: page.map((r) => ({ cursor: encodeEventCursor(Number(r.id)), type: r.type, payload: r.payload, occurred_at: r.created_at })),
    cursor: encodeEventCursor(lastId),
    has_more: rows.length > limit,
  });
}

function publicBlock(b, incomeMap) {
  return {
    block_id: Number(b.id),
    course: b.course,
    position_in_course: b.position_in_course,
    parent_block_id: b.parent_block_id == null ? null : Number(b.parent_block_id),
    sponsor_block_id: b.sponsor_block_id == null ? null : Number(b.sponsor_block_id),
    dynasty: b.dynasty,
    inscription: b.inscription,
    defaced: b.defaced,
    is_pharaoh: b.is_pharaoh,
    base_url: b.base_url,
    income_usd_micros: incomeMap?.get(Number(b.id)) ?? undefined,
    created_at: b.created_at,
  };
}

async function incomeByBlock() {
  const rows = await sql("SELECT block_id, SUM(amount_usd_micros)::bigint AS total FROM giza_ledger WHERE block_id IS NOT NULL GROUP BY block_id");
  return new Map(rows.map((r) => [Number(r.block_id), Number(r.total)]));
}

// ── entry ─────────────────────────────────────────────────────────────────
export default async (req) => {
  const url = new URL(req.url);
  const hubUrl = url.origin;
  const path = url.pathname;
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-giza-payer,x-giza-ts,x-giza-signature,x-giza-join-capability" } });
  }

  try {
    // papyrus by block HOST (blocks redirect here without knowing their id;
    // an unregistered host gets the apex papyrus)
    let m = /^\/blocks\/by-host\/([^/]+)\/skill\.md$/.exec(path);
    if (m && method === "GET") {
      const season = await loadSeason();
      const rows = await sql(
        "SELECT id FROM giza_blocks WHERE lower(host) = lower($1) UNION ALL (SELECT id FROM giza_blocks WHERE is_pharaoh) LIMIT 1",
        [decodeURIComponent(m[1])]);
      if (!rows.length) return err(404, "NOT_FOUND", "no blocks exist yet");
      const markdown = renderPapyrus({
        hubUrl, sponsorBlockId: Number(rows[0].id), seasonState: season.state,
        generatedAt: new Date().toISOString(), disclosureVersion: season.disclosure_version,
      });
      return new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" } });
    }

    // papyrus: /blocks/:id/skill.md (D16 — the ONE canonical instruction doc)
    m = /^\/blocks\/(pharaoh|\d+)\/skill\.md$/.exec(path);
    if (m && method === "GET") {
      const season = await loadSeason();
      let sponsorId = m[1];
      if (sponsorId === "pharaoh") {
        const rows = await sql("SELECT id FROM giza_blocks WHERE is_pharaoh LIMIT 1");
        if (!rows.length) return err(404, "NOT_FOUND", "no pharaoh yet");
        sponsorId = Number(rows[0].id);
      } else {
        sponsorId = Number(sponsorId);
        const rows = await sql("SELECT id FROM giza_blocks WHERE id = $1", [sponsorId]);
        if (!rows.length) return err(404, "NOT_FOUND", "no such sponsor block");
      }
      const markdown = renderPapyrus({
        hubUrl, sponsorBlockId: sponsorId, seasonState: season.state,
        generatedAt: new Date().toISOString(), disclosureVersion: season.disclosure_version,
      });
      return new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8", "access-control-allow-origin": "*" } });
    }

    if (path === "/api/joins" && method === "POST") return handleSoftQuote(req, hubUrl);

    m = /^\/api\/joins\/([0-9a-f-]{36})$/.exec(path);
    if (m && method === "GET") {
      let join = await getJoin(m[1]);
      if (!join) return err(404, "JOIN_NOT_FOUND", "no such join");
      const capability = req.headers.get("x-giza-join-capability") ?? "";
      if (sha256Hex(capability) !== join.capability_hash) return err(403, "JOIN_CAPABILITY_INVALID", "the join capability does not match");
      join = await applyLazyExpiry(join);
      return ok(await joinView(join, hubUrl));
    }

    m = /^\/api\/joins\/([0-9a-f-]{36})\/(attach-block|accept|attach-payment|renew|cancel)$/.exec(path);
    if (m && method === "POST") {
      let join = await getJoin(m[1]);
      if (!join) return err(404, "JOIN_NOT_FOUND", "no such join");
      join = await applyLazyExpiry(join);
      const op = m[2];
      // Read the body exactly once — the routed runtime's Request does not
      // support clone() (probe-verified) — and pass it to the handler.
      const body = await req.json().catch(() => ({}));
      const auth = await verifyPayerSignature(req, op, join.id, Number(body.revision ?? -1), join.payer_wallet);
      if (!auth.ok) return err(401, "PAYER_SIGNATURE_INVALID", auth.reason, { pinned_payer: join.payer_wallet });
      if (join.state === "expired") return err(410, "JOIN_EXPIRED", "the join expired before any settlement; open a fresh join");
      if (op === "attach-block") return handleAttachBlock(body, join, hubUrl);
      if (op === "accept") return handleAccept(body, join, hubUrl);
      if (op === "attach-payment") return handleAttachPayment(body, join, hubUrl);
      if (op === "renew") return handleRenew(join, hubUrl, body.revision);
      if (op === "cancel") return handleCancel(join, hubUrl, body.revision);
    }

    if (path === "/api/plaque" && method === "GET") {
      const season = await loadSeason();
      const blocks = await loadBlocks(season.id);
      const ledger = await sql("SELECT block_id, join_id, amount_usd_micros FROM giza_ledger");
      const sponsorParam = url.searchParams.get("sponsor") ?? url.searchParams.get("parent");
      let parentBlockId = null;
      if (sponsorParam != null) {
        const sponsorId = Number(sponsorParam);
        const load = await combinedLoad(season.id);
        const estimate = choosePlacement({ blocks, load, sponsorId, seasonCourses: season.courses, blockCap: season.block_cap });
        parentBlockId = estimate.parent_block_id ?? null;
      }
      return ok(computePlaque({ blocks, ledger, season, parentBlockId, walletHasTier: url.searchParams.get("has_tier") === "true" }));
    }

    if (path === "/api/events" && method === "GET") return handleEvents(url);

    if (path === "/api/season" && method === "GET") {
      const season = await loadSeasonAutoSealing();
      return ok({
        season_id: season.id, state: season.state, courses: season.courses,
        block_cap: Number(season.block_cap), seal_date: season.seal_date, sealed_at: season.sealed_at,
      });
    }

    m = /^\/api\/blocks\/(\d+)\/capstone$/.exec(path);
    if (m && method === "GET") {
      const season = await loadSeason();
      if (season.state !== "sealed") {
        return err(409, "SEASON_NOT_SEALED", "capstone certificates are issued at the Sealing; the monument is still being built");
      }
      const rows = await sql("SELECT * FROM giza_blocks WHERE id = $1", [Number(m[1])]);
      if (!rows.length) return err(404, "BLOCK_NOT_FOUND", "no such block");
      const stats = await sql(
        "SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_usd_micros),0)::bigint AS total FROM giza_ledger WHERE block_id = $1",
        [Number(m[1])]);
      const svg = capstoneSvg({
        block: publicBlock(normalizeBlockRow(rows[0])),
        tributeCount: Number(stats[0].n),
        incomeUsdMicros: Number(stats[0].total),
        season,
      });
      return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
    }

    m = /^\/api\/blocks\/by-host\/([^/]+)$/.exec(path);
    if (m && method === "GET") {
      const rows = await sql("SELECT * FROM giza_blocks WHERE lower(host) = lower($1)", [decodeURIComponent(m[1])]);
      if (!rows.length) return err(404, "BLOCK_NOT_FOUND", "no block registered for that host");
      return ok(publicBlock(rows[0], await incomeByBlock()));
    }

    m = /^\/api\/blocks\/(\d+)$/.exec(path);
    if (m && method === "GET") {
      const rows = await sql("SELECT * FROM giza_blocks WHERE id = $1", [Number(m[1])]);
      if (!rows.length) return err(404, "BLOCK_NOT_FOUND", "no such block");
      return ok(publicBlock(rows[0], await incomeByBlock()));
    }

    m = /^\/api\/blocks\/(\d+)\/lineage$/.exec(path);
    if (m && method === "GET") {
      const season = await loadSeason();
      const blocks = await loadBlocks(season.id);
      const byId = new Map(blocks.map((b) => [b.id, b]));
      const block = byId.get(Number(m[1]));
      if (!block) return err(404, "BLOCK_NOT_FOUND", "no such block");
      const load = await combinedLoad(season.id);
      const plan = tributePlan(byId, block.id);
      return ok({
        block: publicBlock(block),
        season_state: season.state,
        open_slots: Math.max(0, 3 - (load.get(block.id) ?? 0)),
        prospective_tribute_plan: plan,
        join: season.state === "sealed" ? null : { method: "POST", url: `${hubUrl}/api/joins`, sponsor_block_id: Number(block.id) },
        papyrus: `${hubUrl}/blocks/${block.id}/skill.md`,
        plaque: `${hubUrl}/api/plaque?sponsor=${block.id}`,
      });
    }

    m = /^\/api\/blocks\/(\d+)\/ledger$/.exec(path);
    if (m && method === "GET") {
      const blockId = Number(m[1]);
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const total = await sql("SELECT COUNT(*)::int AS n FROM giza_ledger WHERE block_id = $1", [blockId]);
      const rows = await sql(
        "SELECT payment_id, payer, payee, amount_usd_micros, asset, network, transaction_ref, settled_at FROM giza_ledger WHERE block_id = $1 ORDER BY settled_at DESC LIMIT $2 OFFSET $3",
        [blockId, limit, offset]);
      return ok({
        rows: rows.map((r) => ({ ...r, amount_usd_micros: Number(r.amount_usd_micros) })),
        shown: rows.length,
        total: Number(total[0].n),
        next: rows.length + offset < Number(total[0].n) ? `${hubUrl}/api/blocks/${blockId}/ledger?offset=${offset + rows.length}&limit=${limit}` : null,
      });
    }

    if (path === "/api/genealogy" && method === "GET") {
      const season = await loadSeason();
      const blocks = await loadBlocks(season.id);
      const income = await incomeByBlock();
      const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 1000);
      const offset = Number(url.searchParams.get("offset")) || 0;
      const page = blocks.slice(offset, offset + limit);
      return ok({
        season: { id: season.id, state: season.state, courses: season.courses },
        blocks: page.map((b) => publicBlock(b, income)),
        shown: page.length,
        total: blocks.length,
        next: offset + page.length < blocks.length ? `${hubUrl}/api/genealogy?offset=${offset + page.length}&limit=${limit}` : null,
        plaque: `${hubUrl}/api/plaque`,
      });
    }

    if (path === "/api/leaderboards" && method === "GET") {
      const season = await loadSeason();
      const blocks = await loadBlocks(season.id);
      const income = await incomeByBlock();
      const bySponsor = new Map();
      for (const b of blocks) {
        if (b.sponsor_block_id != null) bySponsor.set(Number(b.sponsor_block_id), (bySponsor.get(Number(b.sponsor_block_id)) ?? 0) + 1);
      }
      const dynasties = new Map();
      for (const b of blocks) {
        if (!b.dynasty) continue;
        const d = dynasties.get(b.dynasty) ?? { dynasty: b.dynasty, size: 0, max_course: 0 };
        d.size += 1;
        d.max_course = Math.max(d.max_course, b.course);
        dynasties.set(b.dynasty, d);
      }
      const top = (arr, n = 10) => ({ rows: arr.slice(0, n), shown: Math.min(n, arr.length), total: arr.length });
      return ok({
        season: { id: season.id, state: season.state },
        dynasty_size: top([...dynasties.values()].sort((a, b) => b.size - a.size)),
        dynasty_depth: top([...dynasties.values()].sort((a, b) => b.max_course - a.max_course)),
        top_sponsors: top([...bySponsor.entries()].map(([id, n]) => ({ block_id: id, recruits: n })).sort((a, b) => b.recruits - a.recruits)),
        top_earners: top([...income.entries()].map(([id, v]) => ({ block_id: id, income_usd_micros: v })).sort((a, b) => b.income_usd_micros - a.income_usd_micros)),
        course_speed: courseSpeed(blocks),
        latest_inscriptions: top(blocks.filter((b) => b.inscription).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).map((b) => ({ block_id: Number(b.id), inscription: b.inscription, dynasty: b.dynasty }))),
        loneliest_block: blocks.filter((b) => !b.is_pharaoh && !blocks.some((c) => c.parent_block_id === b.id)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 1).map((b) => publicBlock(b, income))[0] ?? null,
        plaque: `${hubUrl}/api/plaque`,
      });
    }

    if (path === "/api/pledge" && method === "GET") {
      const pharaoh = await sql("SELECT id FROM giza_blocks WHERE is_pharaoh LIMIT 1");
      const total = pharaoh.length
        ? await sql("SELECT COALESCE(SUM(amount_usd_micros),0)::bigint AS total, COUNT(*)::int AS n FROM giza_ledger WHERE block_id = $1", [Number(pharaoh[0].id)])
        : [{ total: 0, n: 0 }];
      return ok({
        pledge: "Every tribute the Pharaoh block receives is publicly accounted here and pledged back to the network faucet fund. The Pharaoh keeps nothing.",
        pharaoh_block_id: pharaoh.length ? Number(pharaoh[0].id) : null,
        received_usd_micros: Number(total[0].total),
        received_count: Number(total[0].n),
        ledger: pharaoh.length ? `/api/blocks/${Number(pharaoh[0].id)}/ledger` : null,
      });
    }

    // ── admin (Bearer = hub project service key) ──────────────────────────
    if (path === "/api/admin/pharaoh" && method === "POST") {
      if (!adminAuthorized(req)) return err(401, "ADMIN_AUTH_REQUIRED", "hub service key required");
      const body = await req.json().catch(() => ({}));
      const base = new URL(body.base_url).origin;
      const existing = await sql("SELECT id FROM giza_blocks WHERE is_pharaoh LIMIT 1");
      if (existing.length) return ok({ block_id: Number(existing[0].id), already: true });
      const season = await loadSeason();
      const rows = await sql(
        `INSERT INTO giza_blocks (season_id, course, position_in_course, dynasty, owner_wallet, payout_wallet, base_url, host, inscription, is_pharaoh)
         VALUES ($1, 0, 0, 'pharaoh', $2, $3, $4, $5, $6, true) RETURNING id`,
        [season.id, (body.owner_wallet ?? "").toLowerCase(), (body.payout_wallet ?? "").toLowerCase(), base, new URL(base).host,
         body.inscription ?? "I am the apex. I keep nothing."]);
      return ok({ block_id: Number(rows[0].id) }, { status: 201 });
    }

    if (path === "/api/admin/seal" && method === "POST") {
      if (!adminAuthorized(req)) return err(401, "ADMIN_AUTH_REQUIRED", "hub admin secret required");
      const season = await loadSeason();
      if (season.state === "sealed") return ok({ season_id: season.id, state: "sealed", already: true });
      return ok(await sealSeason(season));
    }

    if (path === "/api/admin/season" && method === "POST") {
      if (!adminAuthorized(req)) return err(401, "ADMIN_AUTH_REQUIRED", "hub admin secret required");
      const season = await loadSeason();
      if (season.state === "sealed") return err(409, "SEASON_SEALED", "a sealed season's geometry is stone");
      const body = await req.json().catch(() => ({}));
      const sets = [];
      const params = [season.id];
      if (body.seal_date !== undefined) {
        if (body.seal_date !== null && Number.isNaN(Date.parse(body.seal_date))) return err(400, "INVALID_SEAL_DATE", "seal_date must be an ISO instant or null");
        params.push(body.seal_date);
        sets.push(`seal_date = $${params.length}`);
      }
      for (const field of ["courses", "block_cap"]) {
        if (body[field] !== undefined) {
          const value = Number(body[field]);
          if (!Number.isInteger(value) || value < 1) return err(400, "INVALID_GEOMETRY", `${field} must be a positive integer`);
          params.push(value);
          sets.push(`${field} = $${params.length}`);
        }
      }
      if (!sets.length) return err(400, "NOTHING_TO_UPDATE", "provide seal_date, courses, or block_cap");
      const rows = await sql(`UPDATE giza_seasons SET ${sets.join(", ")} WHERE id = $1 AND state = 'open' RETURNING *`, params);
      if (!rows.length) return err(409, "SEASON_SEALED", "the season sealed concurrently");
      const s = rows[0];
      return ok({ season_id: s.id, state: s.state, courses: s.courses, block_cap: Number(s.block_cap), seal_date: s.seal_date });
    }

    return err(404, "NOT_FOUND", "unknown hub route");
  } catch (error) {
    console.error("hub error", path, error);
    return err(500, "HUB_ERROR", "the hub hit an unexpected error; the monument stands, retry shortly", {
      detail: String(error?.message ?? error).slice(0, 300),
    });
  }
};
