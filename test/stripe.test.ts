import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { readReceiptLines } from "../src/receipts.ts";
import { recordSale, verifyStripeSignature } from "../src/stripe.ts";

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
});
