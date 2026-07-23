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

const here = dirname(fileURLToPath(import.meta.url));

/** @param {{network?: "testnet"|"mainnet", adminSecretHash?: string}} opts
 *  `adminSecretHash` = sha256 hex of the operator-held admin secret; omit to
 *  deploy with ALL admin routes disabled (fail closed). */
export function buildHubBundle({ network = "testnet", adminSecretHash = "" } = {}) {
  const code = readFileSync(join(here, "function.mjs"), "utf8")
    .replaceAll("__GIZA_NETWORK__", network)
    .replaceAll("__GIZA_ADMIN_SECRET_HASH__", /^[0-9a-f]{64}$/.test(adminSecretHash) ? adminSecretHash : "__GIZA_DISABLED__");
  return {
    files: [{ file: "index.html", data: hubSiteHtml() }],
    functions: [{ name: "hub", code, deps: ["viem"] }],
    migrations: HUB_MIGRATIONS,
    routes: {
      replace: [
        { pattern: "/api/*", methods: ["GET", "POST", "OPTIONS"], target: { type: "function", name: "hub" } },
        { pattern: "/blocks/*", methods: ["GET"], target: { type: "function", name: "hub" } },
      ],
    },
  };
}
