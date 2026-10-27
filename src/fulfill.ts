import type { Config } from "./config.ts";
import { edenTxUrl } from "./eden.ts";
import { sha256Hex } from "./hash.ts";
import {
  assertFacilitatorSigned,
  assertQuoteUsd,
  fetchQuote,
  isQuote,
  payAndComplete,
  paymentHeaderSha256,
  PaidRequestError,
  type ChatMessage,
} from "./houston.ts";
import { updateJob, type Job } from "./jobs.ts";
import { postUnpostedReceipts, type ReceiptPostDeps } from "./mocha.ts";
import { assertWithinCap, formatTia } from "./money.ts";
import { appendReceipt, committedWei, findByCheckout, readReceiptLines } from "./receipts.ts";
import { openPaymentTrace, redactSecrets, tracingFetch, type Tracer } from "./trace.ts";

export function mockInferenceText(task: string): string {
  return `Mock inference (dry-run). No Houston call was made and no TIA was spent. Task: ${task}`;
}

function safeError(cfg: Config, error: unknown): string {
  const message = error instanceof Error ? error.message : "job failed";
  const secrets = [cfg.privateKey, cfg.stripeSecret, cfg.stripeWebhookSecret, cfg.celestiaToken].filter(
    (item): item is string => Boolean(item),
  );
  const scrubbed = redactSecrets(message, secrets);
  return scrubbed.length > 2000 ? `${scrubbed.slice(0, 2000)}…` : scrubbed;
}

function finish(cfg: Config, job: Job, result: string, requestId: string, dryRun: boolean): void {
  updateJob(cfg.jobsPath, job.checkoutId, {
    status: "done",
    result,
    error: null,
    requestId,
    dryRun,
    finishedAt: new Date().toISOString(),
  });
}

/**
 * Run the task for one claimed checkout.
 * Dry-run writes a mock result and does not call Houston.
 * Live uses the same quote, deposit, and Payment-Signature path as `npm run demo`.
 * A checkout that already has an inference receipt is not run again.
 * After a successful finish, unposted receipt lines are submitted to Mocha.
 * A Mocha failure is logged and does not change the job or the receipts.
 */
export async function fulfillCheckout(
  cfg: Config,
  job: Job,
  fetchImpl: typeof fetch = fetch,
  postDeps: ReceiptPostDeps = {},
): Promise<void> {
  let succeeded = false;
  try {
    updateJob(cfg.jobsPath, job.checkoutId, { status: "running" });
    const prior = findByCheckout(cfg.receiptsPath, "inference", job.checkoutId);
    if (prior && prior.type === "inference") {
      finish(
        cfg,
        job,
        job.result ?? "Inference receipt already recorded for this checkout.",
        prior.requestId,
        prior.dryRun,
      );
      console.log(`job ${job.checkoutId} already has an inference receipt. Not running it again.`);
      succeeded = true;
      return;
    }
    if (cfg.mode !== "live") {
      writeMock(cfg, job);
      succeeded = true;
      return;
    }
    await writeLive(cfg, job, fetchImpl);
    succeeded = true;
  } catch (error) {
    const message = safeError(cfg, error);
    try {
      updateJob(cfg.jobsPath, job.checkoutId, {
        status: "failed",
        error: message,
        finishedAt: new Date().toISOString(),
      });
    } catch (writeError) {
      console.error(writeError instanceof Error ? writeError.message : writeError);
    }
    console.error(`job ${job.checkoutId} failed: ${message}`);
  } finally {
    if (succeeded) await postUnpostedReceipts(cfg, postDeps, `job ${job.checkoutId}`);
  }
}

function writeMock(cfg: Config, job: Job): void {
  const text = mockInferenceText(job.task);
  const requestId = `dry-run:${job.checkoutId}`;
  appendReceipt(cfg.receiptsPath, {
    type: "inference",
    requestId,
    model: cfg.model,
    tokensIn: null,
    tokensOut: null,
    tiaCharged: null,
    tiaQuoted: "0",
    escrow: cfg.escrow,
    depositTxHash: null,
    paymentHeaderSha256: null,
    quoteHeaderSha256: sha256Hex(`dry-run:${job.checkoutId}`),
    dryRun: true,
    checkoutId: job.checkoutId,
    stripePaymentId: job.stripePaymentId,
  });
  finish(cfg, job, text, requestId, true);
  console.log(`job ${job.checkoutId} done. Mock inference, no TIA spent. Test-mode payments are not revenue.`);
  console.log(text);
}

async function writeLive(cfg: Config, job: Job, fetchImpl: typeof fetch): Promise<void> {
  if (!cfg.privateKey) {
    throw new Error("DEMO_MODE=live requires EDEN_PRIVATE_KEY. Dry-run uses mock inference and spends no TIA.");
  }
  const messages: ChatMessage[] = [{ role: "user", content: job.task }];
  const tracer: Tracer = openPaymentTrace({
    dir: cfg.tracesDir,
    signField: cfg.signField,
    retryOtherSignField: cfg.retryOtherSignField,
    secrets: [cfg.privateKey, cfg.stripeSecret, cfg.stripeWebhookSecret, cfg.celestiaToken].filter(
      (item): item is string => Boolean(item),
    ),
  });
  const activeFetch = tracingFetch(fetchImpl, tracer);
  try {
    const quoted = await fetchQuote({
      baseUrl: cfg.houstonBase,
      model: cfg.model,
      messages,
      maxTokens: cfg.maxTokens,
      escrow: cfg.escrow,
      fetchImpl: activeFetch,
      step: "quote",
    });
    if (!isQuote(quoted)) {
      throw new Error("expected a 402 quote. The endpoint returned a completion without payment.");
    }
    assertFacilitatorSigned(quoted);
    const spent = committedWei(readReceiptLines(cfg.receiptsPath));
    const next = BigInt(quoted.accepted.amount);
    assertWithinCap({ capWei: cfg.spendCapWei, committedWei: spent, nextWei: next, label: "quote" });
    assertQuoteUsd(quoted, cfg.spendCapUsdWei);

    try {
      const paid = await payAndComplete({
        cfg,
        quote: quoted,
        messages,
        committedWei: spent,
        fetchImpl: activeFetch,
      });
      const text = paid.completion.choices?.[0]?.message?.content ?? "";
      appendReceipt(cfg.receiptsPath, {
        type: "inference",
        requestId: quoted.accepted.extra.paymentId,
        model: cfg.model,
        tokensIn: paid.completion.usage?.prompt_tokens ?? null,
        tokensOut: paid.completion.usage?.completion_tokens ?? null,
        tiaCharged: paid.tiaCharged,
        tiaQuoted: quoted.accepted.amount,
        escrow: quoted.accepted.extra.escrowContract,
        depositTxHash: paid.depositTxHash,
        paymentHeaderSha256: paymentHeaderSha256(paid.paymentHeader),
        quoteHeaderSha256: sha256Hex(quoted.header),
        dryRun: false,
        checkoutId: job.checkoutId,
        stripePaymentId: job.stripePaymentId,
      });
      finish(cfg, job, text, quoted.accepted.extra.paymentId, false);
      const money = job.livemode
        ? "Livemode true. Only an outside customer paying in live mode is revenue."
        : "Test mode is not revenue.";
      const depositUrl = edenTxUrl(paid.depositTxHash);
      console.log(`job ${job.checkoutId} done. ${money}`);
      console.log(text);
      console.log(`deposit: ${paid.depositTxHash} ${depositUrl}`);
      if (paid.tiaCharged === null) {
        console.log(`tiaCharged is null. The quote is a ceiling, not the charge. ${depositUrl}`);
      } else {
        console.log(
          `tiaCharged: ${formatTia(BigInt(paid.tiaCharged))} TIA (${paid.tiaCharged} wei). The quote is a ceiling, not this charge. ${depositUrl}`,
        );
      }
    } catch (error) {
      if (error instanceof PaidRequestError && error.depositTxHash) {
        appendReceipt(cfg.receiptsPath, {
          type: "inference",
          requestId: quoted.accepted.extra.paymentId,
          model: cfg.model,
          tokensIn: null,
          tokensOut: null,
          tiaCharged: null,
          tiaQuoted: quoted.accepted.amount,
          escrow: quoted.accepted.extra.escrowContract,
          depositTxHash: error.depositTxHash,
          paymentHeaderSha256: null,
          quoteHeaderSha256: sha256Hex(quoted.header),
          dryRun: false,
          checkoutId: job.checkoutId,
          stripePaymentId: job.stripePaymentId,
        });
      }
      throw error;
    }
  } finally {
    try {
      tracer.flush();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    console.log(`trace: ${tracer.path}`);
  }
}
