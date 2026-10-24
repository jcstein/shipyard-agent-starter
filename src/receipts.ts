import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { sha256Hex } from "./hash.ts";

export const GENESIS = "0".repeat(64);

export type SaleReceipt = {
  type: "sale";
  ts: string;
  prev: string;
  checkoutId: string;
  paymentId: string | null;
  amount: string;
  currency: "GBP";
  customerRef: string;
  livemode: boolean;
  /** What the customer asked the agent to do. */
  task?: string;
  note?: string;
};

export type InferenceReceipt = {
  type: "inference";
  ts: string;
  prev: string;
  requestId: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** Settled wei, when the server reports it. Null means this call was not charged. */
  tiaCharged: string | null;
  /** Escrow cap from the 402 quote, in wei. This is a ceiling, not revenue and not the settled cost. */
  tiaQuoted: string;
  escrow: string;
  depositTxHash: string | null;
  /** sha256 of the Payment-Signature header value. The header itself is not stored. */
  paymentHeaderSha256: string | null;
  /** sha256 of the Payment-Required header from the 402. */
  quoteHeaderSha256: string;
  dryRun: boolean;
  /** Stripe Checkout Session that bought this call. Absent on demo lines. */
  checkoutId?: string;
  /** Stripe PaymentIntent id for that session. The sale receipt stores the same id as `paymentId`. */
  stripePaymentId?: string | null;
};

export type HumanReceipt = {
  type: "human";
  ts: string;
  prev: string;
  who: string;
  what: string;
  why: string;
};

export type Receipt = SaleReceipt | InferenceReceipt | HumanReceipt;
export type NewReceipt = Omit<SaleReceipt, "ts" | "prev"> | Omit<InferenceReceipt, "ts" | "prev"> | Omit<HumanReceipt, "ts" | "prev">;

export function readReceiptLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

export function verifyHashChain(lines: string[]): void {
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    let parsed: { prev?: unknown };
    try {
      parsed = JSON.parse(line) as { prev?: unknown };
    } catch {
      throw new Error(`receipt line ${i + 1} is not JSON`);
    }
    if (parsed.prev !== prev) {
      throw new Error(`receipt line ${i + 1} breaks the hash chain`);
    }
    prev = sha256Hex(line);
  }
}

export function committedWei(lines: string[]): bigint {
  let total = 0n;
  for (const line of lines) {
    const event = JSON.parse(line) as Partial<InferenceReceipt>;
    if (event.type !== "inference" || event.dryRun) continue;
    // The cap tracks the escrow deposit (the quote), which leaves the wallet up front.
    // The settled charge can be lower. Gas on Eden is dust next to that deposit.
    if (typeof event.tiaQuoted === "string" && /^\d+$/.test(event.tiaQuoted)) {
      total += BigInt(event.tiaQuoted);
    }
  }
  return total;
}

export function findByCheckout(
  path: string,
  type: "sale" | "inference",
  checkoutId: string,
): SaleReceipt | InferenceReceipt | null {
  for (const line of readReceiptLines(path)) {
    let event: Receipt;
    try {
      event = JSON.parse(line) as Receipt;
    } catch {
      continue;
    }
    if (event.type === "sale" && type === "sale" && event.checkoutId === checkoutId) return event;
    if (event.type === "inference" && type === "inference" && event.checkoutId === checkoutId) return event;
  }
  return null;
}

export function appendReceipt(path: string, event: NewReceipt, now = new Date()): Receipt {
  const lines = readReceiptLines(path);
  const prev = lines.length === 0 ? GENESIS : sha256Hex(lines[lines.length - 1] ?? "");
  const record = { ...event, ts: now.toISOString(), prev } as Receipt;
  const line = JSON.stringify(record);
  const dir = dirname(path);
  if (dir !== "." && dir !== "") mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${line}\n`);
  return record;
}
