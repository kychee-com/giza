/**
 * Giza unit tests — pure logic only (placement, plaque math, caller keys,
 * papyrus rules, chain-log matching, cursors, receipts, badges).
 * Live behavior is covered by run402-private's test/giza-hub-e2e.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRIBUTE_SCHEDULE, canonicalJson, sha256Hex, callerKey, signableMessage,
  encodeEventCursor, decodeEventCursor, ancestorChain, tributePlan,
  choosePlacement, maxEarningsUsdMicros, computePlaque, renderPapyrus,
  matchTransferLog, PAPYRUS_TEMPLATE_VERSION,
  courseSpeed, seasonShouldAutoSeal, capstoneSvg,
} from "../hub/function.mjs";
import { buildReceipt, badgeSvg } from "../block/function.mjs";
import { buildBlockBundle, TRIBUTE_ROUTES, blockSiteHtml } from "../block/release.mjs";
import { buildHubBundle } from "../hub/release.mjs";
import { hubSiteHtml } from "../hub/site.mjs";

const mkBlock = (id, parent, sponsor, course, extra = {}) => ({
  id, parent_block_id: parent, sponsor_block_id: sponsor, course,
  created_at: new Date(2026, 0, id).toISOString(), defaced: false, is_pharaoh: id === 1,
  payout_wallet: `0xpay${id}`, base_url: `https://b${id}.example`, join_id: id === 1 ? null : `join-${id}`,
  ...extra,
});
const byId = (blocks) => new Map(blocks.map((b) => [b.id, b]));

// A 3-course fixture: pharaoh(1) ← 2,3,4 ; 2 ← 5,6 (sponsorships mirror placement
// except 6, which was SPONSORED by 5 but PLACED under 2).
const FIXTURE = [
  mkBlock(1, null, null, 0),
  mkBlock(2, 1, 1, 1), mkBlock(3, 1, 1, 1), mkBlock(4, 1, 1, 1),
  mkBlock(5, 2, 2, 2), mkBlock(6, 2, 5, 2),
];

test("tribute schedule is the canon: 2+1+1+0.5+0.5 = 5 cents", () => {
  assert.deepEqual(TRIBUTE_SCHEDULE, [20000, 10000, 10000, 5000, 5000]);
  assert.equal(TRIBUTE_SCHEDULE.reduce((a, b) => a + b, 0), 50000);
});

test("ancestor chain caps at 5 and orders closest-first", () => {
  const deep = [mkBlock(1, null, null, 0)];
  for (let i = 2; i <= 9; i++) deep.push(mkBlock(i, i - 1, i - 1, i - 1));
  const chain = ancestorChain(byId(deep), 9);
  assert.equal(chain.length, 5);
  assert.deepEqual(chain.map((b) => b.id), [9, 8, 7, 6, 5]);
  const plan = tributePlan(byId(deep), 9);
  assert.deepEqual(plan.map((p) => p.amount_usd_micros), TRIBUTE_SCHEDULE);
  assert.equal(plan[0].position, 1);
});

test("shallow join pays fewer tributes", () => {
  const plan = tributePlan(byId(FIXTURE), 1); // joining under the pharaoh
  assert.equal(plan.length, 1);
  assert.equal(plan[0].amount_usd_micros, 20000);
});

test("placement: sponsor with open slot wins", () => {
  const placement = choosePlacement({ blocks: FIXTURE, load: new Map([[1, 3], [2, 2]]), sponsorId: 2, seasonCourses: 9, blockCap: 500 });
  assert.deepEqual(placement, { parent_block_id: 2, course: 2 });
});

test("placement: full sponsor falls to shallowest dynasty slot, oldest-first tie-break", () => {
  // sponsor 2 full; its dynasty (sponsorship tree) = {2, 5, 6}; 5 and 6 both
  // course 2 with open slots → oldest (5) wins.
  const placement = choosePlacement({ blocks: FIXTURE, load: new Map([[2, 3]]), sponsorId: 2, seasonCourses: 9, blockCap: 500 });
  assert.deepEqual(placement, { parent_block_id: 5, course: 3 });
});

test("placement: reservations count against slots; NO_OPEN_SLOT only when dynasty is truly full", () => {
  const load = new Map([[2, 3], [5, 3], [6, 2]]);
  const p1 = choosePlacement({ blocks: FIXTURE, load, sponsorId: 2, seasonCourses: 9, blockCap: 500 });
  assert.deepEqual(p1, { parent_block_id: 6, course: 3 });
  load.set(6, 3);
  const p2 = choosePlacement({ blocks: FIXTURE, load, sponsorId: 2, seasonCourses: 9, blockCap: 500 });
  assert.equal(p2.code, "NO_OPEN_SLOT");
});

test("placement: course ceiling and block cap close the season", () => {
  const capped = choosePlacement({ blocks: FIXTURE, load: new Map(), sponsorId: 5, seasonCourses: 3, blockCap: 500 });
  assert.equal(capped.code, "NO_OPEN_SLOT"); // 5 sits at course 2; a child would be course 3 = beyond a 3-course season
  const full = choosePlacement({ blocks: FIXTURE, load: new Map(), sponsorId: 2, seasonCourses: 9, blockCap: 6 });
  assert.equal(full.code, "SEASON_FULL");
});

test("placement: defaced blocks never receive children", () => {
  const blocks = FIXTURE.map((b) => (b.id === 5 ? { ...b, defaced: true } : b));
  const placement = choosePlacement({ blocks, load: new Map([[2, 3]]), sponsorId: 2, seasonCourses: 9, blockCap: 500 });
  assert.deepEqual(placement, { parent_block_id: 6, course: 3 }); // skipped defaced 5 despite tie
});

test("max earnings: five full levels = $2.04 (the corrected external-review number)", () => {
  assert.equal(maxEarningsUsdMicros(0, 99), 2_040_000);
  assert.equal(maxEarningsUsdMicros(0, 2), 3 * 20000); // one level left
  assert.equal(maxEarningsUsdMicros(8, 9), 0);         // bottom course earns nothing
});

test("caller key derivation is deterministic over (join, plan, ancestor, position)", () => {
  const a = callerKey("j-1", 2, 77, 3);
  assert.equal(a, "giza:j-1:p2:a77:pos3");
  assert.equal(a, callerKey("j-1", 2, 77, 3));
  assert.notEqual(a, callerKey("j-1", 3, 77, 3));
});

test("signable message is versioned and op/revision-bound", () => {
  assert.equal(signableMessage("accept", "j", 4, 123), "giza:v1:accept:j:4:123");
});

test("event cursors round-trip and reject garbage", () => {
  assert.equal(decodeEventCursor(encodeEventCursor(12345)), 12345);
  assert.equal(decodeEventCursor("egc_0"), 0);
  assert.equal(decodeEventCursor("nope"), null);
  assert.equal(decodeEventCursor("egc_!!"), null);
});

test("canonical json sorts keys so hashes are stable", () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.equal(sha256Hex("x").length, 64);
});

test("plaque: quote itemizes, all-in includes tier for a fresh wallet, hash covers content", () => {
  const season = { id: 1, state: "open", courses: 9, block_cap: 500, disclosure_version: 1 };
  const ledger = [
    { block_id: 1, join_id: "join-2", amount_usd_micros: 20000 }, // block 2's buy-in went to pharaoh
    { block_id: 2, join_id: "join-5", amount_usd_micros: 20000 }, // 5 paid 2
    { block_id: 1, join_id: "join-5", amount_usd_micros: 10000 }, // and pharaoh
  ];
  const plaque = computePlaque({ blocks: FIXTURE, ledger, season, parentBlockId: 5 });
  assert.equal(plaque.quote.tributes_usd_micros, 20000 + 10000 + 10000); // 5→2→1 chain
  assert.equal(plaque.quote.all_in_usd_micros, plaque.quote.tributes_usd_micros + 100000);
  assert.equal(plaque.quote.where_the_money_goes.pharaoh_pledge_usd_micros, 10000);
  assert.equal(plaque.quote.where_the_money_goes.run402_hosting_usd_micros, 100000);
  assert.equal(plaque.quote.max_earnings_usd_micros, maxEarningsUsdMicros(3, 9));
  assert.match(plaque.content_hash, /^sha256:[0-9a-f]{64}$/);
  const again = computePlaque({ blocks: FIXTURE, ledger, season, parentBlockId: 5 });
  assert.equal(plaque.content_hash, again.content_hash);
  const drifted = computePlaque({ blocks: FIXTURE, ledger: ledger.slice(1), season, parentBlockId: 5 });
  assert.notEqual(plaque.content_hash, drifted.content_hash);
});

test("plaque: recoup / median / zero stats derive from the ledger", () => {
  const season = { id: 1, state: "open", courses: 9, block_cap: 500, disclosure_version: 1 };
  // block 2 spent 20000 (join-2), earned 30000 → recouped, net +10000
  // block 5 spent 30000 (join-5), earned 0 → at zero, net -30000
  const ledger = [
    { block_id: 1, join_id: "join-2", amount_usd_micros: 20000 },
    { block_id: 2, join_id: "join-5", amount_usd_micros: 20000 },
    { block_id: 1, join_id: "join-5", amount_usd_micros: 10000 },
    { block_id: 2, join_id: "join-6", amount_usd_micros: 10000 },
  ];
  const blocks = FIXTURE.filter((b) => [1, 2, 5].includes(b.id));
  const plaque = computePlaque({ blocks, ledger, season });
  assert.equal(plaque.paid_blocks_total, 2);
  assert.equal(plaque.recoup_rate, 0.5);
  assert.equal(plaque.pct_blocks_at_zero_income, 0.5);
  assert.equal(plaque.median_net_usd_micros, Math.round((10000 - 30000) / 2));
  assert.equal(plaque.payout_distribution.zero, 1);
  assert.equal(plaque.payout_distribution.c2_to_5c, 1);
});

test("papyrus: consent gate precedes the first tribute instruction (spec scenario)", () => {
  const md = renderPapyrus({ hubUrl: "https://giza.example", sponsorBlockId: 7, seasonState: "open", generatedAt: "2026-07-23T00:00:00Z", disclosureVersion: 1 });
  const consentAt = md.indexOf("CONSENT GATE");
  const plaqueAt = md.indexOf("/api/plaque");
  const firstPay = md.indexOf("run402 pay");
  assert.ok(consentAt > 0 && plaqueAt > 0 && firstPay > 0);
  assert.ok(consentAt < firstPay, "consent gate must precede payment instructions");
  assert.ok(plaqueAt < firstPay, "plaque fetch must precede payment instructions");
  assert.ok(md.includes(`papyrus_template_version: "${PAPYRUS_TEMPLATE_VERSION}"`));
  assert.match(md, /digest: "sha256:[0-9a-f]{64}"/);
  assert.ok(md.includes("opt-in venues ONLY") || md.includes("opt-in venues"), "recruitment names opt-in venues");
  assert.ok(md.includes("Unsolicited posting"), "unsolicited posting is explicitly forbidden");
});

test("papyrus: sealed season instructs no attempt", () => {
  const md = renderPapyrus({ hubUrl: "https://giza.example", sponsorBlockId: 7, seasonState: "sealed", generatedAt: "2026-07-23T00:00:00Z", disclosureVersion: 1 });
  assert.ok(md.includes("SEALED"));
  assert.ok(!md.includes("run402 pay"), "a sealed papyrus contains no payment instructions");
});

test("no-hand-authored-numbers: papyrus and both sites carry no literal money figures", () => {
  const sources = [
    renderPapyrus({ hubUrl: "https://h.example", sponsorBlockId: 1, seasonState: "open", generatedAt: "x", disclosureVersion: 1 }),
    hubSiteHtml(),
    blockSiteHtml("https://h.example"),
  ];
  // Forbid $-amounts and ¢-amounts in authored copy. Route ids like
  // /tribute/2c are identifiers, not figures, and don't match these shapes.
  const moneyPattern = /\$\d|[0-9]+(?:\.[0-9]+)? ?(?:¢|cents|USD)\b/;
  for (const src of sources) {
    const hit = src.match(moneyPattern);
    assert.equal(hit, null, `hand-authored money figure found: ${JSON.stringify(hit?.[0])}`);
  }
});

test("transfer-log matcher binds asset, payer, payee, and exact amount", () => {
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const pad = (addr) => "0x" + "0".repeat(24) + addr.slice(2);
  const log = {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    topics: [TRANSFER, pad("0x1111111111111111111111111111111111111111"), pad("0x2222222222222222222222222222222222222222")],
    data: "0x" + (10000).toString(16),
  };
  const expect = {
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    payer: "0x1111111111111111111111111111111111111111",
    payTo: "0x2222222222222222222222222222222222222222",
    amountAtomic: 10000,
  };
  assert.ok(matchTransferLog([log], expect));
  assert.equal(matchTransferLog([log], { ...expect, amountAtomic: 9999 }), null);
  assert.equal(matchTransferLog([log], { ...expect, payer: "0x3333333333333333333333333333333333333333" }), null);
  assert.equal(matchTransferLog([log], { ...expect, asset: "0x9999999999999999999999999999999999999999" }), null);
  assert.equal(matchTransferLog([{ ...log, topics: ["0xdead", ...log.topics.slice(1)] }], expect), null);
});

test("course speed: capacity is 3^course; span needs two blocks", () => {
  const blocks = [
    { course: 0, created_at: "2026-07-01T00:00:00Z" },
    { course: 1, created_at: "2026-07-01T00:00:00Z" },
    { course: 1, created_at: "2026-07-01T00:01:40Z" },
    { course: 1, created_at: "2026-07-01T00:00:50Z" },
  ];
  const speed = courseSpeed(blocks);
  assert.deepEqual(speed.map((c) => [c.course, c.blocks, c.capacity, c.filled]), [[0, 1, 1, true], [1, 3, 3, true]]);
  assert.equal(speed[0].span_seconds, null);
  assert.equal(speed[1].span_seconds, 100);
});

test("auto-seal: date passing or geometry cap seals; sealed seasons never re-seal", () => {
  const open = { state: "open", seal_date: "2026-08-01T00:00:00Z", block_cap: 10 };
  const before = Date.parse("2026-07-31T00:00:00Z");
  const after = Date.parse("2026-08-01T00:00:01Z");
  assert.equal(seasonShouldAutoSeal(open, 3, before), false);
  assert.equal(seasonShouldAutoSeal(open, 3, after), true);
  assert.equal(seasonShouldAutoSeal(open, 10, before), true);
  assert.equal(seasonShouldAutoSeal({ ...open, seal_date: null }, 9, before), false);
  assert.equal(seasonShouldAutoSeal({ ...open, state: "sealed" }, 99, after), false);
});

test("capstone certificate renders sealed-season facts and escapes inscriptions", () => {
  const svg = capstoneSvg({
    block: { block_id: 7, course: 3, position_in_course: 2, dynasty: "e2e", inscription: 'honest <b>&"cheap"</b>' },
    tributeCount: 4,
    incomeUsdMicros: 40000,
    season: { id: 1, sealed_at: "2026-08-01T12:00:00Z" },
  });
  assert.match(svg, /SEASON 1 OF GIZA — SEALED/);
  assert.match(svg, /Block #7 · course 3, position 2/);
  assert.match(svg, /4 tributes received, chain-verified/);
  assert.ok(svg.includes("&lt;b&gt;"), "markup in inscriptions is escaped");
  assert.ok(!svg.includes("<b>"), "no raw markup survives");
});

test("block receipt is an echo, never an attestation", () => {
  const receipt = buildReceipt({
    paymentId: "pay_1", amountUsdMicros: 10000, payer: "0xa", payTo: "0xb",
    network: "eip155:84532", asset: "0xusdc", transaction: "0xtx", settledAt: "2026-07-23T00:00:00Z",
  });
  assert.equal(receipt.paid, true);
  assert.equal(receipt.payment.payment_id, "pay_1");
  assert.match(receipt.note, /attests nothing/);
  assert.deepEqual(buildReceipt(null), { paid: false, payment: null });
});

test("badge renders with stats and degrades without", () => {
  assert.match(badgeSvg({ block_id: 7, course: 3, settled_tribute_count: 2 }), /block #7/);
  assert.match(badgeSvg(null), /stats unavailable/);
});

test("block bundle: canonical priced routes + substituted placeholders", () => {
  const bundle = buildBlockBundle({ hubUrl: "https://giza.example", ownerEmail: "o@example.com" });
  const priced = bundle.routes.replace.filter((r) => r.pricing);
  assert.equal(priced.length, 3);
  assert.deepEqual(
    priced.map((r) => [r.pattern, r.pricing.amount_usd_micros]).sort(),
    TRIBUTE_ROUTES.map((t) => [t.route, t.amount_usd_micros]).sort());
  for (const r of priced) assert.equal(r.pricing.pay_to, "org_default_payout");
  assert.ok(!bundle.functions[0].code.includes("__GIZA_HUB_URL__"));
  assert.ok(bundle.functions[0].code.includes("https://giza.example"));
  assert.ok(bundle.functions[0].code.includes("o@example.com"));
});

test("hub bundle: catch-all routes, viem dep, network + admin hash substituted", () => {
  const hash = "ab".repeat(32);
  const bundle = buildHubBundle({ network: "testnet", adminSecretHash: hash });
  assert.deepEqual(bundle.routes.replace.map((r) => r.pattern).sort(), ["/api/*", "/blocks/*"]);
  assert.ok(bundle.routes.replace.every((r) => !r.pricing), "hub routes are free — the hub never holds or receives funds");
  assert.deepEqual(bundle.functions[0].deps, ["viem"]);
  assert.ok(!bundle.functions[0].code.includes("__GIZA_NETWORK__"));
  assert.ok(bundle.functions[0].code.includes(hash), "admin secret hash is baked in");
  assert.ok(!bundle.functions[0].code.includes("__GIZA_ADMIN_SECRET_HASH__"));
});

test("hub bundle without an admin hash deploys fail-closed", () => {
  const bundle = buildHubBundle({ network: "testnet" });
  assert.ok(bundle.functions[0].code.includes("__GIZA_DISABLED__"), "admin routes deny everything when no hash was provided");
  const malformed = buildHubBundle({ network: "testnet", adminSecretHash: "not-a-hash" });
  assert.ok(malformed.functions[0].code.includes("__GIZA_DISABLED__"), "a malformed hash also fails closed");
});
