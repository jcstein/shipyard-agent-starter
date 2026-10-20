import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { gbpFromPence, penceFromGbp } from "./money.ts";
import { appendReceipt } from "./receipts.ts";

const TOLERANCE_SECONDS = 300;

export function verifyStripeSignature(rawBody: string, header: string, secret: string, nowMs = Date.now()): boolean {
  const parts = header.split(",").map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  const age = Math.abs(nowMs / 1000 - Number(timestamp));
  if (age > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected);
  return signatures.some((signature) => {
    const actual = Buffer.from(signature);
    return actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf);
  });
}

type CheckoutSession = {
  id?: string;
  url?: string | null;
  payment_intent?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  livemode?: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function createCheckout(cfg: Config, fetchImpl: typeof fetch = fetch): Promise<{ id: string; url: string }> {
  if (!cfg.stripeSecret) throw new Error("STRIPE_SECRET_KEY is required (use a test-mode sk_test_ key until you mean to charge customers)");
  const pence = penceFromGbp(cfg.stripeAmountGbp);
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", cfg.successUrl);
  form.set("cancel_url", cfg.cancelUrl);
  form.set("client_reference_id", cfg.customerRef);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(pence));
  form.set("line_items[0][price_data][product_data][name]", "SHIPYARD agent service");
  form.set(
    "line_items[0][price_data][product_data][description]",
    "GBP checkout. Test-mode payments are not revenue.",
  );
  const res = await fetchImpl("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.stripeSecret}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json()) as CheckoutSession & { error?: { message?: string } };
  if (!res.ok || !body.id || !body.url) {
    throw new Error(`Stripe checkout failed: ${body.error?.message ?? res.statusText}`);
  }
  return { id: body.id, url: body.url };
}

export function recordSale(cfg: Config, session: CheckoutSession): void {
  if (!session.id) throw new Error("checkout session has no id");
  const currency = (session.currency ?? "gbp").toUpperCase();
  if (currency !== "GBP") throw new Error(`expected GBP, got ${currency}`);
  appendReceipt(cfg.receiptsPath, {
    type: "sale",
    checkoutId: session.id,
    paymentId: typeof session.payment_intent === "string" ? session.payment_intent : null,
    amount: gbpFromPence(session.amount_total ?? 0),
    currency: "GBP",
    customerRef: session.client_reference_id ?? cfg.customerRef,
    livemode: session.livemode === true,
    note: session.livemode === true ? undefined : "Stripe test mode. This charge is not revenue.",
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function startWebhook(cfg: Config): ReturnType<typeof createServer> {
  if (!cfg.stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || (req.url ?? "/").split("?")[0] !== "/webhook") {
        send(res, 404, { error: "not found" });
        return;
      }
      const raw = await readBody(req);
      const header = req.headers["stripe-signature"];
      if (typeof header !== "string" || !verifyStripeSignature(raw, header, cfg.stripeWebhookSecret ?? "")) {
        send(res, 400, { error: "bad signature" });
        return;
      }
      const event = JSON.parse(raw) as { type?: string; data?: { object?: unknown } };
      if (event.type !== "checkout.session.completed" || !isRecord(event.data?.object)) {
        send(res, 200, { received: true, ignored: true });
        return;
      }
      recordSale(cfg, event.data.object as CheckoutSession);
      send(res, 200, { received: true });
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "webhook failed";
      send(res, 400, { error: message });
    });
  });
  return server;
}
