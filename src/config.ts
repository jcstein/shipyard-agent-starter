import {
  APP_NAMESPACE_ID,
  EDEN_RPC_URL,
  HOUSTON_INFERENCE,
  MOCHA_PUBLIC_CORE_GRPC,
  MOCHA_PUBLIC_RPC,
  NATIVE_ESCROW,
} from "./eden.ts";
import { parseTia, parseUsd } from "./money.ts";

export type SignField = "nonce" | "paymentId";
export type DemoMode = "dry-run" | "live";
export type EdictaCommitMode = "fast" | "strict";

export type Config = {
  mode: DemoMode;
  privateKey: string | null;
  spendCapWei: bigint;
  spendCapUsdWei: bigint | null;
  houstonBase: string;
  model: string;
  maxTokens: number;
  signField: SignField;
  /** When a deposited payment is rejected as an invalid signature, retry the chat completion once with the other field. Never deposits again. */
  retryOtherSignField: boolean;
  escrow: string;
  edenRpc: string;
  tracesDir: string;
  /** When set, post and verify use this light-node JSON-RPC instead of the Go helper. */
  celestiaRpc: string | null;
  celestiaToken: string | null;
  celestiaHelper: string;
  celestiaKeyring: string;
  celestiaKeyName: string;
  celestiaDaUrl: string;
  celestiaDaTls: boolean;
  celestiaCoreGrpc: string;
  celestiaCoreTls: boolean;
  namespaceId: string;
  receiptsPath: string;
  postsPath: string;
  /** Local checkout jobs: task, status, and the inference result. */
  jobsPath: string;
  stripeSecret: string | null;
  stripeWebhookSecret: string | null;
  stripeAmountGbp: string;
  customerRef: string;
  successUrl: string;
  cancelUrl: string;
  webhookPort: number;
  /**
   * Paid Houston calls go through a local `edicta agent serve`.
   * Off unless `DEMO_MODE=edicta`, or `EDICTA=1` together with `DEMO_MODE=live`.
   * Dry-run ignores `EDICTA`.
   */
  edicta: boolean;
  edictaAgentUrl: string;
  /** Bearer for agent serve, when that process requires one. Never the payer key. */
  edictaToken: string | null;
  /** Eden address of the signer's payer. This process does not hold that key. */
  edictaPayer: string | null;
  edictaPolicyId: string;
  edictaPolicyVersion: string;
  edictaModelVersion: string;
  edictaCommitMode: EdictaCommitMode;
  edictaValidFor: string;
  edictaWait: string;
  edictaPendingPath: string;
};

function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  const flag = value?.trim().toLowerCase() ?? "";
  if (flag === "1" || flag === "true" || flag === "yes") return true;
  if (flag === "0" || flag === "false" || flag === "no") return false;
  return fallback;
}

const GO_DURATION = /^(?:\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h))+$/;
const GO_UNITS_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** Go duration string to milliseconds. Null when it is not one. */
export function parseGoDurationMs(value: string): number | null {
  if (!GO_DURATION.test(value)) return null;
  let total = 0;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(match[1]) * (GO_UNITS_MS[match[2] ?? ""] ?? 0);
  }
  return total;
}

function assertLoopbackAgentUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("EDICTA_AGENT_URL is not a URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("EDICTA_AGENT_URL must be http or https");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("EDICTA_AGENT_URL must not carry credentials, a query, or a fragment");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new Error("EDICTA_AGENT_URL must not include a path");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (!loopback) {
    throw new Error("EDICTA_AGENT_URL must be a loopback address. This client does not call a remote agent serve.");
  }
  return `${url.origin}`;
}

function assertGoDuration(name: string, value: string, maxMs: number): string {
  const ms = parseGoDurationMs(value);
  if (ms === null || ms <= 0 || ms > maxMs) {
    throw new Error(`${name} must be a positive Go duration up to ${maxMs}ms (examples: 10m, 5m)`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demoMode = env.DEMO_MODE?.trim() ?? "";
  const mode: DemoMode = demoMode === "live" || demoMode === "edicta" ? "live" : "dry-run";
  const edicta = mode === "live" && (demoMode === "edicta" || envBool(env.EDICTA, false));
  const signField: SignField = env.HOUSTON_SIGN_FIELD === "nonce" ? "nonce" : "paymentId";
  const retryFlag = env.HOUSTON_RETRY_OTHER_SIGN_FIELD?.trim().toLowerCase() ?? "";
  const retryOtherSignField = retryFlag === "1" || retryFlag === "true" || retryFlag === "yes";
  const maxTokens = Number(env.HOUSTON_MAX_TOKENS ?? "32");
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
    throw new Error("HOUSTON_MAX_TOKENS must be an integer from 1 to 4096");
  }
  const webhookPort = Number(env.WEBHOOK_PORT ?? "8787");
  if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
    throw new Error("WEBHOOK_PORT must be a TCP port");
  }
  const namespaceId = env.CELESTIA_NAMESPACE?.trim() || APP_NAMESPACE_ID;
  if (Buffer.byteLength(namespaceId) < 1 || Buffer.byteLength(namespaceId) > 10) {
    throw new Error("CELESTIA_NAMESPACE must be 1 to 10 bytes");
  }
  const spendCapUsd = blankToNull(env.SPEND_CAP_USD);
  const celestiaDaUrl = env.CELESTIA_DA_URL?.trim() || MOCHA_PUBLIC_RPC;
  const edictaAgentUrl = env.EDICTA_AGENT_URL?.trim() || "http://127.0.0.1:8500";
  const edictaPayer = blankToNull(env.EDICTA_PAYER);
  const edictaModeRaw = (env.EDICTA_MODE?.trim() || "fast").toLowerCase();
  const edictaValidFor = env.EDICTA_VALID_FOR?.trim() || "10m";
  const edictaWait = env.EDICTA_WAIT?.trim() || "5m";
  const edictaPolicyId = env.EDICTA_POLICY_ID?.trim() || "shipyard-houston";
  const edictaPolicyVersion = env.EDICTA_POLICY_VERSION?.trim() || "1";
  const edictaModelVersion = env.EDICTA_MODEL_VERSION?.trim() || "1";
  const houstonBase = (env.HOUSTON_BASE_URL?.trim() || HOUSTON_INFERENCE).replace(/\/$/, "");
  if (edicta) {
    assertLoopbackAgentUrl(edictaAgentUrl);
    if (!edictaPayer || !/^0x[0-9a-fA-F]{40}$/.test(edictaPayer)) {
      throw new Error(
        "EDICTA_PAYER must be the signer payer address (0x and 40 hex digits). The agent does not hold that key and does not read it from EDEN_PRIVATE_KEY.",
      );
    }
    if (edictaModeRaw !== "fast" && edictaModeRaw !== "strict") {
      throw new Error("EDICTA_MODE must be fast or strict");
    }
    assertGoDuration("EDICTA_VALID_FOR", edictaValidFor, 24 * 60 * 60 * 1000);
    assertGoDuration("EDICTA_WAIT", edictaWait, 60 * 60 * 1000);
    if (!houstonBase.startsWith("https://")) {
      throw new Error("An Edicta Houston call needs HOUSTON_BASE_URL to start with https://");
    }
    if (edictaPolicyId.length === 0 || edictaPolicyVersion.length === 0 || edictaModelVersion.length === 0) {
      throw new Error("EDICTA_POLICY_ID, EDICTA_POLICY_VERSION, and EDICTA_MODEL_VERSION must be non-empty");
    }
  }
  return {
    mode,
    privateKey: blankToNull(env.EDEN_PRIVATE_KEY),
    spendCapWei: parseTia(env.SPEND_CAP_TIA?.trim() || "0.05"),
    spendCapUsdWei: spendCapUsd ? parseUsd(spendCapUsd) : null,
    houstonBase,
    model: env.HOUSTON_MODEL?.trim() || "qwen/qwen-flash",
    maxTokens,
    signField,
    retryOtherSignField,
    escrow: env.ESCROW_ADDRESS?.trim() || NATIVE_ESCROW,
    edenRpc: env.EDEN_RPC_URL?.trim() || EDEN_RPC_URL,
    tracesDir: env.TRACE_DIR?.trim() || "traces",
    celestiaRpc: blankToNull(env.CELESTIA_RPC_URL),
    celestiaToken: blankToNull(env.CELESTIA_AUTH_TOKEN),
    celestiaHelper: env.CELESTIA_HELPER?.trim() || "celestia/mocha-helper",
    celestiaKeyring: env.CELESTIA_KEYRING?.trim() || "celestia-keys",
    celestiaKeyName: env.CELESTIA_KEY_NAME?.trim() || "shipyard",
    celestiaDaUrl,
    celestiaDaTls: envBool(env.CELESTIA_DA_TLS, celestiaDaUrl.startsWith("https://")),
    celestiaCoreGrpc: env.CELESTIA_CORE_GRPC?.trim() || MOCHA_PUBLIC_CORE_GRPC,
    celestiaCoreTls: envBool(env.CELESTIA_CORE_TLS, true),
    namespaceId,
    receiptsPath: env.RECEIPTS_PATH?.trim() || "receipts.jsonl",
    postsPath: env.POSTS_PATH?.trim() || "posts.json",
    jobsPath: env.JOBS_PATH?.trim() || "jobs.json",
    stripeSecret: blankToNull(env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: blankToNull(env.STRIPE_WEBHOOK_SECRET),
    stripeAmountGbp: env.STRIPE_AMOUNT_GBP?.trim() || "5.00",
    customerRef: env.CHECKOUT_CUSTOMER_REF?.trim() || "hackathon-team",
    successUrl: env.STRIPE_SUCCESS_URL?.trim() || "http://localhost:8787/success",
    cancelUrl: env.STRIPE_CANCEL_URL?.trim() || "http://localhost:8787/cancel",
    webhookPort,
    edicta,
    edictaAgentUrl: edicta ? assertLoopbackAgentUrl(edictaAgentUrl) : edictaAgentUrl,
    edictaToken: blankToNull(env.EDICTA_TOKEN),
    edictaPayer,
    edictaPolicyId,
    edictaPolicyVersion,
    edictaModelVersion,
    edictaCommitMode: edictaModeRaw === "strict" ? "strict" : "fast",
    edictaValidFor,
    edictaWait,
    edictaPendingPath: env.EDICTA_PENDING_PATH?.trim() || "edicta-pending.json",
  };
}

export function assertPrivateKey(key: string): `0x${string}` {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("EDEN_PRIVATE_KEY must be a 32-byte hex private key");
  }
  return `0x${hex}`;
}
