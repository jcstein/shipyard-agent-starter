import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import { parseGoDurationMs } from "./config.ts";
import { sha256Hex } from "./hash.ts";
import {
  assertQuoteFresh,
  assertQuoteUsd,
  decodePaymentResponse,
  encodePaymentSignature,
  explainsInvalidSignature,
  fetchQuote,
  isQuote,
  InferenceHttpError,
  maxGasWei,
  PaidRequestError,
  parsePaymentRequired,
  readHoustonCost,
  requestDepositBuildDocument,
  type ChatMessage,
  type ParsedQuote,
} from "./houston.ts";
import { assertWithinCap } from "./money.ts";
import { appendReceipt, readReceiptLines, type EdictaNote, type InferenceReceipt } from "./receipts.ts";
import { isTraceFetch } from "./trace.ts";

/**
 * Opt-in Houston payment through Edicta.
 *
 * `@edicta/houston` (sdk/ts/edicta-houston in github.com/vgonkivs/edicta) is not
 * published on npm. This file posts the same JSON that package sends to
 * `POST /v1/commit` on a local `edicta agent serve`. The agent serve commits
 * the deposit, the gate authorizes it, and the signer holds the payer key and
 * broadcasts. This process does not sign.
 *
 * The Eden profile is still a draft. A live Eden payment through Edicta has
 * not been run from this starter.
 */

const MAX_ANSWER = 1024 * 1024;
const MARGIN_MS = 360_000;

export class EdictaCommitError extends Error {
  readonly code: string;
  readonly status: number;
  readonly commitmentHash: string | null;
  readonly retryable: boolean;

  constructor(message: string, code: string, status: number, commitmentHash: string | null, retryable: boolean) {
    super(message);
    this.name = "EdictaCommitError";
    this.code = code;
    this.status = status;
    this.commitmentHash = commitmentHash;
    this.retryable = retryable;
  }
}

export class EdictaPaidError extends PaidRequestError {
  readonly note: EdictaNote;
  readonly requestId: string;
  readonly tiaQuoted: string;
  readonly escrow: string;
  readonly quoteHeader: string;
  readonly model: string;

  constructor(
    message: string,
    depositTxHash: string,
    note: EdictaNote,
    quote: ParsedQuote,
    model: string,
  ) {
    super(message, depositTxHash);
    this.name = "EdictaPaidError";
    this.note = note;
    this.requestId = quote.accepted.extra.paymentId;
    this.tiaQuoted = quote.accepted.amount;
    this.escrow = quote.accepted.extra.escrowContract;
    this.quoteHeader = quote.header;
    this.model = model;
  }
}

type PendingFile = {
  version: 1;
  commitmentHash: string;
  paymentRequiredHeader: string;
  houstonBase: string;
  resource: string;
  model: string;
  maxTokens: number;
  messages: ChatMessage[];
  escrow: string;
  payer: string;
  checkoutId: string | null;
  mode: "fast" | "strict";
  createdAt: string;
};

type CommitResult = {
  commitmentHash: string;
  mode: "fast" | "strict";
  paymentSignature: string;
  railRef: string;
  payer: string;
  authorization: string;
  recorded: boolean;
  anchorDeadline: number | null;
  warning: string | null;
};

export type EdictaPaid = {
  completion: { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  depositTxHash: string;
  paymentHeader: string;
  paymentResponse: string | null;
  paymentResponseDecoded: ReturnType<typeof decodePaymentResponse>;
  costTia: string | null;
  costUsd: string | null;
  tiaCharged: string | null;
  signFieldUsed: "paymentId";
  edicta: EdictaNote;
  model: string;
};

export function edictaReceiptFields(note: EdictaNote | null | undefined): { edicta?: EdictaNote } {
  return note ? { edicta: note } : {};
}

export function describeEdicta(note: EdictaNote): string {
  return [
    `edicta commitment: ${note.commitmentHash}`,
    `edicta mode: ${note.mode}`,
    `edicta rail ref: ${note.railRef}`,
    `edicta payer: ${note.payer}`,
    `edicta recorded: ${String(note.recorded)}`,
    `edicta authorization sha256: ${note.authorizationSha256}`,
  ].join("\n");
}

export function clearEdictaPending(path: string): void {
  rmSync(path, { force: true });
}

/** Log a settled Edicta deposit whose chat completion was refused, then drop the pending file. */
export function recordFailedEdictaPayment(
  cfg: Config,
  error: EdictaPaidError,
  checkout?: { checkoutId: string; stripePaymentId: string | null },
): void {
  appendReceipt(cfg.receiptsPath, {
    type: "inference",
    requestId: error.requestId,
    model: error.model,
    tokensIn: null,
    tokensOut: null,
    tiaCharged: null,
    tiaQuoted: error.tiaQuoted,
    escrow: error.escrow,
    depositTxHash: error.depositTxHash,
    paymentHeaderSha256: null,
    quoteHeaderSha256: sha256Hex(error.quoteHeader),
    dryRun: false,
    ...(checkout ? { checkoutId: checkout.checkoutId, stripePaymentId: checkout.stripePaymentId } : {}),
    ...edictaReceiptFields(error.note),
  });
  clearEdictaPending(cfg.edictaPendingPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function payerOf(cfg: Config): string {
  if (!cfg.edictaPayer) {
    throw new Error("EDICTA_PAYER is required. The agent does not hold the payer key.");
  }
  return cfg.edictaPayer;
}

function writePending(path: string, pending: PendingFile): void {
  const dir = dirname(path);
  if (dir !== "." && dir !== "") mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pending)}\n`);
  renameSync(tmp, path);
}

function messageList(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (item.role !== "user" && item.role !== "system" && item.role !== "assistant") return null;
    if (typeof item.content !== "string") return null;
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}

export function readEdictaPending(path: string): PendingFile | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = isRecord(error) && error.code;
    if (code === "ENOENT") return null;
    throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path} is not JSON. An open Edicta commitment may still be in that file. Do not delete it and do not start a new 402.`);
  }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error(`${path} is not a version 1 Edicta pending file. Do not delete it and do not start a new 402.`);
  }
  const mode = parsed.mode === "strict" || parsed.mode === "fast" ? parsed.mode : null;
  const messages = messageList(parsed.messages);
  const checkoutId = parsed.checkoutId === null || typeof parsed.checkoutId === "string" ? parsed.checkoutId : undefined;
  if (
    mode === null ||
    messages === null ||
    checkoutId === undefined ||
    typeof parsed.commitmentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(parsed.commitmentHash) ||
    typeof parsed.paymentRequiredHeader !== "string" ||
    typeof parsed.houstonBase !== "string" ||
    typeof parsed.resource !== "string" ||
    typeof parsed.model !== "string" ||
    typeof parsed.maxTokens !== "number" ||
    typeof parsed.escrow !== "string" ||
    typeof parsed.payer !== "string"
  ) {
    throw new Error(`${path} is missing fields. Do not delete it and do not start a new 402.`);
  }
  return {
    version: 1,
    commitmentHash: parsed.commitmentHash,
    paymentRequiredHeader: parsed.paymentRequiredHeader,
    houstonBase: parsed.houstonBase,
    resource: parsed.resource,
    model: parsed.model,
    maxTokens: parsed.maxTokens,
    messages,
    escrow: parsed.escrow,
    payer: parsed.payer,
    checkoutId,
    mode,
    createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
  };
}

function sameJob(pending: string | null, checkoutId: string | null): boolean {
  return pending === checkoutId;
}

function receiptFor(path: string, requestId: string): InferenceReceipt | null {
  for (const line of readReceiptLines(path)) {
    let event: InferenceReceipt;
    try {
      event = JSON.parse(line) as InferenceReceipt;
    } catch {
      continue;
    }
    if (event.type === "inference" && event.requestId === requestId && event.dryRun === false) return event;
  }
  return null;
}

function noteFrom(result: CommitResult): EdictaNote {
  return {
    commitmentHash: result.commitmentHash,
    mode: result.mode,
    railRef: `0x${result.railRef}`,
    payer: result.payer,
    recorded: result.recorded,
    authorizationSha256: sha256Hex(result.authorization),
  };
}

function commitError(status: number, body: unknown, fallback: string): EdictaCommitError {
  const record = isRecord(body) ? body : {};
  const nested = isRecord(record.error) ? record.error : record;
  const code = typeof nested.code === "string" && nested.code.length > 0 ? nested.code : "bad_response";
  const message = typeof nested.message === "string" && nested.message.length > 0 ? nested.message : fallback;
  const hash = typeof nested.commitment_hash === "string" && /^[0-9a-f]{64}$/.test(nested.commitment_hash) ? nested.commitment_hash : null;
  const retryable = nested.retryable === true;
  return new EdictaCommitError(`Edicta agent serve ${status} ${code}: ${message}`, code, status, hash, retryable);
}

function fastRefusedBeforePublish(error: EdictaCommitError): boolean {
  return error.commitmentHash === null && error.code === "usage" && /fast mode/i.test(error.message);
}

async function postCommit(input: {
  cfg: Config;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
}): Promise<CommitResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (input.cfg.edictaToken) headers.authorization = `Bearer ${input.cfg.edictaToken}`;
  if (isTraceFetch(input.fetchImpl)) headers["x-shipyard-trace-step"] = "edicta-commit";
  const waitMs = parseGoDurationMs(input.cfg.edictaWait) ?? 300_000;
  const url = `${input.cfg.edictaAgentUrl.replace(/\/$/, "")}/v1/commit`;
  let res: Response;
  try {
    res = await input.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(input.body),
      redirect: "error",
      signal: AbortSignal.timeout(Math.ceil(waitMs + MARGIN_MS)),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EdictaCommitError(
      `Edicta agent serve at ${input.cfg.edictaAgentUrl} did not answer (${reason}). Start the gate, the signer, and edicta agent serve. This process did not sign a deposit.`,
      "transport",
      0,
      null,
      true,
    );
  }
  const text = await res.text();
  if (text.length > MAX_ANSWER) {
    throw new EdictaCommitError("Edicta agent serve answer is too large", "bad_response", res.status, null, false);
  }
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      if (!res.ok) throw commitError(res.status, null, text.slice(0, 180));
      throw new EdictaCommitError("Edicta agent serve answer is not JSON", "bad_response", res.status, null, false);
    }
  }
  if (!res.ok) throw commitError(res.status, json, "commit failed");
  return readCommit(json, res.status);
}

function readCommit(json: unknown, status: number): CommitResult {
  if (!isRecord(json)) {
    throw new EdictaCommitError("Edicta agent serve answer is not an object", "bad_response", status, null, false);
  }
  const hash = json.commitment_hash;
  const commitmentHash = typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  const fail = (message: string) => new EdictaCommitError(message, "bad_response", status, commitmentHash, false);
  if (!commitmentHash) throw fail("Edicta agent serve answer has no commitment_hash");
  if (json.settled !== true) throw fail("Edicta agent serve did not report the deposit settled");
  const mode = json.mode === "fast" || json.mode === "strict" ? json.mode : null;
  if (!mode) throw fail("Edicta agent serve answer has no mode");
  const signature = json.payment_signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw fail("Edicta agent serve answer has no paymentId signature");
  }
  const railRef = json.rail_ref;
  if (typeof railRef !== "string" || !/^[0-9a-f]{64}$/.test(railRef)) throw fail("Edicta agent serve answer has no rail_ref");
  const payer = json.payer;
  if (typeof payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(payer)) throw fail("Edicta agent serve answer has no payer");
  const authorization = json.authorization;
  if (typeof authorization !== "string" || authorization.length === 0 || authorization.length > 65_536) {
    throw fail("Edicta agent serve answer has no authorization");
  }
  if (typeof json.recorded !== "boolean") throw fail("Edicta agent serve answer has no recorded flag");
  const anchor = json.anchor_deadline;
  const warning = typeof json.warning === "string" ? json.warning.slice(0, 500) : null;
  return {
    commitmentHash,
    mode,
    paymentSignature: signature,
    railRef,
    payer,
    authorization,
    recorded: json.recorded,
    anchorDeadline: typeof anchor === "number" ? anchor : null,
    warning,
  };
}

async function commitOnce(input: {
  cfg: Config;
  mode: "fast" | "strict";
  header: string;
  build: Record<string, unknown>;
  resource: string;
  messages: ChatMessage[];
  fetchImpl: typeof fetch;
  resumeHash?: string;
}): Promise<CommitResult> {
  const body: Record<string, unknown> = {
    sign: true,
    broadcast: true,
    record: true,
    payment_signature: true,
    wait: input.cfg.edictaWait,
    mode: input.mode,
  };
  if (input.resumeHash) {
    body.resume_hash = input.resumeHash;
    body.eden = { payment_required: input.header };
  } else {
    body.valid_for = input.cfg.edictaValidFor;
    body.model = { id: input.cfg.model, version: input.cfg.edictaModelVersion };
    body.policy = { id: input.cfg.edictaPolicyId, version: input.cfg.edictaPolicyVersion };
    body.context = { prompt_sha256: sha256Hex(JSON.stringify(input.messages)) };
    body.eden = { payment_required: input.header, build: input.build, resource: input.resource };
  }
  return postCommit({ cfg: input.cfg, body, fetchImpl: input.fetchImpl });
}

async function commitFresh(input: {
  cfg: Config;
  header: string;
  build: Record<string, unknown>;
  resource: string;
  messages: ChatMessage[];
  fetchImpl: typeof fetch;
}): Promise<CommitResult> {
  const mode = input.cfg.edictaCommitMode;
  try {
    return await commitOnce({ ...input, mode });
  } catch (error) {
    if (!(error instanceof EdictaCommitError) || mode !== "fast" || !fastRefusedBeforePublish(error)) throw error;
    console.log(
      `Edicta fast mode was refused before a commitment existed (${error.message}). Retrying once in strict mode. Fast mode has not run live.`,
    );
    return commitOnce({ ...input, mode: "strict" });
  }
}

async function payWithSignature(input: {
  cfg: Config;
  quote: ParsedQuote;
  messages: ChatMessage[];
  model: string;
  maxTokens: number;
  baseUrl: string;
  result: CommitResult;
  fetchImpl: typeof fetch;
}): Promise<EdictaPaid> {
  const note = noteFrom(input.result);
  const depositTxHash = note.railRef;
  if (input.result.warning) console.log(`edicta warning: ${input.result.warning}`);
  if (input.result.anchorDeadline !== null) console.log(`edicta anchor deadline: ${input.result.anchorDeadline}`);
  const paymentHeader = encodePaymentSignature(input.quote, input.result.paymentSignature);
  const fail = (detail: string): never => {
    throw new EdictaPaidError(
      `${detail} Deposit ${depositTxHash} is commitment ${note.commitmentHash}. The signer already broadcast it. Do not request a new 402 for this paymentId. A new quote would deposit again. The quote amount is a ceiling, not a settled charge.`,
      depositTxHash,
      note,
      input.quote,
      input.model,
    );
  };
  try {
    const paid = await fetchQuote({
      baseUrl: input.baseUrl,
      model: input.model,
      messages: input.messages,
      maxTokens: input.maxTokens,
      escrow: input.quote.accepted.extra.escrowContract,
      fetchImpl: input.fetchImpl,
      paymentSignature: paymentHeader,
      step: "paid-retry:paymentId",
    });
    if (isQuote(paid)) {
      const invalid = explainsInvalidSignature(paid.body) || explainsInvalidSignature(paid.required.error);
      return fail(invalid ? "Houston rejected the Payment-Signature." : "Houston did not accept the payment.");
    }
    const cost = readHoustonCost(paid.completion);
    const decoded = decodePaymentResponse(paid.paymentResponse);
    return {
      completion: paid.completion,
      depositTxHash,
      paymentHeader,
      paymentResponse: paid.paymentResponse,
      paymentResponseDecoded: decoded,
      costTia: cost.costTia,
      costUsd: cost.costUsd,
      tiaCharged: cost.costTia ?? decoded?.amount ?? null,
      signFieldUsed: "paymentId",
      edicta: note,
      model: input.model,
    };
  } catch (error) {
    if (error instanceof EdictaPaidError) throw error;
    if (error instanceof InferenceHttpError) return fail(error.message);
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function pendingBase(input: {
  cfg: Config;
  quote: ParsedQuote;
  messages: ChatMessage[];
  checkoutId: string | null;
  hash: string;
  mode: "fast" | "strict";
}): PendingFile {
  return {
    version: 1,
    commitmentHash: input.hash,
    paymentRequiredHeader: input.quote.header,
    houstonBase: input.cfg.houstonBase,
    resource: `${input.cfg.houstonBase}/chat/completions`,
    model: input.cfg.model,
    maxTokens: input.cfg.maxTokens,
    messages: input.messages,
    escrow: input.cfg.escrow,
    payer: payerOf(input.cfg),
    checkoutId: input.checkoutId,
    mode: input.mode,
    createdAt: new Date().toISOString(),
  };
}

export async function payThroughEdicta(input: {
  cfg: Config;
  quote: ParsedQuote;
  messages: ChatMessage[];
  committedWei: bigint;
  checkoutId: string | null;
  fetchImpl?: typeof fetch;
}): Promise<EdictaPaid> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const payer = payerOf(input.cfg);
  assertQuoteFresh(input.quote);
  const quoted = BigInt(input.quote.accepted.amount);
  assertWithinCap({
    capWei: input.cfg.spendCapWei,
    committedWei: input.committedWei,
    nextWei: quoted,
    label: "quote",
  });
  assertQuoteUsd(input.quote, input.cfg.spendCapUsdWei);
  const resource = `${input.cfg.houstonBase}/chat/completions`;
  const built = await requestDepositBuildDocument({
    baseUrl: input.cfg.houstonBase,
    from: payer,
    quote: input.quote,
    escrow: input.cfg.escrow,
    fetchImpl,
  });
  assertWithinCap({
    capWei: input.cfg.spendCapWei,
    committedWei: input.committedWei,
    nextWei: quoted + maxGasWei(built.tx),
    label: "deposit plus gas",
  });
  console.log(
    `Edicta: this process will not sign. Commit ${input.cfg.edictaCommitMode} at ${input.cfg.edictaAgentUrl}. The signer pays from ${payer}.`,
  );
  let result: CommitResult;
  try {
    result = await commitFresh({
      cfg: input.cfg,
      header: input.quote.header,
      build: built.build,
      resource,
      messages: input.messages,
      fetchImpl,
    });
  } catch (error) {
    if (error instanceof EdictaCommitError && error.commitmentHash) {
      writePending(
        input.cfg.edictaPendingPath,
        pendingBase({
          cfg: input.cfg,
          quote: input.quote,
          messages: input.messages,
          checkoutId: input.checkoutId,
          hash: error.commitmentHash,
          mode: input.cfg.edictaCommitMode,
        }),
      );
      throw new EdictaCommitError(
        `${error.message} Commitment ${error.commitmentHash} is in ${input.cfg.edictaPendingPath}. Do not request a new 402. Run the same command again to resume it.`,
        error.code,
        error.status,
        error.commitmentHash,
        error.retryable,
      );
    }
    throw error;
  }
  writePending(
    input.cfg.edictaPendingPath,
    pendingBase({
      cfg: input.cfg,
      quote: input.quote,
      messages: input.messages,
      checkoutId: input.checkoutId,
      hash: result.commitmentHash,
      mode: result.mode,
    }),
  );
  return payWithSignature({
    cfg: input.cfg,
    quote: input.quote,
    messages: input.messages,
    model: input.cfg.model,
    maxTokens: input.cfg.maxTokens,
    baseUrl: input.cfg.houstonBase,
    result,
    fetchImpl,
  });
}

export type EdictaContinue =
  | { kind: "already"; requestId: string }
  | { kind: "paid"; quote: ParsedQuote; paid: EdictaPaid };

/**
 * Resume an open commitment, if `edicta-pending.json` exists.
 * Returns null when there is nothing to resume. Throws when a pending file
 * belongs to another checkout: that must not start a second deposit.
 */
export async function continueEdictaPending(input: {
  cfg: Config;
  checkoutId: string | null;
  fetchImpl?: typeof fetch;
}): Promise<EdictaContinue | null> {
  const pending = readEdictaPending(input.cfg.edictaPendingPath);
  if (!pending) return null;
  if (!sameJob(pending.checkoutId, input.checkoutId)) {
    const owner = pending.checkoutId ?? "the demo";
    const here = input.checkoutId ?? "the demo";
    throw new Error(
      `Edicta commitment ${pending.commitmentHash} is still open in ${input.cfg.edictaPendingPath} for ${owner}. This run is ${here}. This process will not request a new 402.`,
    );
  }
  const quote = parsePaymentRequired(pending.paymentRequiredHeader, null, pending.escrow);
  const prior = receiptFor(input.cfg.receiptsPath, quote.accepted.extra.paymentId);
  if (prior) {
    clearEdictaPending(input.cfg.edictaPendingPath);
    console.log(
      `Edicta commitment ${pending.commitmentHash} already has an inference receipt for ${prior.requestId}. Not paying again.`,
    );
    return { kind: "already", requestId: prior.requestId };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  console.log(`Edicta: resuming commitment ${pending.commitmentHash}. No new 402 and no second deposit.`);
  const result = await commitOnce({
    cfg: input.cfg,
    mode: pending.mode,
    header: pending.paymentRequiredHeader,
    build: {},
    resource: pending.resource,
    messages: pending.messages,
    fetchImpl,
    resumeHash: pending.commitmentHash,
  });
  if (result.commitmentHash !== pending.commitmentHash) {
    throw new EdictaCommitError(
      `Resume returned ${result.commitmentHash}, not ${pending.commitmentHash}`,
      "bad_response",
      200,
      pending.commitmentHash,
      false,
    );
  }
  const paid = await payWithSignature({
    cfg: input.cfg,
    quote,
    messages: pending.messages,
    model: pending.model,
    maxTokens: pending.maxTokens,
    baseUrl: pending.houstonBase,
    result,
    fetchImpl,
  });
  return { kind: "paid", quote, paid };
}
