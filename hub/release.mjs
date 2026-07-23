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

/** @param {{network?: "testnet"|"mainnet"}} opts */
export function buildHubBundle({ network = "testnet" } = {}) {
  const code = readFileSync(join(here, "function.mjs"), "utf8")
    .replaceAll("__GIZA_NETWORK__", network);
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
