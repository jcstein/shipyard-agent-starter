import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Interface, Wallet, getBytes } from "ethers";
import { loadConfig, type Config } from "../src/config.ts";
import { EDEN_RPC_URL, NATIVE_ESCROW } from "../src/eden.ts";
import { parsePaymentRequired, payAndComplete, recoverPersonalSigner, type ParsedQuote } from "../src/houston.ts";
import { formatPreflight, runPreflight } from "../src/preflight.ts";
import { runDemo } from "../src/run.ts";
import { redactSecrets } from "../src/trace.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const DEPOSIT = new Interface([
  "function deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd) payable",
]);

type Fresh = {
  header: string;
  quote: ParsedQuote;
  tx: {
    to: string;
    data: string;
    value: string;
    nonce: number;
    gasLimit: string;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    chainId: number;
  };
  amount: bigint;
  paymentId: string;
  nonce: string;
};

function freshQuote(): Fresh {
  const raw = JSON.parse(readFileSync(join(fixtureDir, "payment-required.json"), "utf8")) as {
    accepts: Array<{ payTo: string; amount: string; extra: { expiresAt: number; refundAfter: number } }>;
  };
  const accept = raw.accepts[0];
  if (!accept) throw new Error("fixture missing accept");
  const now = Math.floor(Date.now() / 1000);
  accept.extra.expiresAt = now + 3600;
  accept.extra.refundAfter = now + 8 * 24 * 3600;
  const header = Buffer.from(JSON.stringify(raw)).toString("base64");
  const quote = parsePaymentRequired(header, { price: { amount: "0.000007", currency: "TIA" } }, NATIVE_ESCROW);
  const extra = quote.accepted.extra;
  return {
    header,
    quote,
    tx: {
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
      nonce: 3,
      gasLimit: "1000",
      maxFeePerGas: "3",
      maxPriorityFeePerGas: "1",
      chainId: 714,
    },
    amount: BigInt(quote.accepted.amount),
    paymentId: extra.paymentId,
    nonce: extra.nonce,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function rpc(result: string): Response {
  return jsonResponse({ jsonrpc: "2.0", id: 1, result });
}

function config(dir: string, key: string | null, extra: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    EDEN_PRIVATE_KEY: key ?? "",
    RECEIPTS_PATH: join(dir, "receipts.jsonl"),
    POSTS_PATH: join(dir, "posts.json"),
    TRACE_DIR: join(dir, "traces"),
    SPEND_CAP_TIA: "0.05",
    HOUSTON_BASE_URL: "https://inference.bot.fun/v1",
    ...extra,
  });
}

function preflightFetch(input: {
  fresh: Fresh;
  balance: bigint;
  chainId?: string;
  quoteHeader?: string;
  calls: string[];
}): typeof fetch {
  return async (urlInput, init) => {
    const url = String(urlInput);
    const body = typeof init?.body === "string" ? init.body : null;
    input.calls.push(url);
    if (body?.includes("eth_sendRawTransaction")) throw new Error("preflight signed or sent a transaction");
    if (url === EDEN_RPC_URL) {
      const rpcBody = JSON.parse(body ?? "{}") as { method?: string };
      if (rpcBody.method === "eth_chainId") return rpc(input.chainId ?? "0x2ca");
      if (rpcBody.method === "eth_getBalance") return rpc(`0x${input.balance.toString(16)}`);
      throw new Error(`unexpected rpc ${rpcBody.method ?? "unknown"}`);
    }
    if (url.endsWith("/chat/completions")) {
      return jsonResponse(
        { error: "Payment Required", price: { amount: "0.000007", currency: "TIA" } },
        402,
        { "payment-required": input.quoteHeader ?? input.fresh.header },
      );
    }
    if (url.endsWith("/deposit/build")) {
      return jsonResponse({ txData: input.fresh.tx, paymentId: input.fresh.paymentId });
    }
    throw new Error(`preflight must not call ${url}`);
  };
}

type Call = { url: string; init?: RequestInit };

function scripted(handlers: Array<(url: string, init?: RequestInit) => Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const handler = handlers[index];
    index += 1;
    if (!handler) throw new Error(`unexpected ${url}`);
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

function headerOf(call: Call, name: string): string {
  const headers = call.init?.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) throw new Error("expected a header record");
  const value = headers[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function count(calls: Call[], part: string): number {
  return calls.filter((call) => call.url.includes(part)).length;
}

function depositSend(fresh: Fresh, txHash: string, headers?: Record<string, string>): Response {
  return jsonResponse({ txHash, paymentId: fresh.paymentId }, 200, headers);
}

function depositStatus(txHash: string): Response {
  return jsonResponse({ txHash, status: "confirmed" });
}

function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as unknown;
}

describe("preflight", () => {
  it("prints go when balance covers deposit plus gas under the cap, and never sends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-go-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const need = fresh.amount + 3000n;
    const calls: string[] = [];
    const report = await runPreflight(config(dir, wallet.privateKey), {
      fetchImpl: preflightFetch({ fresh, balance: need, calls }),
    });
    assert.equal(report.ok, true);
    assert.equal(report.address, wallet.address);
    assert.equal(report.chainId, 714);
    assert.equal(report.needWei, need);
    assert.equal(report.unsignedBuild, true);
    assert.equal(calls.some((url) => url.includes("/deposit/send")), false);
    const text = formatPreflight(report);
    assert.match(text, /^GO/);
    assert.match(text, /was not signed/);
    assert.match(text, /Suggested live command: DEMO_MODE=live npm run demo$/m);
    assert.equal(text.includes("HOUSTON_RETRY_OTHER_SIGN_FIELD"), false);
    assert.equal(text.includes(wallet.privateKey), false);
    assert.equal(text.includes(wallet.privateKey.slice(2)), false);
  });

  it("no-go when the balance is short of deposit plus gas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-short-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const report = await runPreflight(config(dir, wallet.privateKey), {
      fetchImpl: preflightFetch({ fresh, balance: 1n, calls: [] }),
    });
    assert.equal(report.ok, false);
    assert.match(formatPreflight(report), /NO-GO/);
    assert.match(report.reasons.join("\n"), /short of deposit plus gas/);
  });

  it("no-go when deposit plus gas exceeds the spend cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-cap-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const report = await runPreflight(config(dir, wallet.privateKey, { SPEND_CAP_TIA: "0.000000000000001" }), {
      fetchImpl: preflightFetch({ fresh, balance: 10n ** 18n, calls: [] }),
    });
    assert.equal(report.ok, false);
    assert.match(report.reasons.join("\n"), /spend cap/);
  });

  it("no-go when the RPC is not Eden and does not require a key to be a signature", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-chain-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const report = await runPreflight(config(dir, wallet.privateKey), {
      fetchImpl: preflightFetch({ fresh, balance: 10n ** 18n, chainId: "0x1", calls: [] }),
    });
    assert.equal(report.ok, false);
    assert.match(report.reasons.join("\n"), /not Eden/);
  });

  it("does not call deposit/build when the facilitator signature does not recover", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-sig-"));
    const wallet = Wallet.createRandom();
    const raw = JSON.parse(readFileSync(join(fixtureDir, "payment-required.json"), "utf8")) as {
      accepts: Array<{ extra: { serverSignature: string; expiresAt: number; refundAfter: number } }>;
    };
    const accept = raw.accepts[0];
    if (!accept) throw new Error("fixture missing accept");
    const now = Math.floor(Date.now() / 1000);
    accept.extra.expiresAt = now + 3600;
    accept.extra.refundAfter = now + 8 * 24 * 3600;
    accept.extra.serverSignature = `0x${"ab".repeat(65)}`;
    const header = Buffer.from(JSON.stringify(raw)).toString("base64");
    const fresh = freshQuote();
    const calls: string[] = [];
    const report = await runPreflight(config(dir, wallet.privateKey), {
      fetchImpl: preflightFetch({ fresh, balance: 10n ** 18n, quoteHeader: header, calls }),
    });
    assert.equal(report.ok, false);
    assert.equal(report.unsignedBuild, false);
    assert.equal(calls.some((url) => url.endsWith("/deposit/build")), false);
  });

  it("requires a key and does not touch the network without one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-key-"));
    await assert.rejects(
      () =>
        runPreflight(config(dir, null), {
          fetchImpl: async () => {
            throw new Error("network was called");
          },
        }),
      /EDEN_PRIVATE_KEY/,
    );
  });
});

describe("paid retry", () => {
  it("signs paymentId first and retries nonce once on the buyer-key 403, without a second deposit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retry-on-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const txHash = `0x${"ab".repeat(32)}`;
    const paymentResponse = Buffer.from(readFileSync(join(fixtureDir, "payment-response.json"), "utf8")).toString("base64");
    const rejected = jsonResponse(fixtureJson("paid-403.json"), 403);
    const paid = jsonResponse(fixtureJson("paid-200.json"), 200, { "payment-response": paymentResponse });
    const { fetchImpl, calls } = scripted([
      () => jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId }),
      () => depositSend(fresh, txHash, { deprecation: "true" }),
      () => depositStatus(txHash),
      () => rejected,
      () => paid,
    ]);
    const notes: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      notes.push(args.map((arg) => String(arg)).join(" "));
    };
    let result: Awaited<ReturnType<typeof payAndComplete>>;
    try {
      result = await payAndComplete({
        cfg: config(dir, wallet.privateKey, { HOUSTON_RETRY_OTHER_SIGN_FIELD: "1" }),
        quote: fresh.quote,
        messages: [{ role: "user", content: "hi" }],
        committedWei: 0n,
        fetchImpl,
      });
    } finally {
      console.log = original;
    }
    assert.equal(result.signFieldUsed, "nonce");
    assert.equal(result.costTia, "9147039588615");
    assert.equal(result.costUsd, "[redacted]");
    assert.equal(result.tiaCharged, "9147039588615");
    assert.equal(result.paymentResponseDecoded?.success, true);
    assert.equal(result.paymentResponseDecoded?.network, "eip155:714");
    assert.equal(result.paymentResponseDecoded?.payer, "[redacted]");
    assert.equal(result.paymentResponseDecoded?.amount, null);
    assert.match(notes.join("\n"), /deprecation header \(true\)/);
    assert.equal(count(calls, "/deposit/build"), 1);
    assert.equal(count(calls, "/deposit/send"), 1);
    const chats = calls.filter((call) => call.url.includes("/chat/completions"));
    assert.equal(chats.length, 2);
    const firstCall = chats[0];
    const secondCall = chats[1];
    if (!firstCall || !secondCall) throw new Error("expected two paid retries");
    const first = JSON.parse(Buffer.from(headerOf(firstCall, "payment-signature"), "base64").toString("utf8")) as {
      payload: { signature: string };
    };
    const second = JSON.parse(Buffer.from(headerOf(secondCall, "payment-signature"), "base64").toString("utf8")) as {
      payload: { signature: string };
    };
    assert.equal(
      recoverPersonalSigner(getBytes(fresh.paymentId), first.payload.signature).toLowerCase(),
      wallet.address.toLowerCase(),
    );
    assert.equal(recoverPersonalSigner(getBytes(fresh.nonce), second.payload.signature).toLowerCase(), wallet.address.toLowerCase());
  });

  it("does not try the other field unless the flag is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retry-off-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const txHash = `0x${"cd".repeat(32)}`;
    const { fetchImpl, calls } = scripted([
      () => jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId }),
      () => depositSend(fresh, txHash),
      () => depositStatus(txHash),
      () => jsonResponse(fixtureJson("paid-403.json"), 403),
    ]);
    await assert.rejects(
      () =>
        payAndComplete({
          cfg: config(dir, wallet.privateKey),
          quote: fresh.quote,
          messages: [{ role: "user", content: "hi" }],
          committedWei: 0n,
          fetchImpl,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /HOUSTON_RETRY_OTHER_SIGN_FIELD/);
        assert.match(error.message, /payment id already used/);
        assert.match(error.message, /signed paymentId/);
        return true;
      },
    );
    assert.equal(count(calls, "/deposit/send"), 1);
    assert.equal(count(calls, "/chat/completions"), 1);
  });

  it("does not flip the sign field on a 500, a missing-header 402, or an unrelated 403", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retry-500-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const serverError = scripted([
      () => jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId }),
      () => depositSend(fresh, `0x${"ef".repeat(32)}`),
      () => depositStatus(`0x${"ef".repeat(32)}`),
      () => jsonResponse({ error: { message: "invalid signature" } }, 500),
    ]);
    await assert.rejects(
      () =>
        payAndComplete({
          cfg: config(dir, wallet.privateKey, { HOUSTON_RETRY_OTHER_SIGN_FIELD: "1" }),
          quote: fresh.quote,
          messages: [{ role: "user", content: "hi" }],
          committedWei: 0n,
          fetchImpl: serverError.fetchImpl,
        }),
      /not classified as an invalid signature/,
    );
    assert.equal(count(serverError.calls, "/chat/completions"), 1);
    assert.equal(count(serverError.calls, "/deposit/send"), 1);

    const missing = scripted([
      () => jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId }),
      () => depositSend(fresh, `0x${"11".repeat(32)}`),
      () => depositStatus(`0x${"11".repeat(32)}`),
      () =>
        jsonResponse({ message: "Payment-Signature header is required" }, 402, {
          "payment-required": fresh.header,
        }),
    ]);
    await assert.rejects(
      () =>
        payAndComplete({
          cfg: config(dir, wallet.privateKey, { HOUSTON_RETRY_OTHER_SIGN_FIELD: "1" }),
          quote: fresh.quote,
          messages: [{ role: "user", content: "hi" }],
          committedWei: 0n,
          fetchImpl: missing.fetchImpl,
        }),
      /not classified as an invalid signature/,
    );
    assert.equal(count(missing.calls, "/deposit/send"), 1);
    assert.equal(count(missing.calls, "/chat/completions"), 1);

    const busy = scripted([
      () => jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId }),
      () => depositSend(fresh, `0x${"22".repeat(32)}`),
      () => depositStatus(`0x${"22".repeat(32)}`),
      () => jsonResponse({ error: { message: "busy", type: "inference_error" } }, 403),
    ]);
    await assert.rejects(
      () =>
        payAndComplete({
          cfg: config(dir, wallet.privateKey, { HOUSTON_RETRY_OTHER_SIGN_FIELD: "1" }),
          quote: fresh.quote,
          messages: [{ role: "user", content: "hi" }],
          committedWei: 0n,
          fetchImpl: busy.fetchImpl,
        }),
      /not classified as an invalid signature/,
    );
    assert.equal(count(busy.calls, "/deposit/send"), 1);
    assert.equal(count(busy.calls, "/chat/completions"), 1);
  });
});

describe("live trace", () => {
  it("redacts the private key and keeps the signed transaction", () => {
    const key = Wallet.createRandom().privateKey;
    const redacted = redactSecrets({ privateKey: key, signedTx: "0x02abcd", nested: `leak ${key}` }, [key]);
    assert.equal(JSON.stringify(redacted).toLowerCase().includes(key.slice(2).toLowerCase()), false);
    assert.equal(redacted.signedTx, "0x02abcd");
    assert.equal(redacted.privateKey, "[redacted]");
    const withHeader = redactSecrets(
      {
        request: { headers: { authorization: "Bearer secret-token-value" } },
        authorization: "gate-authorization-bytes",
      },
      ["secret-token-value"],
    );
    assert.equal(withHeader.request.headers.authorization, "[redacted]");
    assert.equal(withHeader.authorization, "gate-authorization-bytes");
  });

  it("writes the paid-flow exchanges and not the private key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const wallet = Wallet.createRandom();
    const fresh = freshQuote();
    const txHash = `0x${"ab".repeat(32)}`;
    const paymentResponse = Buffer.from(readFileSync(join(fixtureDir, "payment-response.json"), "utf8")).toString("base64");
    let chats = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        chats += 1;
        if (chats === 1) {
          return jsonResponse({ error: "Payment Required", leak: wallet.privateKey }, 402, {
            "payment-required": fresh.header,
          });
        }
        return jsonResponse(fixtureJson("paid-200.json"), 200, { "payment-response": paymentResponse });
      }
      if (url.endsWith("/deposit/build")) return jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId });
      if (url.endsWith("/deposit/send")) return depositSend(fresh, txHash, { deprecation: "true" });
      if (url.includes("/deposit/status/")) return depositStatus(txHash);
      throw new Error(`unexpected ${url}`);
    };
    const notes: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      notes.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      await runDemo(config(dir, wallet.privateKey, { DEMO_MODE: "live" }), fetchImpl);
    } finally {
      console.log = original;
    }
    const traces = readdirSync(join(dir, "traces"));
    assert.equal(traces.length, 1);
    const file = readFileSync(join(dir, "traces", traces[0] ?? ""), "utf8");
    assert.equal(file.toLowerCase().includes(wallet.privateKey.slice(2).toLowerCase()), false);
    const trace = JSON.parse(file) as {
      signField: string;
      exchanges: Array<{
        step: string;
        request: { headers: Record<string, string>; body: { signedTx?: string; paymentId?: string } | null };
        response: {
          status: number;
          headers: Record<string, string>;
          body: { txHash?: string; paymentId?: string; houston?: { cost_tia?: string } } | null;
        };
      }>;
    };
    assert.equal(trace.signField, "paymentId");
    assert.deepEqual(
      trace.exchanges.map((exchange) => exchange.step),
      ["quote", "deposit-build", "deposit-send", "deposit-status", "paid-retry:paymentId"],
    );
    const quote = trace.exchanges[0];
    const sent = trace.exchanges[2];
    const status = trace.exchanges[3];
    const retry = trace.exchanges[4];
    assert.ok(quote && sent && status && retry);
    assert.equal(quote.response.headers["payment-required"], fresh.header);
    assert.equal(sent.request.body?.paymentId, fresh.paymentId);
    assert.match(sent.request.body?.signedTx ?? "", /^0x02/);
    assert.equal(sent.response.headers.deprecation, "true");
    assert.equal(sent.response.body?.txHash, txHash);
    assert.equal(sent.response.body?.paymentId, fresh.paymentId);
    assert.equal(status.response.body?.txHash, txHash);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.response.body?.houston?.cost_tia, "9147039588615");
    assert.equal(retry.request.headers["payment-signature"]?.length > 0, true);
    assert.equal(retry.response.headers["payment-response"], paymentResponse);
    assert.equal(file.includes("signedTx"), true);
    assert.equal(file.includes("x-shipyard-trace-step"), false);
    const printed = notes.join("\n");
    assert.match(printed, /deprecation header \(true\)/);
    assert.match(printed, /payment-response: success true, network eip155:714, payer \[redacted\]/);
    assert.match(printed, /houston cost_tia: .* \(9147039588615 wei\), cost_usd \[redacted\]/);
    assert.match(printed, /tiaCharged: 9147039588615 wei/);
    const receipts = readFileSync(join(dir, "receipts.jsonl"), "utf8");
    assert.match(receipts, /"tiaCharged":"9147039588615"/);
    assert.equal(receipts.toLowerCase().includes(wallet.privateKey.slice(2).toLowerCase()), false);
  });
});
