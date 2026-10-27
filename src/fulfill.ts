import type { Config } from "./config.ts";
import {
  clearEdictaPending,
  continueEdictaPending,
  describeEdicta,
  edictaReceiptFields,
  EdictaPaidError,
  payThroughEdicta,
  recordFailedEdictaPayment,
} from "./edicta.ts";
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
import { assertWithinCap, formatTia } from "./money.ts";
import { appendReceipt, committedWei, findByCheckout, readReceiptLines, type EdictaNote } from "./receipts.ts";
import { openPaymentTrace, redactSecrets, tracingFetch, type Tracer } from "./trace.ts";

export function mockInferenceText(task: string): string {
  return `Mock inference (dry-run). No Houston call was made and no TIA was spent. Task: ${task}`;
}

function safeError(cfg: Config, error: unknown): string {
  const message = error instanceof Error ? error.message : "job failed";
  const secrets = [cfg.privateKey, cfg.edictaToken, cfg.stripeSecret, cfg.stripeWebhookSecret, cfg.celestiaToken].filter(
    (item): item is string => Boolean(item),
  );
  const scrubbed = redactSecrets(message, secrets);
  return scrubbed.length > 2000 ? `${scrubbed.slice(0, 2000)}…` : scrubbed;
}

function finish(cfg: Config, job: Job, result: string, requestId: string, dryRun: boolean, edicta?: EdictaNote): void {
  updateJob(cfg.jobsPath, job.checkoutId, {
    status: "done",
    result,
    error: null,
    requestId,
    dryRun,
    finishedAt: new Date().toISOString(),
    ...edictaReceiptFields(edicta),
  });
}

/**
 * Run the task for one claimed checkout.
 * Dry-run writes a mock result and does not call Houston.
 * Live uses the same quote, deposit, and Payment-Signature path as `npm run demo`.
 * A checkout that already has an inference receipt is not run again.
 */
export async function fulfillCheckout(cfg: Config, job: Job, fetchImpl: typeof fetch = fetch): Promise<void> {
  await Promise.resolve();
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
      return;
    }
    if (cfg.mode !== "live") {
      writeMock(cfg, job);
      return;
    }
    await writeLive(cfg, job, fetchImpl);
  } catch (error) {
    const message = safeError(cfg, error);
    const note = error instanceof EdictaPaidError ? error.note : undefined;
    try {
      updateJob(cfg.jobsPath, job.checkoutId, {
        status: "failed",
        error: message,
        finishedAt: new Date().toISOString(),
        ...edictaReceiptFields(note),
      });
    } catch (writeError) {
      console.error(writeError instanceof Error ? writeError.message : writeError);
    }
    console.error(`job ${job.checkoutId} failed: ${message}`);
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
  if (!cfg.edicta && !cfg.privateKey) {
    throw new Error("DEMO_MODE=live requires EDEN_PRIVATE_KEY. Dry-run uses mock inference and spends no TIA.");
  }
  const messages: ChatMessage[] = [{ role: "user", content: job.task }];
  const tracer: Tracer = openPaymentTrace({
    dir: cfg.tracesDir,
    signField: cfg.signField,
    retryOtherSignField: cfg.retryOtherSignField,
    secrets: [cfg.privateKey, cfg.edictaToken, cfg.stripeSecret, cfg.stripeWebhookSecret, cfg.celestiaToken].filter(
      (item): item is string => Boolean(item),
    ),
  });
  const activeFetch = tracingFetch(fetchImpl, tracer);
  try {
    if (cfg.edicta) {
      let continued: Awaited<ReturnType<typeof continueEdictaPending>>;
      try {
        continued = await continueEdictaPending({ cfg, checkoutId: job.checkoutId, fetchImpl: activeFetch });
      } catch (error) {
        if (error instanceof EdictaPaidError) {
          recordFailedEdictaPayment(cfg, error, { checkoutId: job.checkoutId, stripePaymentId: job.stripePaymentId });
        }
        throw error;
      }
      if (continued?.kind === "already") {
        finish(cfg, job, job.result ?? "Inference receipt already recorded for this checkout.", continued.requestId, false);
        return;
      }
      if (continued?.kind === "paid") {
        const paid = continued.paid;
        const text = paid.completion.choices?.[0]?.message?.content ?? "";
        appendReceipt(cfg.receiptsPath, {
          type: "inference",
          requestId: continued.quote.accepted.extra.paymentId,
          model: paid.model,
          tokensIn: paid.completion.usage?.prompt_tokens ?? null,
          tokensOut: paid.completion.usage?.completion_tokens ?? null,
          tiaCharged: paid.tiaCharged,
          tiaQuoted: continued.quote.accepted.amount,
          escrow: continued.quote.accepted.extra.escrowContract,
          depositTxHash: paid.depositTxHash,
          paymentHeaderSha256: paymentHeaderSha256(paid.paymentHeader),
          quoteHeaderSha256: sha256Hex(continued.quote.header),
          dryRun: false,
          checkoutId: job.checkoutId,
          stripePaymentId: job.stripePaymentId,
          ...edictaReceiptFields(paid.edicta),
        });
        clearEdictaPending(cfg.edictaPendingPath);
        finish(cfg, job, text, continued.quote.accepted.extra.paymentId, false, paid.edicta);
        console.log(describeEdicta(paid.edicta));
        console.log(text);
        return;
      }
    }
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
      const paid = cfg.edicta
        ? await payThroughEdicta({
            cfg,
            quote: quoted,
            messages,
            committedWei: spent,
            checkoutId: job.checkoutId,
            fetchImpl: activeFetch,
          })
        : await payAndComplete({
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
        ...edictaReceiptFields(paid.edicta),
      });
      if (paid.edicta) {
        clearEdictaPending(cfg.edictaPendingPath);
        console.log(describeEdicta(paid.edicta));
      }
      finish(cfg, job, text, quoted.accepted.extra.paymentId, false, paid.edicta);
      const money = job.livemode
        ? "Livemode true. Only an outside customer paying in live mode is revenue."
        : "Test mode is not revenue.";
      console.log(`job ${job.checkoutId} done. ${money}`);
      console.log(text);
      if (paid.tiaCharged === null) {
        console.log("tiaCharged is null. The quote is a ceiling, not the charge.");
      } else {
        console.log(`tiaCharged: ${formatTia(BigInt(paid.tiaCharged))} TIA (${paid.tiaCharged} wei). The quote is a ceiling, not this charge.`);
      }
    } catch (error) {
      if (error instanceof PaidRequestError && error.depositTxHash) {
        const note = error instanceof EdictaPaidError ? error.note : null;
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
          ...edictaReceiptFields(note),
        });
        if (note) clearEdictaPending(cfg.edictaPendingPath);
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
