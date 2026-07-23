/**
 * Block template ReleaseSpec builder (task 3.1).
 *
 * Produces the legacy-bundle-shaped body consumed by the run402 /apply/v1
 * plan/commit helper: site file + one function + migration + the three
 * canonical priced tribute routes. Prices are THE canon — the hub's
 * health-check probes 402 challenges against these exact amounts.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const TRIBUTE_ROUTES = [
  { route: "/tribute/2c", amount_usd_micros: 20_000 },
  { route: "/tribute/1c", amount_usd_micros: 10_000 },
  { route: "/tribute/05c", amount_usd_micros: 5_000 },
];

export const BLOCK_MIGRATION = `
CREATE TABLE IF NOT EXISTS giza_tribute_receipts (
  payment_id TEXT PRIMARY KEY,
  amount_usd_micros BIGINT NOT NULL,
  payer TEXT,
  transaction_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
`;

export function blockSiteHtml(hubUrl) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>A Giza block</title>
<style>
  body{margin:0;font-family:Georgia,serif;background:#120e06;color:#e8d9b0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  main{max-width:38rem;padding:2rem;text-align:center}
  .cartouche{border:1px solid #7a6636;border-radius:10px;padding:1.5rem;background:#1a1408}
  h1{font-variant:small-caps;letter-spacing:.2em;color:#e8c66b}
  a{color:#e8c66b} .muted{color:#9a8a60;font-size:.9rem} code{color:#c9b078}
</style></head><body><main>
  <div class="cartouche">
    <h1>A block of Giza</h1>
    <p id="deed" class="muted">Consulting the hub&hellip;</p>
    <p><a id="papyrus" href="${hubUrl}">papyrus</a> &middot; <a href="${hubUrl}">the monument</a> &middot; <a href="${hubUrl}/api/plaque">truth plaque</a></p>
    <p class="muted">Every economic figure about this game comes from the hub's live Truth Plaque — this page states none.</p>
  </div>
</main>
<script>
  fetch("${hubUrl}/api/blocks/by-host/"+encodeURIComponent(location.host)).then(r=>r.ok?r.json():null).then(b=>{
    if(!b){document.getElementById("deed").textContent="This block is not yet registered on the hub.";return}
    document.getElementById("deed").innerHTML =
      "Block #"+b.block_id+" &middot; course "+b.course+" &middot; dynasty "+(b.dynasty||"—")+
      (b.inscription?("<br><em>\\u201C"+b.inscription+"\\u201D</em>"):"");
    document.getElementById("papyrus").href="${hubUrl}/blocks/"+b.block_id+"/skill.md";
  }).catch(()=>{document.getElementById("deed").textContent="The hub is unreachable."});
</script>
</body></html>`;
}

/**
 * Build the deployable bundle body pieces for one block.
 * @param {{hubUrl: string, ownerEmail?: string, networks?: string[]}} opts
 */
export function buildBlockBundle({ hubUrl, ownerEmail = "", networks = ["testnet"] }) {
  const code = readFileSync(join(here, "function.mjs"), "utf8")
    .replaceAll("__GIZA_HUB_URL__", hubUrl)
    .replaceAll("__GIZA_OWNER_EMAIL__", ownerEmail);
  const priced = TRIBUTE_ROUTES.map(({ route, amount_usd_micros }) => ({
    pattern: route,
    methods: ["POST"],
    target: { type: "function", name: "block" },
    pricing: { mode: "always", amount_usd_micros, pay_to: "org_default_payout", networks },
  }));
  return {
    files: [{ file: "index.html", data: blockSiteHtml(hubUrl) }],
    functions: [{ name: "block", code }],
    migrations: BLOCK_MIGRATION,
    routes: {
      replace: [
        { pattern: "/lineage", methods: ["GET"], target: { type: "function", name: "block" } },
        { pattern: "/skill.md", methods: ["GET"], target: { type: "function", name: "block" } },
        { pattern: "/badge.svg", methods: ["GET"], target: { type: "function", name: "block" } },
        ...priced,
      ],
    },
  };
}
