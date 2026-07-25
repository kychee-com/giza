/**
 * Hub ReleaseSpec builder: site + one catch-all function behind /api/* and
 * /blocks/* (free routes — the hub sells nothing; tributes settle directly
 * joiner→ancestor and the hub never holds funds).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HUB_MIGRATIONS } from "./migrations.mjs";
import { hubSiteHtml } from "./site.mjs";
import { BLOCK_MIGRATION, blockSiteHtml } from "../block/release.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** @param {{network?: "testnet"|"mainnet", adminSecretHash?: string}} opts
 *  `adminSecretHash` = sha256 hex of the operator-held admin secret; omit to
 *  deploy with ALL admin routes disabled (fail closed). */
export function buildHubBundle({ network = "testnet", adminSecretHash = "" } = {}) {
  // The hub embeds the block template (base64 so the payload can't collide
  // with the hub's own placeholder substitutions) and serves it READY-MADE
  // at /api/block-template/* — joiners fetch one app.json and edit nothing.
  const blockFn = readFileSync(join(here, "..", "block", "function.mjs"), "utf8");
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
  const code = readFileSync(join(here, "function.mjs"), "utf8")
    .replaceAll("__GIZA_NETWORK__", network)
    .replaceAll("__GIZA_ADMIN_SECRET_HASH__", /^[0-9a-f]{64}$/.test(adminSecretHash) ? adminSecretHash : "__GIZA_DISABLED__")
    .replaceAll("__GIZA_BLOCK_FUNCTION_B64__", b64(blockFn))
    .replaceAll("__GIZA_BLOCK_SITE_B64__", b64(blockSiteHtml("__GIZA_HUB_URL__")))
    .replaceAll("__GIZA_BLOCK_MIGRATION_B64__", b64(BLOCK_MIGRATION));
  return {
    files: [{ file: "index.html", data: hubSiteHtml() }],
    functions: [{ name: "hub", code, deps: ["viem", "qrcode"] }],
    migrations: HUB_MIGRATIONS,
    routes: {
      replace: [
        { pattern: "/api/*", methods: ["GET", "POST", "OPTIONS"], target: { type: "function", name: "hub" } },
        { pattern: "/blocks/*", methods: ["GET"], target: { type: "function", name: "hub" } },
        { pattern: "/fund/*", methods: ["GET"], target: { type: "function", name: "hub" } },
      ],
    },
  };
}
