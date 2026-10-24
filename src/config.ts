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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: DemoMode = env.DEMO_MODE === "live" ? "live" : "dry-run";
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
  return {
    mode,
    privateKey: blankToNull(env.EDEN_PRIVATE_KEY),
    spendCapWei: parseTia(env.SPEND_CAP_TIA?.trim() || "0.05"),
    spendCapUsdWei: spendCapUsd ? parseUsd(spendCapUsd) : null,
    houstonBase: (env.HOUSTON_BASE_URL?.trim() || HOUSTON_INFERENCE).replace(/\/$/, ""),
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
  };
}

export function assertPrivateKey(key: string): `0x${string}` {
  const hex = key.startsWith("0x") ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("EDEN_PRIVATE_KEY must be a 32-byte hex private key");
  }
  return `0x${hex}`;
}
