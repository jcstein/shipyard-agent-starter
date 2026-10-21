import { getBytes, hashMessage, Interface, recoverAddress, Wallet } from "ethers";
import type { Config, SignField } from "./config.ts";
import { assertPrivateKey } from "./config.ts";
import { EDEN_CHAIN_ID, EDEN_NETWORK, EXPLORER } from "./eden.ts";
import { sha256Hex } from "./hash.ts";
import { assertWithinCap, formatTia, formatUsd, quoteUsd } from "./money.ts";
import { isTraceFetch } from "./trace.ts";

export type ChatMessage = { role: "user" | "system" | "assistant"; content: string };

export type QuoteExtra = {
  paymentId: string;
  escrowContract: string;
  facilitator: string;
  refundAfter: number;
  expiresAt: number;
  nonce: string;
  chainId: number;
  tiaPriceUsd: string;
  serverSignature: string;
};

export type Accepted = {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  extra: QuoteExtra;
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  resource?: { url?: string; mimeType?: string; description?: string };
  accepts: Accepted[];
};

export type ParsedQuote = {
  header: string;
  body: unknown;
  required: PaymentRequired;
  accepted: Accepted;
};

export type TxData = {
  to: string;
  data: string;
  value: string;
  nonce: number;
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  chainId: number;
};

export type Completion = {
  id?: string;
  model?: string;
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class PaidRequestError extends Error {
  depositTxHash: string | null;
  constructor(message: string, depositTxHash: string | null) {
    super(message);
    this.name = "PaidRequestError";
    this.depositTxHash = depositTxHash;
  }
}

export class InferenceHttpError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "InferenceHttpError";
    this.status = status;
    this.body = body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`402 quote is missing ${key}`);
  }
  return value;
}

function needInt(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`402 quote is missing ${key}`);
  }
  return value;
}

export function parsePaymentRequired(header: string, body: unknown, expectedEscrow: string): ParsedQuote {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(header.replace(/\s+/g, ""), "base64").toString("utf8"));
  } catch {
    throw new Error("payment-required header was not base64 JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.accepts)) {
    throw new Error("payment-required header has no accepts array");
  }
  const acceptedRaw = parsed.accepts.find((item) => isRecord(item) && item.scheme === "escrow-upto");
  if (!isRecord(acceptedRaw) || !isRecord(acceptedRaw.extra)) {
    throw new Error("402 did not offer the escrow-upto scheme");
  }
  const extra = acceptedRaw.extra;
  const accepted: Accepted = {
    scheme: needString(acceptedRaw, "scheme"),
    network: needString(acceptedRaw, "network"),
    asset: needString(acceptedRaw, "asset"),
    amount: needString(acceptedRaw, "amount"),
    payTo: needString(acceptedRaw, "payTo"),
    extra: {
      paymentId: needString(extra, "paymentId"),
      escrowContract: needString(extra, "escrowContract"),
      facilitator: needString(extra, "facilitator"),
      refundAfter: needInt(extra, "refundAfter"),
      expiresAt: needInt(extra, "expiresAt"),
      nonce: needString(extra, "nonce"),
      chainId: needInt(extra, "chainId"),
      tiaPriceUsd: needString(extra, "tiaPriceUsd"),
      serverSignature: needString(extra, "serverSignature"),
    },
  };
  if (!/^\d+$/.test(accepted.amount)) throw new Error("quote amount is not an integer wei string");
  if (accepted.network !== EDEN_NETWORK || accepted.extra.chainId !== EDEN_CHAIN_ID) {
    throw new Error(`quote is not for Eden (${EDEN_NETWORK})`);
  }
  if (accepted.extra.escrowContract.toLowerCase() !== expectedEscrow.toLowerCase()) {
    throw new Error(`quote escrow ${accepted.extra.escrowContract} does not match the pinned contract ${expectedEscrow}`);
  }
  if (parsed.x402Version !== 2) throw new Error(`unsupported x402 version ${String(parsed.x402Version)}`);
  return {
    header,
    body,
    required: parsed as PaymentRequired,
    accepted: acceptedRaw as Accepted,
  };
}

/** Facilitator EIP-191 personal_sign over the raw paymentId bytes. */
export function recoverPersonalSigner(message: Uint8Array, signature: string): string {
  return recoverAddress(hashMessage(message), signature);
}

export function assertQuoteFresh(quote: ParsedQuote, nowMs = Date.now()): void {
  if (quote.accepted.extra.expiresAt * 1000 <= nowMs) {
    throw new Error("quote has expired; request a new 402");
  }
}

export function assertQuoteUsd(quote: ParsedQuote, capUsdWei: bigint | null): void {
  if (capUsdWei === null) return;
  const usd = quoteUsd(BigInt(quote.accepted.amount), BigInt(quote.accepted.extra.tiaPriceUsd));
  if (usd > capUsdWei) {
    throw new Error(`quote is about $${formatUsd(usd)}, above the USD spend cap of $${formatUsd(capUsdWei)}`);
  }
}

export function assertFacilitatorSigned(quote: ParsedQuote): string {
  let signer: string;
  try {
    signer = recoverPersonalSigner(getBytes(quote.accepted.extra.paymentId), quote.accepted.extra.serverSignature);
  } catch {
    throw new Error("quote serverSignature is not a valid EIP-191 signature");
  }
  if (signer.toLowerCase() !== quote.accepted.extra.facilitator.toLowerCase()) {
    throw new Error("quote serverSignature was not signed by the quoted facilitator");
  }
  return signer;
}

export function encodePaymentSignature(quote: ParsedQuote, signature: string): string {
  const body = {
    x402Version: 2,
    resource: quote.required.resource,
    accepted: quote.accepted,
    payload: {
      signature,
      paymentId: quote.accepted.extra.paymentId,
      nonce: quote.accepted.extra.nonce,
    },
  };
  return Buffer.from(JSON.stringify(body)).toString("base64");
}

export function otherSignField(field: SignField): SignField {
  return field === "nonce" ? "paymentId" : "nonce";
}

/**
 * True when a response is a rejected signature, not a missing Payment-Signature header.
 * "invalid signature" and "signature verification failed" match. "header is required" does not.
 */
export function explainsInvalidSignature(...parts: unknown[]): boolean {
  const texts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
    else if (isRecord(value)) {
      if (typeof value.message === "string") texts.push(value.message);
      if (typeof value.error === "string") texts.push(value.error);
      else if (value.error !== undefined) visit(value.error);
    }
  };
  for (const part of parts) visit(part);
  const text = texts.join("\n").toLowerCase();
  if (!text.includes("signature")) return false;
  const missingHeader = /header is required|missing payment-signature|no payment-signature/.test(text);
  const rejected = /invalid|malformed|bad|wrong|mismatch|fail|recover|reject|not valid|unable to/.test(text);
  if (missingHeader && !rejected) return false;
  return rejected;
}

export async function signPayment(privateKey: string, quote: ParsedQuote, field: SignField): Promise<string> {
  const wallet = new Wallet(assertPrivateKey(privateKey));
  const hex = field === "paymentId" ? quote.accepted.extra.paymentId : quote.accepted.extra.nonce;
  return wallet.signMessage(getBytes(hex));
}

export function paymentRejectionInstructions(input: {
  quote: ParsedQuote;
  depositTxHash: string;
  tried: SignField;
  invalidSignature: boolean;
  retriedOther: boolean;
  detail: string;
}): string {
  const other = otherSignField(input.tried);
  const refundAt = new Date(input.quote.accepted.extra.refundAfter * 1000).toISOString();
  const paymentId = input.quote.accepted.extra.paymentId;
  const escrow = input.quote.accepted.extra.escrowContract;
  const lines = [
    input.detail,
    `The deposit ${input.depositTxHash} is already in NativeEscrow for paymentId ${paymentId}.`,
    `A second deposit for this paymentId reverts on-chain ("payment id already used"). Do not start another live run to reuse it. A new live run requests a new quote and would deposit again.`,
    `This attempt signed ${input.tried}.`,
  ];
  if (input.invalidSignature && input.retriedOther) {
    lines.push(
      `Retried the chat completion once with ${other} on that same paymentId. No second deposit. Both signatures were rejected.`,
    );
  } else if (input.invalidSignature) {
    lines.push(
      `The other field (${other}) was not sent. Set HOUSTON_RETRY_OTHER_SIGN_FIELD=1 before the live run so a signature rejection retries the chat completion once on the same deposit. This process will not deposit that paymentId again.`,
    );
  } else {
    lines.push(
      "The response was not classified as an invalid signature, so the other sign field was not tried. Inspect the trace before doing anything else.",
    );
  }
  lines.push(
    `The TIA stays in escrow until the facilitator settles it, or until refundAfter ${refundAt}, when the buyer can call refundExpired(paymentId) on ${escrow}. Anyone can submit that call; the refund goes to the buyer. The quote amount is a ceiling, not a settled charge.`,
  );
  return lines.join(" ");
}

export function paymentHeaderSha256(header: string): string {
  return sha256Hex(header);
}

function displayPrice(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.price)) return null;
  const amount = body.price.amount;
  const currency = body.price.currency;
  if (typeof amount !== "string" || typeof currency !== "string") return null;
  return `${amount} ${currency}`;
}

export function describeQuote(quote: ParsedQuote, capWei: bigint): string {
  const amount = BigInt(quote.accepted.amount);
  const price = BigInt(quote.accepted.extra.tiaPriceUsd);
  const lines = [
    "Houston Inference quote (HTTP 402, scheme escrow-upto)",
    `  deposit: ${formatTia(amount)} TIA (${quote.accepted.amount} wei)`,
    `  quoted TIA price: about $${formatUsd(quoteUsd(amount, price))} at ${formatUsd(price)} USD/TIA`,
    `  display price: ${displayPrice(quote.body) ?? "not in the body"}`,
    `  paymentId: ${quote.accepted.extra.paymentId}`,
    `  escrow: ${quote.accepted.extra.escrowContract}`,
    `  payTo: ${quote.accepted.payTo}`,
    `  facilitator: ${quote.accepted.extra.facilitator}`,
    "  serverSignature: EIP-191 over the paymentId bytes recovers to the facilitator",
    `  spend cap: ${formatTia(capWei)} TIA`,
    `  explorer: ${EXPLORER}/address/${quote.accepted.extra.escrowContract}`,
  ];
  return lines.join("\n");
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`expected JSON, got: ${text.slice(0, 180)}`);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  if (isRecord(body) && typeof body.message === "string") return body.message;
  return fallback;
}

export async function fetchQuote(input: {
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  escrow: string;
  fetchImpl?: typeof fetch;
  paymentSignature?: string;
  step?: string;
}): Promise<ParsedQuote | { kind: "completion"; completion: Completion; paymentResponse: string | null }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (input.paymentSignature) headers["payment-signature"] = input.paymentSignature;
  if (input.step && isTraceFetch(fetchImpl)) headers["x-shipyard-trace-step"] = input.step;
  const res = await fetchImpl(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: input.model, messages: input.messages, max_tokens: input.maxTokens }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await readJson(res);
  if (res.status === 402) {
    const header = res.headers.get("payment-required");
    if (!header) throw new InferenceHttpError("402 response had no payment-required header", 402, body);
    return parsePaymentRequired(header, body, input.escrow);
  }
  if (!res.ok) {
    throw new InferenceHttpError(`inference ${res.status}: ${errorMessage(body, "request failed")}`, res.status, body);
  }
  return {
    kind: "completion",
    completion: (body ?? {}) as Completion,
    paymentResponse: res.headers.get("payment-response"),
  };
}

export function isQuote(value: ParsedQuote | { kind: "completion" }): value is ParsedQuote {
  return !("kind" in value);
}

const DEPOSIT = new Interface([
  "function deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd) payable",
]);

export function assertDepositTx(tx: TxData, quote: ParsedQuote, escrow: string): void {
  if (tx.to.toLowerCase() !== escrow.toLowerCase()) {
    throw new Error(`deposit/build targeted ${tx.to}, not the pinned escrow`);
  }
  if (tx.chainId !== EDEN_CHAIN_ID) throw new Error(`deposit/build chainId ${tx.chainId} is not Eden`);
  if (asWei("tx value", tx.value) !== asWei("quote amount", quote.accepted.amount)) {
    throw new Error("deposit/build value does not match the quote");
  }
  let decoded: ReturnType<Interface["decodeFunctionData"]>;
  try {
    decoded = DEPOSIT.decodeFunctionData("deposit", tx.data);
  } catch {
    throw new Error("deposit/build calldata is not NativeEscrow.deposit");
  }
  const extra = quote.accepted.extra;
  if (String(decoded.paymentId).toLowerCase() !== extra.paymentId.toLowerCase()) {
    throw new Error("deposit calldata paymentId does not match the quote");
  }
  if (String(decoded.payTo).toLowerCase() !== quote.accepted.payTo.toLowerCase()) {
    throw new Error("deposit calldata payTo does not match the quote");
  }
  if (String(decoded.facilitator).toLowerCase() !== extra.facilitator.toLowerCase()) {
    throw new Error("deposit calldata facilitator does not match the quote");
  }
  if (decoded.expiresAt !== BigInt(extra.expiresAt)) throw new Error("deposit calldata expiresAt does not match the quote");
  if (decoded.refundAfter !== BigInt(extra.refundAfter)) throw new Error("deposit calldata refundAfter does not match the quote");
  if (decoded.tiaPriceUsd !== BigInt(extra.tiaPriceUsd)) throw new Error("deposit calldata tiaPriceUsd does not match the quote");
}

export function maxGasWei(tx: TxData): bigint {
  return asWei("gasLimit", tx.gasLimit) * asWei("maxFeePerGas", tx.maxFeePerGas);
}

export function readDepositBuild(status: number, json: unknown, quote: ParsedQuote, escrow: string): TxData {
  if (status !== 200 || !isRecord(json) || !isRecord(json.txData)) {
    throw new Error(`deposit/build failed (${status}): ${errorMessage(json, "no unsigned transaction")}`);
  }
  if (json.paymentId !== quote.accepted.extra.paymentId) {
    throw new Error("deposit/build paymentId does not match the quote");
  }
  const tx = json.txData as TxData;
  assertDepositTx(tx, quote, escrow);
  return tx;
}

function asWei(label: string, value: string | number): bigint {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`${label} is not an integer: ${text}`);
  return BigInt(text);
}

function readTxHash(body: unknown): string {
  const visit = (value: unknown): string | null => {
    if (!isRecord(value)) return null;
    for (const key of ["txHash", "hash", "transactionHash"]) {
      const item = value[key];
      if (typeof item === "string" && /^0x[0-9a-fA-F]{64}$/.test(item)) return item;
    }
    return visit(value.result) ?? visit(value.tx) ?? visit(value.transaction);
  };
  const hash = visit(body);
  if (!hash) throw new Error(`deposit/send did not return a tx hash: ${JSON.stringify(body).slice(0, 300)}`);
  return hash;
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  step?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (step && isTraceFetch(fetchImpl)) headers["x-shipyard-trace-step"] = step;
  const res = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: res.status, json: await readJson(res) };
}

export async function requestDepositBuild(input: {
  baseUrl: string;
  from: string;
  quote: ParsedQuote;
  escrow: string;
  fetchImpl?: typeof fetch;
}): Promise<TxData> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const built = await postJson(
    fetchImpl,
    `${input.baseUrl}/deposit/build`,
    { from: input.from, accepted: input.quote.accepted },
    "deposit-build",
  );
  return readDepositBuild(built.status, built.json, input.quote, input.escrow);
}

export async function payAndComplete(input: {
  cfg: Config;
  quote: ParsedQuote;
  messages: ChatMessage[];
  committedWei: bigint;
  fetchImpl?: typeof fetch;
}): Promise<{
  completion: Completion;
  depositTxHash: string;
  paymentHeader: string;
  paymentResponse: string | null;
  tiaCharged: string | null;
  signFieldUsed: SignField;
}> {
  if (!input.cfg.privateKey) throw new Error("EDEN_PRIVATE_KEY is required");
  const privateKey = input.cfg.privateKey;
  const fetchImpl = input.fetchImpl ?? fetch;
  assertQuoteFresh(input.quote);
  const quoted = asWei("quote amount", input.quote.accepted.amount);
  assertWithinCap({
    capWei: input.cfg.spendCapWei,
    committedWei: input.committedWei,
    nextWei: quoted,
    label: "quote",
  });
  assertQuoteUsd(input.quote, input.cfg.spendCapUsdWei);

  const from = new Wallet(assertPrivateKey(privateKey)).address;
  const tx = await requestDepositBuild({
    baseUrl: input.cfg.houstonBase,
    from,
    quote: input.quote,
    escrow: input.cfg.escrow,
    fetchImpl,
  });
  const gas = maxGasWei(tx);
  assertWithinCap({
    capWei: input.cfg.spendCapWei,
    committedWei: input.committedWei,
    nextWei: quoted + gas,
    label: "deposit plus gas",
  });

  const signedTx = await new Wallet(assertPrivateKey(privateKey)).signTransaction({
    type: 2,
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: asWei("tx value", tx.value),
    nonce: tx.nonce,
    gasLimit: asWei("gasLimit", tx.gasLimit),
    maxFeePerGas: asWei("maxFeePerGas", tx.maxFeePerGas),
    maxPriorityFeePerGas: asWei("maxPriorityFeePerGas", tx.maxPriorityFeePerGas),
  });

  const sent = await postJson(
    fetchImpl,
    `${input.cfg.houstonBase}/deposit/send`,
    { signedTx, paymentId: input.quote.accepted.extra.paymentId },
    "deposit-send",
  );
  if (sent.status !== 200) {
    throw new PaidRequestError(
      `deposit/send failed (${sent.status}): ${errorMessage(sent.json, "broadcast failed")}`,
      null,
    );
  }
  let depositTxHash: string;
  try {
    depositTxHash = readTxHash(sent.json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PaidRequestError(
      `${message} deposit/send returned HTTP ${sent.status}. If the explorer shows the transaction, do not deposit this paymentId again. The response body is in the trace.`,
      null,
    );
  }
  await waitForDeposit(input.cfg.houstonBase, depositTxHash, fetchImpl);

  const attempt = async (field: SignField, step: string) => {
    const signature = await signPayment(privateKey, input.quote, field);
    const paymentHeader = encodePaymentSignature(input.quote, signature);
    try {
      const result = await fetchQuote({
        baseUrl: input.cfg.houstonBase,
        model: input.cfg.model,
        messages: input.messages,
        maxTokens: input.cfg.maxTokens,
        escrow: input.cfg.escrow,
        fetchImpl,
        paymentSignature: paymentHeader,
        step,
      });
      return { field, paymentHeader, result, error: null as InferenceHttpError | null };
    } catch (error) {
      if (error instanceof InferenceHttpError) return { field, paymentHeader, result: null, error };
      throw error;
    }
  };

  const classify = (paid: Awaited<ReturnType<typeof attempt>>) => {
    if (paid.result && !isQuote(paid.result)) {
      return { ok: true as const, completion: paid.result.completion, paymentResponse: paid.result.paymentResponse };
    }
    if (paid.result && isQuote(paid.result)) {
      return {
        ok: false as const,
        invalidSignature:
          explainsInvalidSignature(paid.result.body) || explainsInvalidSignature(paid.result.required.error),
        detail: errorMessage(paid.result.body, paid.result.required.error ?? "payment was not accepted"),
      };
    }
    const status = paid.error?.status ?? 0;
    return {
      ok: false as const,
      invalidSignature: (status === 400 || status === 402) && explainsInvalidSignature(paid.error?.body),
      detail: paid.error?.message ?? "payment was not accepted",
    };
  };

  try {
    const firstField = input.cfg.signField;
    const first = await attempt(firstField, `paid-retry:${firstField}`);
    const firstClass = classify(first);
    if (firstClass.ok) {
      return {
        completion: firstClass.completion,
        depositTxHash,
        paymentHeader: first.paymentHeader,
        paymentResponse: firstClass.paymentResponse,
        tiaCharged: settledAmount(firstClass.paymentResponse),
        signFieldUsed: firstField,
      };
    }

    let retriedOther = false;
    let detail = firstClass.detail;
    let invalidSignature = firstClass.invalidSignature;
    if (firstClass.invalidSignature && input.cfg.retryOtherSignField) {
      const other = otherSignField(firstField);
      retriedOther = true;
      console.log(
        `Paid retry rejected the ${firstField} signature (${firstClass.detail}). Retrying once with ${other} on paymentId ${input.quote.accepted.extra.paymentId}. No second deposit.`,
      );
      const second = await attempt(other, `paid-retry-other-sign-field:${other}`);
      const secondClass = classify(second);
      if (secondClass.ok) {
        return {
          completion: secondClass.completion,
          depositTxHash,
          paymentHeader: second.paymentHeader,
          paymentResponse: secondClass.paymentResponse,
          tiaCharged: settledAmount(secondClass.paymentResponse),
          signFieldUsed: other,
        };
      }
      detail = `${firstClass.detail} Then ${other}: ${secondClass.detail}`;
      invalidSignature = true;
    }

    throw new PaidRequestError(
      paymentRejectionInstructions({
        quote: input.quote,
        depositTxHash,
        tried: firstField,
        invalidSignature,
        retriedOther,
        detail,
      }),
      depositTxHash,
    );
  } catch (error) {
    if (error instanceof PaidRequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PaidRequestError(
      `${message} The deposit is ${depositTxHash}. Do not deposit this paymentId again.`,
      depositTxHash,
    );
  }
}

export function settledAmount(header: string | null): string | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(Buffer.from(header.replace(/\s+/g, ""), "base64").toString("utf8")) as unknown;
    if (isRecord(parsed) && typeof parsed.amount === "string" && /^\d+$/.test(parsed.amount)) return parsed.amount;
  } catch {
    return null;
  }
  return null;
}

export async function waitForDeposit(baseUrl: string, txHash: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const deadline = Date.now() + 45_000;
  let last = "unknown";
  while (Date.now() < deadline) {
    const headers: Record<string, string> = {};
    if (isTraceFetch(fetchImpl)) headers["x-shipyard-trace-step"] = "deposit-status";
    const res = await fetchImpl(`${baseUrl}/deposit/status/${txHash}`, { headers, signal: AbortSignal.timeout(15_000) });
    const body = await readJson(res);
    if (!res.ok || !isRecord(body) || typeof body.status !== "string") {
      throw new PaidRequestError(`deposit status failed: ${errorMessage(body, res.statusText)}`, txHash);
    }
    last = body.status.toLowerCase();
    if (last === "confirmed" || last === "success") return;
    if (last === "failed" || last === "reverted") {
      throw new PaidRequestError(`deposit ${last}: ${txHash}`, txHash);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new PaidRequestError(`deposit still ${last} after 45s: ${txHash}`, txHash);
}
