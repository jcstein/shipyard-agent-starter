import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { readReceiptLines } from "../src/receipts.ts";
import { createCheckout, recordSale, settleJobs, startWebhook, verifyStripeSignature, withCheckoutSessionId } from "../src/stripe.ts";

describe("stripe", () => {
  it("checks the webhook signature", () => {
    const secret = "whsec_test";
    const body = '{"type":"checkout.session.completed"}';
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const header = `t=${timestamp},v1=${signature}`;
    assert.equal(verifyStripeSignature(body, header, secret), true);
    assert.equal(verifyStripeSignature(`${body} `, header, secret), false);
    assert.equal(verifyStripeSignature(body, `t=${timestamp - 600},v1=${signature}`, secret), false);
  });

  it("writes a test-mode sale that says it is not revenue", () => {
    const dir = mkdtempSync(join(tmpdir(), "sale-"));
    const cfg = loadConfig({ RECEIPTS_PATH: join(dir, "receipts.jsonl") });
    recordSale(cfg, {
      id: "cs_test_123",
      payment_intent: "pi_test_123",
      amount_total: 500,
      currency: "gbp",
      client_reference_id: "team-a",
      livemode: false,
    });
    const line = readReceiptLines(cfg.receiptsPath)[0] ?? "";
    const event = JSON.parse(line) as { type: string; amount: string; currency: string; livemode: boolean; note?: string };
    assert.equal(event.type, "sale");
    assert.equal(event.amount, "5.00");
    assert.equal(event.currency, "GBP");
    assert.equal(event.livemode, false);
    assert.match(event.note ?? "", /not revenue/);
  });

  it("disables managed payments on the checkout session", async () => {
    const cfg = loadConfig({ STRIPE_SECRET_KEY: "sk_test_example", STRIPE_AMOUNT_GBP: "5.00" });
    let body = "";
    let contentType = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = String(init?.body ?? "");
      contentType = new Headers(init?.headers).get("content-type") ?? "";
      return new Response(JSON.stringify({ id: "cs_test_local", url: "https://checkout.stripe.com/pay/cs_test_local" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const session = await createCheckout(cfg, fetchImpl);
    assert.equal(session.id, "cs_test_local");
    assert.equal(contentType, "application/x-www-form-urlencoded");
    const params = new URLSearchParams(body);
    assert.equal(params.get("managed_payments[enabled]"), "false");
    assert.equal(params.get("mode"), "payment");
    assert.equal(params.get("line_items[0][price_data][currency]"), "gbp");
    assert.equal(params.get("line_items[0][price_data][unit_amount]"), "500");
    assert.equal(params.get("success_url"), "http://localhost:8787/success?session_id={CHECKOUT_SESSION_ID}");
    assert.equal(params.get("custom_fields[0][key]"), "task");
    assert.equal(params.get("custom_fields[0][optional]"), "false");
    assert.equal(params.get("metadata[task]"), null);
  });

  it("keeps an existing checkout session placeholder", () => {
    assert.equal(
      withCheckoutSessionId("https://example.test/done?session_id={CHECKOUT_SESSION_ID}"),
      "https://example.test/done?session_id={CHECKOUT_SESSION_ID}",
    );
    assert.equal(withCheckoutSessionId("https://example.test/done?x=1"), "https://example.test/done?x=1&session_id={CHECKOUT_SESSION_ID}");
  });

  it("answers checkout redirects and still posts the webhook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-"));
    const secret = "whsec_test";
    const cfg = loadConfig({
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      JOBS_PATH: join(dir, "jobs.json"),
      STRIPE_WEBHOOK_SECRET: secret,
    });
    const server = startWebhook(cfg);
    const port = await new Promise<number>((resolve, reject) => {
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
    const call = (method: string, path: string, payload?: string, headers?: Record<string, string>) =>
      new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
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
    try {
      const success = await call("GET", "/success");
      assert.equal(success.status, 200);
      assert.match(success.type, /^text\/html/);
      assert.match(success.body, /Payment received/);
      assert.match(success.body, /not revenue/);

      const cancel = await call("GET", "/cancel?foo=1");
      assert.equal(cancel.status, 200);
      assert.match(cancel.body, /Checkout cancelled/);
      assert.match(cancel.body, /not revenue/);

      const missing = await call("GET", "/nope");
      assert.equal(missing.status, 404);
      assert.equal(missing.type, "application/json");
      assert.deepEqual(JSON.parse(missing.body), { error: "not found" });

      const unsigned = await call("POST", "/webhook", "{}", { "stripe-signature": "t=1,v1=nope" });
      assert.equal(unsigned.status, 400);
      assert.deepEqual(JSON.parse(unsigned.body), { error: "bad signature" });

      const raw = JSON.stringify({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_123",
            payment_intent: "pi_test_123",
            amount_total: 500,
            currency: "gbp",
            client_reference_id: "team-a",
            livemode: false,
          },
        },
      });
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
      const paid = await call("POST", "/webhook", raw, {
        "content-type": "application/json",
        "stripe-signature": `t=${timestamp},v1=${signature}`,
      });
      assert.equal(paid.status, 200);
      assert.deepEqual(JSON.parse(paid.body), { received: true, job: "started" });
      await settleJobs(server);
      const line = readReceiptLines(cfg.receiptsPath)[0] ?? "";
      const event = JSON.parse(line) as { type: string; amount: string; currency: string; livemode: boolean };
      assert.equal(event.type, "sale");
      assert.equal(event.amount, "5.00");
      assert.equal(event.currency, "GBP");
      assert.equal(event.livemode, false);
    } finally {
      await settleJobs(server);
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
