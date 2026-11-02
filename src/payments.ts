import { existsSync, readFileSync } from "node:fs";
import { writeJsonAtomic } from "./files.ts";
import { readReceiptLines, type InferenceReceipt } from "./receipts.ts";

type Reservation = { paymentId: string; amountWei: string; txHash: string };
type Payments = { version: 1; reservations: Reservation[] };

export function readPayments(receiptsPath: string): Payments {
  const path = `${receiptsPath}.payments.json`;
  if (!existsSync(path)) return { version: 1, reservations: [] };
  const log = JSON.parse(readFileSync(path, "utf8")) as Payments;
  if (log.version !== 1 || !Array.isArray(log.reservations) || log.reservations.some((item) =>
    !/^0x[0-9a-fA-F]{64}$/.test(item.paymentId) || !/^\d+$/.test(item.amountWei) || !/^0x[0-9a-fA-F]{64}$/.test(item.txHash))) {
    throw new Error(`Invalid payment reservations: ${path}. Spending stopped.`);
  }
  return log;
}

/** A reservation survives an uncertain broadcast, process exit, or missing completion receipt. */
export function reservePayment(receiptsPath: string, reservation: Reservation): void {
  const log = readPayments(receiptsPath);
  if (log.reservations.some((item) => item.paymentId.toLowerCase() === reservation.paymentId.toLowerCase())) {
    throw new Error(`Payment ${reservation.paymentId} already reserved. Inspect its trace and transaction; do not deposit again.`);
  }
  log.reservations.push(reservation);
  writeJsonAtomic(`${receiptsPath}.payments.json`, log);
}

/** Count old receipts and new deposit-plus-gas reservations once per payment id. */
export function committedPaymentsWei(receiptsPath: string): bigint {
  const amounts = new Map<string, bigint>();
  for (const line of readReceiptLines(receiptsPath)) {
    const receipt = JSON.parse(line) as Partial<InferenceReceipt>;
    if (receipt.type === "inference" && !receipt.dryRun && receipt.requestId && receipt.tiaQuoted) {
      const id = receipt.requestId.toLowerCase();
      const amount = BigInt(receipt.tiaQuoted);
      if (amount > (amounts.get(id) ?? 0n)) amounts.set(id, amount);
    }
  }
  for (const item of readPayments(receiptsPath).reservations) {
    const id = item.paymentId.toLowerCase();
    const amount = BigInt(item.amountWei);
    if (amount > (amounts.get(id) ?? 0n)) amounts.set(id, amount);
  }
  return [...amounts.values()].reduce((sum, amount) => sum + amount, 0n);
}
