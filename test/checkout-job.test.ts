import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Interface, Wallet } from "ethers";
import { loadConfig, type Config } from "../src/config.ts";
import { NATIVE_ESCROW } from "../src/eden.ts";
import { fulfillCheckout } from "../src/fulfill.ts";
import { parsePaymentRequired, type ParsedQuote } from "../src/houston.ts";
import { claimJob, readJob, renderSuccess, taskFromArgv, taskFromSession } from "../src/jobs.ts";
import { appendReceipt, readReceiptLines } from "../src/receipts.ts";
import { createCheckout, recordSale, settleJobs, startWebhook, stripePaymentId } from "../src/stripe.ts";
import { describeCheckoutJobs, verifyReceipts } from "../src/verify.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function signedBody(secret: string, body: string): { body: string; header: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return { body, header: `t=${timestamp},v1=${signature}` };
}

function completedEvent(input: {
  id: string;
  paymentIntent?: string;
  task?: string;
  customTask?: string;
  livemode?: boolean;
  paymentStatus?: string;
}): string {
  return JSON.stringify({
    type: "checkout.session.completed",
    data: {
      object: {
        id: input.id,
        payment_intent: input.paymentIntent ?? "pi_test_123",
        amount_total: 500,
        currency: "gbp",
        client_reference_id: "team-a",
        livemode: input.livemode ?? false,
        payment_status: input.paymentStatus ?? "paid",
        metadata: input.task ? { task: input.task } : {},
        custom_fields: input.customTask
          ? [{ key: "task", type: "text", text: { value: input.customTask } }]
          : [],
      },
    },
  });
}

async function listen(server: ReturnType<typeof startWebhook>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      resolve(address.port);
    });
    server.on("error", reject);
  });
}

function call(
  port: number,
  method: string,
  path: string,
  payload?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          type: String(res.headers["content-type"] ?? ""),
        }),
      );
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function close(server: ReturnType<typeof startWebhook>): Promise<void> {
  await settleJobs(server);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("checkout task", () => {
  it("reads --task, one positional, and rejects two", () => {
    assert.equal(taskFromArgv(["node", "checkout.ts"]), null);
    assert.equal(taskFromArgv(["node", "checkout.ts", "--task", "write a haiku"]), "write a haiku");
    assert.equal(taskFromArgv(["node", "checkout.ts", "write a haiku"]), "write a haiku");
    assert.throws(() => taskFromArgv(["node", "checkout.ts", "--task"]), /Usage/);
    assert.throws(() => taskFromArgv(["node", "checkout.ts", "one", "two"]), /one task/);
    assert.throws(() => taskFromArgv(["node", "checkout.ts", "--task", ""]), /empty|Usage/);
  });

  it("prefers the custom field over metadata", () => {
    assert.equal(taskFromSession({ metadata: { task: "from cli" }, custom_fields: [] }), "from cli");
    assert.equal(
      taskFromSession({
        metadata: { task: "from cli" },
        custom_fields: [{ key: "task", text: { value: "from the page" } }],
      }),
      "from the page",
    );
    assert.match(taskFromSession({}), /GBP/);
  });

  it("puts the CLI task in metadata and leaves the page field optional", async () => {
    const cfg = loadConfig({ STRIPE_SECRET_KEY: "sk_test_example" });
    let body = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ id: "cs_test_task", url: "https://checkout.stripe.com/pay/cs_test_task" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await createCheckout(cfg, fetchImpl, "write a haiku");
    const params = new URLSearchParams(body);
    assert.equal(params.get("metadata[task]"), "write a haiku");
    assert.equal(params.get("custom_fields[0][optional]"), "true");
    assert.equal(params.get("custom_fields[0][label][custom]"), "What should the agent do");
    assert.equal(params.get("success_url"), "http://localhost:8787/success?session_id={CHECKOUT_SESSION_ID}");
  });

  it("reads an expanded payment intent id", () => {
    assert.equal(stripePaymentId({ payment_intent: { id: "pi_test_expanded" } }), "pi_test_expanded");
  });
});

describe("success page", () => {
  it("escapes the result and says when the job is still running", () => {
    const running = renderSuccess({
      sessionId: "cs_test_123",
      job: {
        checkoutId: "cs_test_123",
        stripePaymentId: "pi_test_123",
        task: "<script>",
        livemode: false,
        dryRun: true,
        status: "running",
        result: null,
        error: null,
        requestId: null,
        createdAt: "2026-10-24T00:00:00.000Z",
        finishedAt: null,
      },
    });
    assert.match(running, /Working on it\. Refresh this page/);
    assert.match(running, /not revenue/);
    assert.equal(running.includes("<script>"), false);
    assert.match(running, /mock inference/);

    const done = renderSuccess({
      sessionId: "cs_test_123",
      job: {
        checkoutId: "cs_test_123",
        stripePaymentId: "pi_test_123",
        task: "haiku",
        livemode: false,
        dryRun: true,
        status: "done",
        result: "Mock <b>result</b>",
        error: null,
        requestId: "dry-run:cs_test_123",
        createdAt: "2026-10-24T00:00:00.000Z",
        finishedAt: "2026-10-24T00:00:01.000Z",
      },
    });
    assert.match(done, /Mock &lt;b&gt;result&lt;\/b&gt;/);
    assert.match(done, /No Houston call/);
    assert.equal(done.includes("http-equiv"), false);
  });
});

describe("paid checkout", () => {
  it("runs mock inference once, shows it on /success, and links the receipts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-dry-"));
    const secret = "whsec_test";
    const cfg = loadConfig({
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      POSTS_PATH: join(dir, "posts.json"),
      JOBS_PATH: join(dir, "jobs.json"),
      STRIPE_WEBHOOK_SECRET: secret,
      DEMO_MODE: "dry-run",
    });
    let fetches = 0;
    const server = startWebhook(cfg, {
      fetchImpl: async () => {
        fetches += 1;
        throw new Error("dry-run called the network");
      },
    });
    const port = await listen(server);
    try {
      const early = await call(port, "GET", "/success?session_id=cs_test_job");
      assert.match(early.body, /Working on it\. Refresh this page/);
      assert.match(early.body, /not revenue/);

      const raw = completedEvent({ id: "cs_test_job", paymentIntent: "pi_test_job", task: "write a haiku" });
      const first = signedBody(secret, raw);
      const paid = await call(port, "POST", "/webhook", first.body, {
        "content-type": "application/json",
        "stripe-signature": first.header,
      });
      assert.deepEqual(JSON.parse(paid.body), { received: true, job: "started" });
      await settleJobs(server);

      const again = signedBody(secret, raw);
      const resent = await call(port, "POST", "/webhook", again.body, {
        "content-type": "application/json",
        "stripe-signature": again.header,
      });
      assert.deepEqual(JSON.parse(resent.body), { received: true, job: "exists" });
      await settleJobs(server);

      assert.equal(fetches, 0);
      const lines = readReceiptLines(cfg.receiptsPath);
      assert.equal(lines.length, 2);
      const sale = JSON.parse(lines[0] ?? "") as { type: string; checkoutId: string; paymentId: string; task: string; livemode: boolean };
      const inference = JSON.parse(lines[1] ?? "") as {
        type: string;
        checkoutId: string;
        stripePaymentId: string;
        dryRun: boolean;
        tiaCharged: null;
        requestId: string;
      };
      assert.equal(sale.type, "sale");
      assert.equal(sale.checkoutId, "cs_test_job");
      assert.equal(sale.paymentId, "pi_test_job");
      assert.equal(sale.task, "write a haiku");
      assert.equal(sale.livemode, false);
      assert.equal(inference.type, "inference");
      assert.equal(inference.checkoutId, sale.checkoutId);
      assert.equal(inference.stripePaymentId, sale.paymentId);
      assert.equal(inference.dryRun, true);
      assert.equal(inference.tiaCharged, null);
      assert.equal(inference.requestId, "dry-run:cs_test_job");

      const job = readJob(cfg.jobsPath, "cs_test_job");
      assert.equal(job?.status, "done");
      assert.match(job?.result ?? "", /Mock inference/);
      assert.match(job?.result ?? "", /write a haiku/);
      assert.equal(JSON.stringify(job).includes("sk_"), false);

      const page = await call(port, "GET", "/success?session_id=cs_test_job");
      assert.match(page.body, /write a haiku/);
      assert.match(page.body, /Mock inference/);
      assert.match(page.body, /not revenue/);
      assert.equal(page.body.includes("http-equiv"), false);

      const notes = await verifyReceipts(cfgEnv(cfg), async () => {
        throw new Error("verify should not call Mocha");
      }, async () => {
        throw new Error("verify should not spawn the helper");
      });
      const text = notes.join("\n");
      assert.match(text, /£5.00 in \(livemode false, not revenue\)/);
      assert.match(text, /TIA not charged \(dry-run mock, no Houston call\)/);
      assert.match(text, /Stripe payment pi_test_job is on both receipts/);
      assert.match(text, /No Mocha posts recorded/);
    } finally {
      await close(server);
    }
  });

  it("does not start a second job while the first is still running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-gate-"));
    const secret = "whsec_test";
    const cfg = loadConfig({
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      JOBS_PATH: join(dir, "jobs.json"),
      STRIPE_WEBHOOK_SECRET: secret,
    });
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = startWebhook(cfg, {
      runJob: async () => {
        started += 1;
        await gate;
      },
    });
    const port = await listen(server);
    try {
      const raw = completedEvent({ id: "cs_test_gate", customTask: "from <the> page", task: "from cli" });
      const post = async () => {
        const signed = signedBody(secret, raw);
        return call(port, "POST", "/webhook", signed.body, {
          "content-type": "application/json",
          "stripe-signature": signed.header,
        });
      };
      const first = await post();
      assert.equal(JSON.parse(first.body).job, "started");
      const working = await call(port, "GET", "/success?session_id=cs_test_gate");
      assert.match(working.body, /Working on it\. Refresh this page/);
      assert.match(working.body, /from &lt;the&gt; page/);
      assert.equal(working.body.includes("<the>"), false);
      const second = await post();
      assert.equal(JSON.parse(second.body).job, "exists");
      assert.equal(started, 1);
      assert.equal(readReceiptLines(cfg.receiptsPath).length, 1);
      release();
      await settleJobs(server);
    } finally {
      release();
      await close(server);
    }
  });

  it("ignores an unpaid session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-unpaid-"));
    const secret = "whsec_test";
    const cfg = loadConfig({
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      JOBS_PATH: join(dir, "jobs.json"),
      STRIPE_WEBHOOK_SECRET: secret,
    });
    const server = startWebhook(cfg, {
      runJob: async () => {
        throw new Error("unpaid session started a job");
      },
    });
    const port = await listen(server);
    try {
      const raw = completedEvent({ id: "cs_test_unpaid", paymentStatus: "unpaid" });
      const signed = signedBody(secret, raw);
      const res = await call(port, "POST", "/webhook", signed.body, {
        "content-type": "application/json",
        "stripe-signature": signed.header,
      });
      assert.deepEqual(JSON.parse(res.body), { received: true, ignored: true });
      assert.equal(readReceiptLines(cfg.receiptsPath).length, 0);
      assert.equal(readJob(cfg.jobsPath, "cs_test_unpaid"), null);
    } finally {
      await close(server);
    }
  });

  it("does not call Houston twice for one live checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-live-"));
    const wallet = Wallet.createRandom();
    const secret = "whsec_test";
    const fresh = freshQuote();
    const txHash = `0x${"ab".repeat(32)}`;
    const paymentResponse = Buffer.from(readFileSync(join(fixtureDir, "payment-response.json"), "utf8")).toString("base64");
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      const body = typeof init?.body === "string" ? init.body : "";
      if (url.endsWith("/chat/completions")) {
        const chatCount = calls.filter((item) => item.endsWith("/chat/completions")).length;
        const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
        assert.equal(parsed.messages?.[0]?.content, "name a price");
        if (chatCount === 1) {
          return jsonResponse({ error: "Payment Required" }, 402, { "payment-required": fresh.header });
        }
        return jsonResponse(JSON.parse(readFileSync(join(fixtureDir, "paid-200.json"), "utf8")), 200, {
          "payment-response": paymentResponse,
        });
      }
      if (url.endsWith("/deposit/build")) return jsonResponse({ txData: fresh.tx, paymentId: fresh.paymentId });
      if (url.endsWith("/deposit/send")) return jsonResponse({ txHash, paymentId: fresh.paymentId });
      if (url.includes("/deposit/status/")) return jsonResponse({ txHash, status: "confirmed" });
      throw new Error(`unexpected ${url}`);
    };
    const cfg = loadConfig({
      DEMO_MODE: "live",
      EDEN_PRIVATE_KEY: wallet.privateKey,
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      POSTS_PATH: join(dir, "posts.json"),
      JOBS_PATH: join(dir, "jobs.json"),
      TRACE_DIR: join(dir, "traces"),
      STRIPE_WEBHOOK_SECRET: secret,
      SPEND_CAP_TIA: "0.05",
    });
    const server = startWebhook(cfg, { fetchImpl });
    const port = await listen(server);
    try {
      const raw = completedEvent({ id: "cs_test_live", paymentIntent: "pi_test_live", task: "name a price" });
      const post = async () => {
        const signed = signedBody(secret, raw);
        return call(port, "POST", "/webhook", signed.body, {
          "content-type": "application/json",
          "stripe-signature": signed.header,
        });
      };
      assert.equal(JSON.parse((await post()).body).job, "started");
      await settleJobs(server);
      assert.equal(JSON.parse((await post()).body).job, "exists");
      await settleJobs(server);

      assert.equal(calls.filter((url) => url.endsWith("/deposit/send")).length, 1);
      assert.equal(calls.filter((url) => url.endsWith("/chat/completions")).length, 2);
      const lines = readReceiptLines(cfg.receiptsPath);
      assert.equal(lines.length, 2);
      const inference = JSON.parse(lines[1] ?? "") as {
        dryRun: boolean;
        tiaCharged: string;
        checkoutId: string;
        stripePaymentId: string;
        requestId: string;
      };
      assert.equal(inference.dryRun, false);
      assert.equal(inference.tiaCharged, "9147039588615");
      assert.equal(inference.checkoutId, "cs_test_live");
      assert.equal(inference.stripePaymentId, "pi_test_live");
      assert.equal(inference.requestId, fresh.paymentId);
      const job = readJob(cfg.jobsPath, "cs_test_live");
      assert.equal(job?.status, "done");
      assert.equal(job?.result, "[redacted]");
      const dumped = `${readFileSync(cfg.jobsPath, "utf8")}\n${readFileSync(cfg.receiptsPath, "utf8")}`;
      assert.equal(dumped.toLowerCase().includes(wallet.privateKey.slice(2).toLowerCase()), false);
      const notes = describeCheckoutJobs(lines);
      assert.match(notes.join("\n"), /TIA charged/);
      assert.match(notes.join("\n"), /9147039588615 wei/);
      assert.match(notes.join("\n"), /not revenue/);
      assert.match(notes.join("\n"), /pi_test_live is on both receipts/);
    } finally {
      await close(server);
    }
  });

  it("fails a live job with no key and does not call the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-nokey-"));
    const cfg = loadConfig({
      DEMO_MODE: "live",
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      JOBS_PATH: join(dir, "jobs.json"),
      TRACE_DIR: join(dir, "traces"),
    });
    const { job } = claimJob(cfg.jobsPath, {
      checkoutId: "cs_test_nokey",
      stripePaymentId: "pi_test_nokey",
      task: "hello",
      livemode: false,
      dryRun: false,
    });
    await fulfillCheckout(cfg, job, async () => {
      throw new Error("network was called");
    });
    const saved = readJob(cfg.jobsPath, "cs_test_nokey");
    assert.equal(saved?.status, "failed");
    assert.match(saved?.error ?? "", /EDEN_PRIVATE_KEY/);
    assert.equal(readReceiptLines(cfg.receiptsPath).length, 0);
  });

  it("does not deposit again when the inference receipt is already there", async () => {
    const dir = mkdtempSync(join(tmpdir(), "job-prior-"));
    const cfg = loadConfig({
      DEMO_MODE: "live",
      EDEN_PRIVATE_KEY: Wallet.createRandom().privateKey,
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      JOBS_PATH: join(dir, "jobs.json"),
    });
    appendReceipt(cfg.receiptsPath, {
      type: "inference",
      requestId: "0x" + "11".repeat(32),
      model: "qwen/qwen-flash",
      tokensIn: 1,
      tokensOut: 1,
      tiaCharged: "10",
      tiaQuoted: "20",
      escrow: NATIVE_ESCROW,
      depositTxHash: "0x" + "22".repeat(32),
      paymentHeaderSha256: "aa",
      quoteHeaderSha256: "bb",
      dryRun: false,
      checkoutId: "cs_test_prior",
      stripePaymentId: "pi_test_prior",
    });
    recordSale(cfg, {
      id: "cs_test_prior",
      payment_intent: "pi_test_prior",
      amount_total: 500,
      currency: "gbp",
      livemode: true,
    });
    recordSale(cfg, {
      id: "cs_test_prior",
      payment_intent: "pi_test_prior",
      amount_total: 500,
      currency: "gbp",
      livemode: true,
    });
    assert.equal(readReceiptLines(cfg.receiptsPath).filter((line) => line.includes('"type":"sale"')).length, 1);
    const { job } = claimJob(cfg.jobsPath, {
      checkoutId: "cs_test_prior",
      stripePaymentId: "pi_test_prior",
      task: "again",
      livemode: true,
      dryRun: false,
    });
    await fulfillCheckout(cfg, job, async () => {
      throw new Error("network was called");
    });
    const saved = readJob(cfg.jobsPath, "cs_test_prior");
    assert.equal(saved?.status, "done");
    assert.equal(readReceiptLines(cfg.receiptsPath).filter((line) => line.includes('"type":"inference"')).length, 1);
    const notes = describeCheckoutJobs(readReceiptLines(cfg.receiptsPath));
    assert.match(notes.join("\n"), /livemode true/);
    assert.match(notes.join("\n"), /Only an outside customer paying in live mode is revenue/);
    assert.match(notes.join("\n"), /pi_test_prior is on both receipts/);
  });
});

function cfgEnv(cfg: Config): NodeJS.ProcessEnv {
  return {
    RECEIPTS_PATH: cfg.receiptsPath,
    POSTS_PATH: cfg.postsPath,
    JOBS_PATH: cfg.jobsPath,
    DEMO_MODE: cfg.mode,
  };
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

function freshQuote(): {
  header: string;
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
  paymentId: string;
} {
  const raw = JSON.parse(readFileSync(join(fixtureDir, "payment-required.json"), "utf8")) as {
    accepts: Array<{ extra: { expiresAt: number; refundAfter: number } }>;
  };
  const accept = raw.accepts[0];
  if (!accept) throw new Error("fixture missing accept");
  const now = Math.floor(Date.now() / 1000);
  accept.extra.expiresAt = now + 3600;
  accept.extra.refundAfter = now + 8 * 24 * 3600;
  const header = Buffer.from(JSON.stringify(raw)).toString("base64");
  const quote: ParsedQuote = parsePaymentRequired(header, {}, NATIVE_ESCROW);
  const extra = quote.accepted.extra;
  const deposit = new Interface([
    "function deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd) payable",
  ]);
  return {
    header,
    tx: {
      to: NATIVE_ESCROW,
      data: deposit.encodeFunctionData("deposit", [
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
    paymentId: extra.paymentId,
  };
}
