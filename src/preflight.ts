import { Wallet } from "ethers";
import type { Config } from "./config.ts";
import { assertPrivateKey } from "./config.ts";
import { EDEN_CHAIN_ID } from "./eden.ts";
import {
  assertFacilitatorSigned,
  assertQuoteFresh,
  assertQuoteUsd,
  fetchQuote,
  isQuote,
  maxGasWei,
  requestDepositBuild,
  type ParsedQuote,
} from "./houston.ts";
import { assertWithinCap, formatTia } from "./money.ts";
import { committedWei, readReceiptLines } from "./receipts.ts";
import { DEMO_MESSAGES } from "./run.ts";

export type PreflightReport = {
  ok: boolean;
  address: string;
  rpcUrl: string;
  chainId: number | null;
  balanceWei: bigint | null;
  quoteWei: bigint | null;
  gasWei: bigint | null;
  needWei: bigint | null;
  capWei: bigint;
  committedWei: bigint;
  paymentId: string | null;
  expiresAt: number | null;
  unsignedBuild: boolean;
  reasons: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHexQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${label} was not a hex quantity`);
  }
  return BigInt(value);
}

async function edenCall(rpcUrl: string, method: string, params: unknown[], fetchImpl: typeof fetch): Promise<unknown> {
  const res = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Eden RPC ${method} returned non-JSON (${res.status})`);
  }
  if (!isRecord(body) || body.error !== undefined || !res.ok) {
    const message =
      isRecord(body) && isRecord(body.error) && typeof body.error.message === "string"
        ? body.error.message
        : `status ${res.status}`;
    throw new Error(`Eden RPC ${method} failed: ${message}`);
  }
  return body.result;
}

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read the Eden address, TIA balance, and a fresh Houston quote.
 * May POST deposit/build for an unsigned transaction. Never signs and never calls deposit/send.
 */
export async function runPreflight(cfg: Config, deps?: { fetchImpl?: typeof fetch }): Promise<PreflightReport> {
  if (!cfg.privateKey) {
    throw new Error(
      "EDEN_PRIVATE_KEY is required for preflight. It is only used to derive the Eden address. Preflight does not sign or broadcast.",
    );
  }
  const address = new Wallet(assertPrivateKey(cfg.privateKey)).address;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const report: PreflightReport = {
    ok: false,
    address,
    rpcUrl: cfg.edenRpc,
    chainId: null,
    balanceWei: null,
    quoteWei: null,
    gasWei: null,
    needWei: null,
    capWei: cfg.spendCapWei,
    committedWei: committedWei(readReceiptLines(cfg.receiptsPath)),
    paymentId: null,
    expiresAt: null,
    unsignedBuild: false,
    reasons: [],
  };

  try {
    report.chainId = Number(parseHexQuantity(await edenCall(cfg.edenRpc, "eth_chainId", [], fetchImpl), "eth_chainId"));
  } catch (error) {
    report.reasons.push(reasonText(error));
  }

  if (report.chainId === EDEN_CHAIN_ID) {
    try {
      report.balanceWei = parseHexQuantity(
        await edenCall(cfg.edenRpc, "eth_getBalance", [address, "latest"], fetchImpl),
        "eth_getBalance",
      );
    } catch (error) {
      report.reasons.push(reasonText(error));
    }
  } else if (report.chainId !== null) {
    report.reasons.push(
      `RPC chain id ${report.chainId} is not Eden ${EDEN_CHAIN_ID}. The balance was not treated as spendable TIA.`,
    );
  }

  let quote: ParsedQuote;
  try {
    const quoted = await fetchQuote({
      baseUrl: cfg.houstonBase,
      model: cfg.model,
      messages: DEMO_MESSAGES,
      maxTokens: cfg.maxTokens,
      escrow: cfg.escrow,
      fetchImpl,
    });
    if (!isQuote(quoted)) {
      throw new Error("expected a 402 quote. The endpoint returned a completion without payment.");
    }
    quote = quoted;
  } catch (error) {
    report.reasons.push(reasonText(error));
    return report;
  }

  report.paymentId = quote.accepted.extra.paymentId;
  report.quoteWei = BigInt(quote.accepted.amount);
  report.expiresAt = quote.accepted.extra.expiresAt;

  let signable = true;
  try {
    assertFacilitatorSigned(quote);
  } catch (error) {
    signable = false;
    report.reasons.push(reasonText(error));
  }
  try {
    assertQuoteFresh(quote);
  } catch (error) {
    signable = false;
    report.reasons.push(reasonText(error));
  }
  try {
    assertQuoteUsd(quote, cfg.spendCapUsdWei);
  } catch (error) {
    report.reasons.push(reasonText(error));
  }

  if (signable && report.quoteWei !== null) {
    try {
      const tx = await requestDepositBuild({
        baseUrl: cfg.houstonBase,
        from: address,
        quote,
        escrow: cfg.escrow,
        fetchImpl,
      });
      report.unsignedBuild = true;
      report.gasWei = maxGasWei(tx);
      report.needWei = report.quoteWei + report.gasWei;
    } catch (error) {
      report.reasons.push(reasonText(error));
    }
  }

  if (report.needWei === null) {
    if (report.reasons.length === 0) {
      report.reasons.push("Deposit plus gas is unknown, so this is not a go.");
    }
  } else {
    try {
      assertWithinCap({
        capWei: cfg.spendCapWei,
        committedWei: report.committedWei,
        nextWei: report.needWei,
        label: "deposit plus gas",
      });
    } catch (error) {
      report.reasons.push(reasonText(error));
    }
    if (report.chainId === EDEN_CHAIN_ID && report.balanceWei === null) {
      report.reasons.push("Eden balance is unknown, so this is not a go.");
    }
    if (report.chainId === EDEN_CHAIN_ID && report.balanceWei !== null && report.balanceWei < report.needWei) {
      report.reasons.push(
        `balance ${formatTia(report.balanceWei)} TIA is short of deposit plus gas ${formatTia(report.needWei)} TIA`,
      );
    }
  }

  report.ok = report.reasons.length === 0;
  return report;
}

export function formatPreflight(report: PreflightReport): string {
  const lines = [
    report.ok ? "GO" : "NO-GO",
    `Eden address: ${report.address}`,
    `RPC: ${report.rpcUrl}`,
    `chain id: ${report.chainId ?? "unknown"}`,
    `balance: ${report.balanceWei === null ? "unknown" : `${formatTia(report.balanceWei)} TIA`}`,
    `quote: ${report.quoteWei === null ? "unknown" : `${formatTia(report.quoteWei)} TIA (${report.quoteWei} wei)`}`,
    `paymentId: ${report.paymentId ?? "unknown"}`,
    `expiresAt: ${report.expiresAt === null ? "unknown" : new Date(report.expiresAt * 1000).toISOString()}`,
    `max gas: ${report.gasWei === null ? "unknown" : `${formatTia(report.gasWei)} TIA`}`,
    `deposit + gas: ${report.needWei === null ? "unknown" : `${formatTia(report.needWei)} TIA`}`,
    `spend cap: ${formatTia(report.capWei)} TIA`,
    `already committed: ${formatTia(report.committedWei)} TIA`,
    "No transaction was signed and deposit/send was not called.",
  ];
  if (report.unsignedBuild) {
    lines.push("deposit/build returned an unsigned transaction. It was not signed.");
  }
  if (report.ok) {
    lines.push("Balance covers deposit + gas, and that total fits the spend cap.");
    lines.push("This quote was not deposited. A live run requests a new 402. Start it promptly.");
    lines.push("Suggested live command: DEMO_MODE=live npm run demo");
  } else {
    lines.push("Reasons:");
    for (const reason of report.reasons) lines.push(`- ${reason}`);
  }
  return lines.join("\n");
}
