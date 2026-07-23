/**
 * Deploy the Giza hub (and optionally the Pharaoh block) to run402.
 *
 * Season-0/production deploys run this with the operating org's wallet key —
 * per run402-private CLAUDE.md, internal apps deploy with the platform/dogfood
 * wallet (PLATFORM_WALLET_PRIVATE_KEY), never the dedicated e2e buyer wallet.
 *
 *   GIZA_DEPLOY_PRIVATE_KEY=0x... \
 *   GIZA_NETWORK=testnet \
 *   GIZA_HUB_SUBDOMAIN=giza \
 *   BASE_URL=https://api.run402.com \
 *   node deploy.mjs [--with-pharaoh]
 *
 * The heavy lifting (content plans, CAS upload, apply commit, SIWX) lives in
 * run402-private's test helper; this script is intentionally a thin driver
 * and expects to run from a checkout that can import it (set RUN402_PRIVATE
 * to that checkout, default ../run402-private relative to this repo).
 */
import { privateKeyToAccount } from "viem/accounts";
import { buildHubBundle } from "./hub/release.mjs";
import { buildBlockBundle } from "./block/release.mjs";

const BASE_URL = process.env.BASE_URL ?? "https://api.run402.com";
const NETWORK = process.env.GIZA_NETWORK === "mainnet" ? "mainnet" : "testnet";
const SUBDOMAIN = process.env.GIZA_HUB_SUBDOMAIN ?? "giza";
const RUN402_PRIVATE = process.env.RUN402_PRIVATE ?? new URL("../run402-private", import.meta.url).pathname;
const KEY = process.env.GIZA_DEPLOY_PRIVATE_KEY;
if (!KEY) {
  console.error("GIZA_DEPLOY_PRIVATE_KEY is required (use the operating org's wallet, never the e2e buyer)");
  process.exit(1);
}

const { applyBundleV1 } = await import(`${RUN402_PRIVATE}/test/util/apply-v1-helper.ts`);
const { createSIWxPayload, encodeSIWxHeader } = await import("@x402/extensions/sign-in-with-x");

const account = privateKeyToAccount(KEY);
async function siwx(path) {
  const u = new URL(BASE_URL);
  const now = new Date();
  const payload = await createSIWxPayload({
    domain: u.hostname,
    uri: `${u.protocol}//${u.host}${path}`,
    statement: "Sign in to Run402",
    version: "1",
    nonce: Math.random().toString(36).slice(2),
    issuedAt: now.toISOString(),
    expirationTime: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
    chainId: NETWORK === "mainnet" ? "eip155:8453" : "eip155:84532",
    type: "eip191",
  }, account);
  return { "SIGN-IN-WITH-X": encodeSIWxHeader(payload) };
}

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log(`Deploying Giza hub as ${account.address} → ${SUBDOMAIN}.run402.com (${NETWORK})`);
const create = await api("POST", "/projects/v1", { name: "giza-hub" }, await siwx("/projects/v1"));
if (create.status !== 201 && create.status !== 200) {
  console.error("project create failed", create.status, create.body);
  process.exit(1);
}
const { project_id, service_key } = create.body;
const deployed = await applyBundleV1({
  baseUrl: BASE_URL,
  serviceKey: service_key,
  siwxHeaders: siwx,
  body: { project_id, ...buildHubBundle({ network: NETWORK }) },
  operationTimeoutMs: 300_000,
});
console.log("hub release:", deployed.status, deployed.release_id);
const claim = await api("POST", "/subdomains/v1", { name: SUBDOMAIN, deployment_id: deployed.deployment_id },
  { authorization: `Bearer ${service_key}` });
console.log("subdomain:", claim.status, `https://${SUBDOMAIN}.run402.com`);
console.log("hub service key (KEEP SAFE — it is the Giza admin credential):", service_key);

if (process.argv.includes("--with-pharaoh")) {
  const hubUrl = `https://${SUBDOMAIN}.run402.com`;
  const sub = process.env.GIZA_PHARAOH_SUBDOMAIN ?? "giza-pharaoh";
  const createP = await api("POST", "/projects/v1", { name: "giza-pharaoh" }, await siwx("/projects/v1"));
  const pDeployed = await applyBundleV1({
    baseUrl: BASE_URL,
    serviceKey: createP.body.service_key,
    siwxHeaders: siwx,
    body: { project_id: createP.body.project_id, ...buildBlockBundle({ hubUrl, networks: [NETWORK] }) },
    operationTimeoutMs: 300_000,
  });
  await api("POST", "/subdomains/v1", { name: sub, deployment_id: pDeployed.deployment_id },
    { authorization: `Bearer ${createP.body.service_key}` });
  const reg = await fetch(`${hubUrl}/api/admin/pharaoh`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${service_key}` },
    body: JSON.stringify({ base_url: `https://${sub}.run402.com`, payout_wallet: account.address, owner_wallet: account.address }),
  });
  console.log("pharaoh registered:", reg.status, await reg.json().catch(() => null));
}
