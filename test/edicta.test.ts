import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Interface } from "ethers";
import { loadConfig } from "../src/config.ts";
import { NATIVE_ESCROW } from "../src/eden.ts";
import { fulfillCheckout } from "../src/fulfill.ts";
import { sha256Hex } from "../src/hash.ts";
import { encodePaymentSignature, parsePaymentRequired } from "../src/houston.ts";
import { claimJob, readJob } from "../src/jobs.ts";
import { appendReceipt, readReceiptLines, verifyHashChain } from "../src/receipts.ts";
import { runDemo } from "../src/run.ts";
import { describeCheckoutJobs } from "../src/verify.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const DEPOSIT = new Interface([
  "function deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd) payable",
]);
const PAYER = `0x${"11".repeat(20)}`;
const COMMITMENT = "ab".repeat(32);
const RAIL = "cd".repeat(32);
const SIGNATURE = `0x${"ab".repeat(65)}`;
const AUTHORIZATION = Buffer.from("gate-authorization").toString("base64");

function freshHeader(): string {
  const raw = JSON.parse(readFileSync(join(fixtureDir, "payment-required.json"), "utf8")) as {
    accepts: Array<{ extra: { expiresAt: number; refundAfter: number } }>;
  };
  const accept = raw.accepts[0];
  if (!accept) throw new Error("fixture missing accept");
  const now = Math.floor(Date.now() / 1000);
  accept.extra.expiresAt = now + 3600;
  accept.extra.refundAfter = now + 8 * 24 * 3600;
  return Buffer.from(JSON.stringify(raw)).toString("base64");
}

function buildFor(header: string) {
  const quote = parsePaymentRequired(header, { price: { amount: "0.000007", currency: "TIA" } }, NATIVE_ESCROW);
  const extra = quote.accepted.extra;
  return {
    txData: {
      to: NATIVE_ESCROW,
      data: DEPOSIT.encodeFunctionData("deposit", [
        extra.paymentId,
        quote.accepted.payTo,
        extra.facilitator,
        extra.expiresAt,
        extra.refundAfter,
        extra.tiaPriceUsd,
      ]),
      value: quote.accepted.amount,
      nonce: 7,
      gasLimit: "1000",
      maxFeePerGas: "3",
      maxPriorityFeePerGas: "1",
      chainId: 714,
    },
    paymentId: extra.paymentId,
  };
}

function commitAnswer(mode: "fast" | "strict" = "fast") {
  return {
    commitment_hash: COMMITMENT,
    mode,
    settled: true,
    payment_signature: SIGNATURE,
    rail_ref: RAIL,
    payer: PAYER,
    authorization: AUTHORIZATION,
    recorded: true,
    anchor_deadline: mode === "fast" ? 99 : undefined,
  };
}

function edictaEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    DEMO_MODE: "edicta",
    EDICTA_PAYER: PAYER,
    EDICTA_AGENT_URL: "http://127.0.0.1:8500",
    EDICTA_TOKEN: "edicta-test-token-value",
    RECEIPTS_PATH: join(dir, "receipts.jsonl"),
    POSTS_PATH: join(dir, "posts.json"),
    JOBS_PATH: join(dir, "jobs.json"),
    TRACE_DIR: join(dir, "traces"),
    EDICTA_PENDING_PATH: join(dir, "edicta-pending.json"),
    SPEND_CAP_TIA: "0.05",
    ...extra,
  };
}

describe("edicta flag", () => {
  it("leaves dry-run and live config unchanged when the flag is off", () => {
    const dry = loadConfig({});
    assert.equal(dry.mode, "dry-run");
    assert.equal(dry.edicta, false);
    const ignored = loadConfig({ EDICTA: "1", EDICTA_PAYER: "not-an-address", EDICTA_MODE: "nope" });
    assert.equal(ignored.mode, "dry-run");
    assert.equal(ignored.edicta, false);
    const live = loadConfig({ DEMO_MODE: "live", EDICTA: "0" });
    assert.equal(live.mode, "live");
    assert.equal(live.edicta, false);
  });

  it("turns the paid path on for DEMO_MODE=edicta and for EDICTA=1 with live", () => {
    const named = loadConfig({ DEMO_MODE: "edicta", EDICTA_PAYER: PAYER });
    assert.equal(named.mode, "live");
    assert.equal(named.edicta, true);
    assert.equal(named.edictaCommitMode, "fast");
    assert.equal(named.privateKey, null);
    const paired = loadConfig({ DEMO_MODE: "live", EDICTA: "1", EDICTA_PAYER: PAYER, EDICTA_MODE: "strict" });
    assert.equal(paired.edicta, true);
    assert.equal(paired.edictaCommitMode, "strict");
    assert.throws(() => loadConfig({ DEMO_MODE: "edicta" }), /EDICTA_PAYER/);
    assert.throws(() => loadConfig({ DEMO_MODE: "edicta", EDICTA_PAYER: PAYER, EDICTA_AGENT_URL: "https://example.com" }), /loopback/);
  });

  it("does not call Edicta or sign when EDICTA=1 is set on a dry-run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edicta-off-"));
    const header = freshHeader();
    const urls: string[] = [];
    await runDemo(
      loadConfig({
        EDICTA: "1",
        EDICTA_PAYER: PAYER,
        RECEIPTS_PATH: join(dir, "receipts.jsonl"),
        POSTS_PATH: join(dir, "posts.json"),
        EDICTA_PENDING_PATH: join(dir, "edicta-pending.json"),
      }),
      async (input) => {
        const url = String(input);
        urls.push(url);
        if (!url.endsWith("/chat/completions")) throw new Error(`dry-run called ${url}`);
        return new Response(JSON.stringify({ error: "Payment Required" }), {
          status: 402,
          headers: { "payment-required": header },
        });
      },
    );
    const receipt = JSON.parse(readReceiptLines(join(dir, "receipts.jsonl"))[0] ?? "") as { dryRun: boolean };
    assert.equal(receipt.dryRun, true);
    assert.equal("edicta" in receipt, false);
    assert.equal(existsSync(join(dir, "edicta-pending.json")), false);
    assert.equal(urls.some((url) => url.includes("/v1/commit") || url.includes("/deposit/")), false);
  });

  it("pays through agent serve and records the commitment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edicta-on-"));
    const env = edictaEnv(dir);
    const header = freshHeader();
    const build = buildFor(header);
    const quote = parsePaymentRequired(header, null, NATIVE_ESCROW);
    const commits: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (url.endsWith("/chat/completions")) {
        const headers = new Headers(init?.headers);
        if (headers.get("payment-signature")) {
          assert.equal(headers.get("payment-signature"), encodePaymentSignature(quote, SIGNATURE));
          return Response.json(JSON.parse(readFileSync(join(fixtureDir, "paid-200.json"), "utf8")), {
            headers: { "payment-response": Buffer.from(readFileSync(join(fixtureDir, "payment-response.json"), "utf8")).toString("base64") },
          });
        }
        return new Response(JSON.stringify({ error: "Payment Required" }), { status: 402, headers: { "payment-required": header } });
      }
      if (url.endsWith("/deposit/build")) {
        assert.equal(body.from, PAYER);
        return Response.json(build);
      }
      if (url.endsWith("/v1/commit")) {
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer edicta-test-token-value");
        commits.push(body);
        return Response.json(commitAnswer());
      }
      throw new Error(`unexpected ${url}`);
    };
    await runDemo(loadConfig(env), fetchImpl);
    assert.equal(commits.length, 1);
    const commit = commits[0];
    assert.ok(commit);
    assert.equal(commit.sign, true);
    assert.equal(commit.broadcast, true);
    assert.equal(commit.record, true);
    assert.equal(commit.payment_signature, true);
    assert.equal(commit.mode, "fast");
    assert.equal(commit.valid_for, "10m");
    assert.equal("resume_hash" in commit, false);
    const eden = commit.eden as { payment_required: string; resource: string; build: { paymentId: string } };
    assert.equal(eden.payment_required, header);
    assert.equal(eden.resource, "https://inference.bot.fun/v1/chat/completions");
    assert.equal(eden.build.paymentId, build.paymentId);
    const lines = readReceiptLines(env.RECEIPTS_PATH ?? "");
    verifyHashChain(lines);
    const inference = JSON.parse(lines[0] ?? "") as {
      dryRun: boolean;
      depositTxHash: string;
      tiaCharged: string;
      edicta: { commitmentHash: string; mode: string; railRef: string; payer: string; recorded: boolean; authorizationSha256: string };
    };
    assert.equal(inference.dryRun, false);
    assert.equal(inference.depositTxHash, `0x${RAIL}`);
    assert.equal(inference.tiaCharged, "9147039588615");
    assert.equal(inference.edicta.commitmentHash, COMMITMENT);
    assert.equal(inference.edicta.mode, "fast");
    assert.equal(inference.edicta.railRef, `0x${RAIL}`);
    assert.equal(inference.edicta.payer, PAYER);
    assert.equal(inference.edicta.recorded, true);
    assert.equal(inference.edicta.authorizationSha256, sha256Hex(AUTHORIZATION));
    assert.equal(JSON.stringify(inference).includes(AUTHORIZATION), false);
    assert.equal(existsSync(env.EDICTA_PENDING_PATH ?? ""), false);
    const trace = readFileSync(join(dir, "traces", readTraces(dir)[0] ?? ""), "utf8");
    assert.equal(trace.includes(AUTHORIZATION), true);
    assert.equal(trace.includes("edicta-test-token-value"), false);
  });

  it("retries strict once when fast mode is refused before a commitment exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edicta-strict-"));
    const env = edictaEnv(dir);
    const header = freshHeader();
    const build = buildFor(header);
    const modes: string[] = [];
    let commits = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        const signed = new Headers(init?.headers).get("payment-signature");
        if (signed) return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
        return new Response("{}", { status: 402, headers: { "payment-required": header } });
      }
      if (url.endsWith("/deposit/build")) return Response.json(build);
      if (url.endsWith("/v1/commit")) {
        commits += 1;
        const body = JSON.parse(String(init?.body)) as { mode: string };
        modes.push(body.mode);
        if (commits === 1) {
          return Response.json(
            { code: "usage", message: "fast mode needs network.bridge to check the anchor intent", retryable: false },
            { status: 400 },
          );
        }
        return Response.json(commitAnswer("strict"));
      }
      throw new Error(`unexpected ${url}`);
    };
    await runDemo(loadConfig(env), fetchImpl);
    assert.deepEqual(modes, ["fast", "strict"]);
    const inference = JSON.parse(readReceiptLines(env.RECEIPTS_PATH ?? "")[0] ?? "") as { edicta: { mode: string } };
    assert.equal(inference.edicta.mode, "strict");
  });

  it("keeps a commitment hash and resumes it without a second deposit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edicta-resume-"));
    const env = edictaEnv(dir);
    const header = freshHeader();
    const build = buildFor(header);
    const calls: string[] = [];
    let commits = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/chat/completions")) {
        const signed = new Headers(init?.headers).get("payment-signature");
        if (signed) return Response.json({ choices: [{ message: { content: "resumed" } }] });
        return new Response("{}", { status: 402, headers: { "payment-required": header } });
      }
      if (url.endsWith("/deposit/build")) return Response.json(build);
      if (url.endsWith("/deposit/send")) throw new Error("deposit/send must not be called");
      if (url.endsWith("/v1/commit")) {
        commits += 1;
        const body = JSON.parse(String(init?.body)) as { resume_hash?: string; eden?: { build?: unknown } };
        if (commits === 1) {
          return Response.json(
            { code: "ErrFastModeNotAllowed", message: "fast mode is not allowed", commitment_hash: COMMITMENT, retryable: false },
            { status: 422 },
          );
        }
        assert.equal(body.resume_hash, COMMITMENT);
        assert.equal(body.eden && "build" in body.eden, false);
        return Response.json(commitAnswer("fast"));
      }
      throw new Error(`unexpected ${url}`);
    };
    await assert.rejects(() => runDemo(loadConfig(env), fetchImpl), /Do not request a new 402/);
    assert.equal(existsSync(env.EDICTA_PENDING_PATH ?? ""), true);
    assert.equal(readReceiptLines(env.RECEIPTS_PATH ?? "").length, 0);
    const before = calls.filter((url) => url.endsWith("/deposit/build")).length;
    calls.length = 0;
    await runDemo(loadConfig(env), fetchImpl);
    assert.equal(before, 1);
    assert.equal(calls.filter((url) => url.endsWith("/deposit/build")).length, 0);
    assert.equal(calls.filter((url) => url.endsWith("/chat/completions")).length, 1);
    const lines = readReceiptLines(env.RECEIPTS_PATH ?? "");
    verifyHashChain(lines);
    const inference = JSON.parse(lines[0] ?? "") as { edicta: { commitmentHash: string }; depositTxHash: string };
    assert.equal(inference.edicta.commitmentHash, COMMITMENT);
    assert.equal(inference.depositTxHash, `0x${RAIL}`);
    assert.equal(existsSync(env.EDICTA_PENDING_PATH ?? ""), false);
  });

  it("records the commitment on a checkout job and still says test mode is not revenue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "edicta-job-"));
    const env = edictaEnv(dir);
    const cfg = loadConfig(env);
    const header = freshHeader();
    const build = buildFor(header);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        const signed = new Headers(init?.headers).get("payment-signature");
        if (signed) return Response.json({ choices: [{ message: { content: "named" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
        return new Response("{}", { status: 402, headers: { "payment-required": header } });
      }
      if (url.endsWith("/deposit/build")) return Response.json(build);
      if (url.endsWith("/v1/commit")) return Response.json(commitAnswer());
      throw new Error(`unexpected ${url}`);
    };
    const { job } = claimJob(cfg.jobsPath, {
      checkoutId: "cs_test_edicta",
      stripePaymentId: "pi_test_edicta",
      task: "name a price",
      livemode: false,
      dryRun: false,
    });
    await fulfillCheckout(cfg, job, fetchImpl);
    const saved = readJob(cfg.jobsPath, "cs_test_edicta");
    assert.equal(saved?.status, "done");
    assert.equal(saved?.edicta?.commitmentHash, COMMITMENT);
    assert.equal(saved?.edicta?.authorizationSha256, sha256Hex(AUTHORIZATION));
    const lines = readReceiptLines(cfg.receiptsPath);
    verifyHashChain(lines);
    const inference = JSON.parse(lines[0] ?? "") as { checkoutId: string; stripePaymentId: string; edicta: { commitmentHash: string } };
    assert.equal(inference.checkoutId, "cs_test_edicta");
    assert.equal(inference.stripePaymentId, "pi_test_edicta");
    assert.equal(inference.edicta.commitmentHash, COMMITMENT);
    appendSale(cfg.receiptsPath);
    const notes = describeCheckoutJobs(readReceiptLines(cfg.receiptsPath));
    assert.match(notes.join("\n"), /Edicta commitment ababab/);
    assert.match(notes.join("\n"), /not revenue/);
  });
});

function readTraces(dir: string): string[] {
  return readdirSync(join(dir, "traces"));
}

function appendSale(path: string): void {
  appendReceipt(path, {
    type: "sale",
    checkoutId: "cs_test_edicta",
    paymentId: "pi_test_edicta",
    amount: "5.00",
    currency: "GBP",
    customerRef: "team",
    livemode: false,
  });
}
