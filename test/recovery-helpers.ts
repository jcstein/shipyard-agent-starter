import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getBytes, Interface, keccak256, Wallet } from "ethers";
import { loadConfig, type Config } from "../src/config.ts";
import { NATIVE_ESCROW } from "../src/eden.ts";
import type { PaymentRequired } from "../src/houston.ts";
import { claimJob } from "../src/jobs.ts";
import { recordSale } from "../src/stripe.ts";
import type { HelperRun } from "../src/mocha.ts";

export function config(extra: NodeJS.ProcessEnv = {}, dir = mkdtempSync(join(tmpdir(), "recovery-"))): Config {
  return loadConfig({ DEMO_MODE: "live", EDEN_PRIVATE_KEY: Wallet.createRandom().privateKey,
    STRIPE_WEBHOOK_SECRET: "whsec_local_recovery_test",
    RECEIPTS_PATH: join(dir, "receipts.jsonl"), POSTS_PATH: join(dir, "posts.json"),
    JOBS_PATH: join(dir, "jobs.json"), TRACE_DIR: join(dir, "traces"),
    HOUSTON_BASE_URL: "https://houston.invalid/v1", ...extra });
}

export function job(cfg: Config, id: string) {
  recordSale(cfg, { id, payment_intent: `pi_${id}`, amount_total: 500, currency: "gbp", livemode: false });
  return claimJob(cfg.jobsPath, { checkoutId: id, stripePaymentId: `pi_${id}`, task: "Say hello", livemode: false, dryRun: cfg.mode !== "live" }).job;
}

export function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

export async function fresh() {
  const raw = JSON.parse(readFileSync(new URL("./fixtures/payment-required.json", import.meta.url), "utf8")) as PaymentRequired;
  const accepted = raw.accepts[0]!;
  const facilitator = Wallet.createRandom();
  accepted.amount = "30000000000000000";
  accepted.extra.paymentId = keccak256(getBytes(facilitator.address));
  accepted.extra.facilitator = facilitator.address;
  accepted.extra.serverSignature = await facilitator.signMessage(getBytes(accepted.extra.paymentId));
  accepted.extra.expiresAt = Math.floor(Date.now() / 1000) + 3600;
  accepted.extra.refundAfter = accepted.extra.expiresAt + 86400;
  const deposit = new Interface(["function deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd) payable"]);
  const extra = accepted.extra;
  const tx = { to: NATIVE_ESCROW, value: accepted.amount, chainId: 714, nonce: 3, gasLimit: "1000", maxFeePerGas: "3", maxPriorityFeePerGas: "1",
    data: deposit.encodeFunctionData("deposit", [extra.paymentId, accepted.payTo, extra.facilitator, extra.expiresAt, extra.refundAfter, extra.tiaPriceUsd]) };
  return { header: Buffer.from(JSON.stringify(raw)).toString("base64"), accepted, tx };
}

export function houston(quote: Awaited<ReturnType<typeof fresh>>, options: {
  failure?: "timeout" | "html" | "send";
  paidGate?: ReturnType<typeof deferred>;
  onSend?: () => void;
} = {}) {
  const calls: string[] = [];
  let hash = "";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/chat/completions")) {
      if (!new Headers(init?.headers).has("payment-signature")) return json({}, 402, { "payment-required": quote.header });
      if (options.paidGate) await options.paidGate.promise;
      return json({ choices: [{ message: { content: "hello" } }], houston: { cost_tia: quote.accepted.amount } });
    }
    if (url.endsWith("/deposit/build")) return json({ paymentId: quote.accepted.extra.paymentId, txData: quote.tx });
    if (url.endsWith("/deposit/send")) {
      hash = keccak256((JSON.parse(String(init?.body)) as { signedTx: string }).signedTx);
      options.onSend?.();
      if (options.failure === "send") throw new Error("mock connection lost after send");
      return json({ paymentId: quote.accepted.extra.paymentId, txHash: hash });
    }
    if (url.includes("/deposit/status/")) {
      if (options.failure === "timeout") throw new DOMException("mock status timeout", "TimeoutError");
      if (options.failure === "html") return new Response("mock gateway error", { status: 502 });
      return json({ txHash: hash, status: "confirmed" });
    }
    throw new Error(`unexpected mocked call: ${url}`);
  };
  return { fetchImpl, calls };
}

export function helper() {
  const payloads: string[][] = [];
  const run: HelperRun = async (request) => {
    payloads.push((JSON.parse(request.stdin!.toString()) as { lines: string[] }).lines);
    return { code: 0, stdout: Buffer.from(JSON.stringify({ height: 100 + payloads.length,
      commitment: Buffer.alloc(32, payloads.length).toString("base64") })), stderr: "" };
  };
  return { run, payloads };
}
