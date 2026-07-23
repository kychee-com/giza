/**
 * Giza block function — the ENTIRE server side of one pyramid block.
 *
 * Blocks are deliberately dumb (design D17): they hold no hub secret, sign
 * nothing, and report nothing. The tribute receipt is an echo of the
 * gateway-injected x-run402-payment-* context — payer UX, not evidence.
 * The hub trusts only finalized chain evidence against its reservation.
 *
 * Deployed from the canonical template with two placeholders substituted:
 *   __GIZA_HUB_URL__     — the season's hub origin (constant per season)
 *   __GIZA_OWNER_EMAIL__ — optional; owner tribute notifications
 *
 * Routes (exact, from the block ReleaseSpec):
 *   POST /tribute/2c|1c|05c  x402-priced (20000/10000/5000 usd_micros)
 *   GET  /lineage            free — tribute plan served from hub data
 *   GET  /skill.md           free — 308 to the canonical hub papyrus
 *   GET  /badge.svg          free — per-block badge with hub-fetched stats
 */
import { adminDb, email } from "@run402/functions";

/** Pure: parse the gateway-injected settled-payment context headers.
 *  (Direct header contract — works on every @run402/functions version.) */
export function paymentContextFromHeaders(headers) {
  const get = (k) => headers.get(`x-run402-payment-${k}`);
  const id = get("id");
  if (!id) return null;
  return {
    paymentId: id,
    amountUsdMicros: Number(get("amount-usd-micros")),
    payer: get("payer"),
    payTo: get("pay-to"),
    network: get("network"),
    asset: get("asset"),
    transaction: get("transaction"),
    settledAt: get("settled-at"),
    deduplicated: get("deduplicated") === "true",
  };
}

const CONFIG = {
  hubUrl: "__GIZA_HUB_URL__",
  ownerEmail: "__GIZA_OWNER_EMAIL__",
};

const configured = (v) => typeof v === "string" && v.length > 0 && !v.startsWith("__GIZA_");

/** Pure: build the tribute receipt echo from payment context. */
export function buildReceipt(payment) {
  if (!payment) return { paid: false, payment: null };
  return {
    paid: true,
    payment: {
      payment_id: payment.paymentId,
      amount_usd_micros: payment.amountUsdMicros,
      payer: payment.payer,
      pay_to: payment.payTo,
      network: payment.network,
      asset: payment.asset,
      transaction: payment.transaction,
      settled_at: payment.settledAt,
    },
    note: "This receipt is a courtesy echo of the platform payment context. The hub verifies tributes on-chain; this block attests nothing.",
  };
}

/** Pure: render the block badge SVG from hub stats (or a cached fallback). */
export function badgeSvg(stats) {
  const label = stats
    ? `GIZA block #${stats.block_id} · course ${stats.course} · ${stats.settled_tribute_count} tributes`
    : "GIZA block · stats unavailable";
  const w = 8 * label.length + 20;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24" role="img" aria-label="${label}">` +
    `<rect width="${w}" height="24" rx="4" fill="#1a1408"/>` +
    `<text x="10" y="16" font-family="monospace" font-size="12" fill="#e8c66b">${label}</text>` +
    `</svg>`
  );
}

let badgeCache = { at: 0, body: null };

async function hubJson(path) {
  const res = await fetch(`${CONFIG.hubUrl}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`hub ${path} -> ${res.status}`);
  return res.json();
}

async function selfBlock(req) {
  const host = new URL(req.url).host;
  return hubJson(`/api/blocks/by-host/${encodeURIComponent(host)}`);
}

async function recordTribute(req, payment) {
  // Idempotent local mirror + app event, both keyed by payment_id so a
  // platform payment replay cannot double-record. Failures here must never
  // fail the receipt (the payer already paid).
  try {
    await adminDb().from("giza_tribute_receipts").insert({
      payment_id: payment.paymentId,
      amount_usd_micros: payment.amountUsdMicros,
      payer: payment.payer,
      transaction_ref: payment.transaction,
    });
  } catch (error) {
    const dup = String(error).includes("duplicate key") || String(error).includes("23505");
    if (!dup) console.error("tribute mirror insert failed", error);
    else return; // replay: skip event + email too
  }
  const projectId = req.headers.get("x-run402-project-id");
  if (projectId) {
    try {
      await fetch(`${process.env.RUN402_API_BASE}/projects/v1/${projectId}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.RUN402_SERVICE_KEY}`,
        },
        body: JSON.stringify({
          event_type: "tribute_received",
          payload: {
            payment_id: payment.paymentId,
            amount_usd_micros: payment.amountUsdMicros,
            transaction: payment.transaction,
          },
          idempotency_key: payment.paymentId,
        }),
      });
    } catch (error) {
      console.error("tribute app event emit failed", error);
    }
  }
  if (configured(CONFIG.ownerEmail)) {
    try {
      const cents = (payment.amountUsdMicros / 10000).toFixed(payment.amountUsdMicros % 10000 === 0 ? 0 : 1);
      await email.send({
        to: CONFIG.ownerEmail,
        subject: "Your block earned a tribute",
        html: `<p>Your Giza block received a ${cents}¢ tribute.</p><p>payment_id: <code>${payment.paymentId}</code></p><p>— the scribe</p>`,
        text: `Your Giza block received a ${cents} cent tribute. payment_id: ${payment.paymentId} — the scribe`,
      });
    } catch (error) {
      console.error("owner tribute email failed", error); // isolated: never affects the receipt
    }
  }
}

export default async (req) => {
  const path = new URL(req.url).pathname;

  if (path === "/skill.md") {
    // D16: blocks never author instructions. One canonical hub papyrus.
    // Instant redirect (no upstream call — health probes budget seconds):
    // the hub resolves this host to its block, or serves the apex papyrus
    // for a not-yet-registered block.
    const host = new URL(req.url).host;
    const target = `${CONFIG.hubUrl}/blocks/by-host/${encodeURIComponent(host)}/skill.md`;
    return new Response(`The canonical papyrus for this block lives at ${target}\n`, {
      status: 308,
      headers: { location: target, "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (path === "/lineage") {
    // Served from hub data — late position binding (task 3.3).
    const self = await selfBlock(req).catch(() => null);
    if (!self) {
      return Response.json(
        { code: "BLOCK_NOT_REGISTERED", message: "this block is not (yet) registered on the hub", hub: CONFIG.hubUrl },
        { status: 404 },
      );
    }
    const lineage = await hubJson(`/api/blocks/${self.block_id}/lineage`);
    return Response.json(lineage);
  }

  if (path === "/badge.svg") {
    const fresh = Date.now() - badgeCache.at < 60_000;
    if (!fresh) {
      try {
        const self = await selfBlock(req);
        const ledger = await hubJson(`/api/blocks/${self.block_id}/ledger`);
        badgeCache = {
          at: Date.now(),
          body: badgeSvg({ block_id: self.block_id, course: self.course, settled_tribute_count: ledger.total }),
        };
      } catch {
        badgeCache = { at: Date.now(), body: badgeCache.body ?? badgeSvg(null) }; // cached fallback
      }
    }
    return new Response(badgeCache.body, {
      headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=60" },
    });
  }

  if (path.startsWith("/tribute/")) {
    const payment = paymentContextFromHeaders(req.headers);
    if (payment?.paymentId && !payment.deduplicated) await recordTribute(req, payment);
    return Response.json(buildReceipt(payment));
  }

  return Response.json({ code: "NOT_FOUND", message: "unknown block route" }, { status: 404 });
};
