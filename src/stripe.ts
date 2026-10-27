import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { fulfillCheckout } from "./fulfill.ts";
import { claimJob, readJob, renderSuccess, taskFromSession, type Job, type SessionTaskSource } from "./jobs.ts";
import type { ReceiptPostDeps } from "./mocha.ts";
import { gbpFromPence, penceFromGbp } from "./money.ts";
import { appendReceipt, findByCheckout } from "./receipts.ts";

const TOLERANCE_SECONDS = 300;
const inflight = new WeakMap<Server, Set<Promise<void>>>();

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

type CheckoutSession = SessionTaskSource & {
  id?: string;
  url?: string | null;
  payment_intent?: string | { id?: string } | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  livemode?: boolean;
  payment_status?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Stripe substitutes this placeholder. It must survive form decoding as raw braces. */
export function withCheckoutSessionId(url: string): string {
  if (url.includes("{CHECKOUT_SESSION_ID}")) return url;
  const join = url.includes("?") ? "&" : "?";
  return `${url}${join}session_id={CHECKOUT_SESSION_ID}`;
}

export function stripePaymentId(session: CheckoutSession): string | null {
  const payment = session.payment_intent;
  if (typeof payment === "string" && payment.length > 0) return payment;
  if (isRecord(payment) && typeof payment.id === "string" && payment.id.length > 0) return payment.id;
  return null;
}

export async function createCheckout(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
  task: string | null = null,
): Promise<{ id: string; url: string }> {
  if (!cfg.stripeSecret) throw new Error("STRIPE_SECRET_KEY is required (use a test-mode sk_test_ key until you mean to charge customers)");
  const pence = penceFromGbp(cfg.stripeAmountGbp);
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", withCheckoutSessionId(cfg.successUrl));
  form.set("cancel_url", cfg.cancelUrl);
  form.set("client_reference_id", cfg.customerRef);
  form.set("line_items[0][quantity]", "1");
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(pence));
  form.set("line_items[0][price_data][product_data][name]", "SHIPYARD agent service");
  form.set(
    "line_items[0][price_data][product_data][description]",
    "The agent runs your task after payment. Test-mode payments are not revenue.",
  );
  // New Stripe accounts enable Managed Payments by default, which rejects a
  // line item that has no product tax code. This session opts out.
  form.set("managed_payments[enabled]", "false");
  // The page asks when the CLI did not. A typed value wins over metadata.
  form.set("custom_fields[0][key]", "task");
  form.set("custom_fields[0][label][type]", "custom");
  form.set("custom_fields[0][label][custom]", "What should the agent do");
  form.set("custom_fields[0][type]", "text");
  form.set("custom_fields[0][optional]", task ? "true" : "false");
  form.set("custom_fields[0][text][maximum_length]", "255");
  if (task) form.set("metadata[task]", task);
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

export function recordSale(cfg: Config, session: CheckoutSession, task?: string): void {
  if (!session.id) throw new Error("checkout session has no id");
  if (findByCheckout(cfg.receiptsPath, "sale", session.id)) return;
  const currency = (session.currency ?? "gbp").toUpperCase();
  if (currency !== "GBP") throw new Error(`expected GBP, got ${currency}`);
  appendReceipt(cfg.receiptsPath, {
    type: "sale",
    checkoutId: session.id,
    paymentId: stripePaymentId(session),
    amount: gbpFromPence(session.amount_total ?? 0),
    currency: "GBP",
    customerRef: session.client_reference_id ?? cfg.customerRef,
    livemode: session.livemode === true,
    ...(task ? { task } : {}),
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
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendPage(res: ServerResponse, title: string, message: string): void {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><p>${message} Test-mode payments are not revenue.</p>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sessionIdFrom(url: string): string | null {
  const query = url.split("?")[1] ?? "";
  const id = new URLSearchParams(query).get("session_id");
  if (!id || id.length > 255 || !/^cs_[A-Za-z0-9_]+$/.test(id)) return null;
  return id;
}

function track(server: Server, pending: Promise<void>): void {
  let set = inflight.get(server);
  if (!set) {
    set = new Set();
    inflight.set(server, set);
  }
  const jobs = set;
  jobs.add(pending);
  void pending.finally(() => jobs.delete(pending));
}

/** Resolves when checkout jobs started by this server have finished. */
export function settleJobs(server: Server): Promise<void> {
  const set = inflight.get(server);
  if (!set || set.size === 0) return Promise.resolve();
  return Promise.all([...set]).then(() => settleJobs(server));
}

export type WebhookOptions = {
  fetchImpl?: typeof fetch;
  runJob?: (cfg: Config, job: Job) => Promise<void>;
  /** Mocha submit used after a job finishes. Tests pass a fake helper here. */
  postDeps?: ReceiptPostDeps;
};

export function startWebhook(cfg: Config, options: WebhookOptions = {}): Server {
  if (!cfg.stripeWebhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");
  const runJob =
    options.runJob ??
    ((config, job) => fulfillCheckout(config, job, options.fetchImpl ?? fetch, options.postDeps));
  const server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";
      const path = url.split("?")[0];
      if (req.method === "GET" && path === "/success") {
        const sessionId = sessionIdFrom(url);
        const job = sessionId ? readJob(cfg.jobsPath, sessionId) : null;
        const html = renderSuccess({ sessionId, job });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "GET" && path === "/cancel") {
        sendPage(res, "Checkout cancelled", "Checkout cancelled.");
        return;
      }
      if (req.method !== "POST" || path !== "/webhook") {
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
      const session = event.data.object as CheckoutSession;
      if (session.payment_status === "unpaid") {
        send(res, 200, { received: true, ignored: true });
        return;
      }
      const task = taskFromSession(session);
      recordSale(cfg, session, task);
      if (!session.id) throw new Error("checkout session has no id");
      const { job, claimed } = claimJob(cfg.jobsPath, {
        checkoutId: session.id,
        stripePaymentId: stripePaymentId(session),
        task,
        livemode: session.livemode === true,
        dryRun: cfg.mode !== "live",
      });
      // Stripe times out a slow 200, and a Houston deposit can take longer than that.
      // The claim is already on disk, so a resent event cannot start a second job.
      send(res, 200, { received: true, job: claimed ? "started" : "exists" });
      if (!claimed) return;
      const pending = runJob(cfg, job).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "job failed";
        console.error(`job ${job.checkoutId} failed: ${message}`);
      });
      track(server, pending);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "webhook failed";
      send(res, 400, { error: message });
    });
  });
  return server;
}
