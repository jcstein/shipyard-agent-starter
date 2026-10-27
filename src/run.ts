import type { Config } from "./config.ts";
import { localPostMatches, readPostLog, recordMockPost, writePostLog } from "./celestia.ts";
import {
  assertFacilitatorSigned,
  assertQuoteUsd,
  describeQuote,
  fetchQuote,
  isQuote,
  payAndComplete,
  paymentHeaderSha256,
  PaidRequestError,
  type ChatMessage,
  type ParsedQuote,
} from "./houston.ts";
import { edenTxUrl } from "./eden.ts";
import { sha256Hex } from "./hash.ts";
import { postUnpostedReceipts, type ReceiptPostDeps } from "./mocha.ts";
import { assertWithinCap, formatTia } from "./money.ts";
import { appendReceipt, committedWei, readReceiptLines } from "./receipts.ts";
import { openPaymentTrace, tracingFetch, type Tracer } from "./trace.ts";

const PROMPT =
  "In one sentence, pitch a £15–£30 service a small agent could sell to a person or small business for GBP this week. Do not spend money.";

export const DEMO_MESSAGES: ChatMessage[] = [{ role: "user", content: PROMPT }];

export async function runDemo(
  cfg: Config,
  fetchImpl: typeof fetch = fetch,
  postDeps: ReceiptPostDeps = {},
): Promise<void> {
  if (cfg.mode === "live" && !cfg.privateKey) {
    throw new Error("DEMO_MODE=live requires EDEN_PRIVATE_KEY. The default dry-run spends nothing.");
  }

  let activeFetch = fetchImpl;
  let tracer: Tracer | null = null;
  if (cfg.mode === "live" && cfg.privateKey) {
    tracer = openPaymentTrace({
      dir: cfg.tracesDir,
      signField: cfg.signField,
      retryOtherSignField: cfg.retryOtherSignField,
      secrets: [cfg.privateKey, cfg.stripeSecret, cfg.stripeWebhookSecret, cfg.celestiaToken].filter(
        (item): item is string => Boolean(item),
      ),
    });
    activeFetch = tracingFetch(fetchImpl, tracer);
  }

  try {
    await runQuoted(cfg, activeFetch, postDeps);
  } finally {
    if (tracer) {
      try {
        tracer.flush();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      console.log(`trace: ${tracer.path}`);
    }
  }
}

async function runQuoted(cfg: Config, fetchImpl: typeof fetch, postDeps: ReceiptPostDeps): Promise<void> {
  const quoted = await fetchQuote({
    baseUrl: cfg.houstonBase,
    model: cfg.model,
    messages: DEMO_MESSAGES,
    maxTokens: cfg.maxTokens,
    escrow: cfg.escrow,
    fetchImpl,
    step: "quote",
  });
  if (!isQuote(quoted)) {
    throw new Error("expected a 402 quote. The endpoint returned a completion without payment.");
  }
  assertFacilitatorSigned(quoted);
  console.log(describeQuote(quoted, cfg.spendCapWei));

  const spent = committedWei(readReceiptLines(cfg.receiptsPath));
  const next = BigInt(quoted.accepted.amount);
  assertWithinCap({ capWei: cfg.spendCapWei, committedWei: spent, nextWei: next, label: "quote" });
  assertQuoteUsd(quoted, cfg.spendCapUsdWei);
  console.log(`  already committed: ${formatTia(spent)} TIA`);
  console.log(`  this quote fits the cap`);

  if (cfg.mode === "dry-run") {
    writeDryRun(cfg, quoted);
    return;
  }

  try {
    const paid = await payAndComplete({ cfg, quote: quoted, messages: DEMO_MESSAGES, committedWei: spent, fetchImpl });
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
    });
    console.log(`model: ${text}`);
    console.log(`deposit: ${paid.depositTxHash} ${edenTxUrl(paid.depositTxHash)}`);
    console.log(`payment signature field: ${paid.signFieldUsed}`);
    console.log(`payment header sha256: ${paymentHeaderSha256(paid.paymentHeader)}`);
    const decoded = paid.paymentResponseDecoded;
    if (decoded) {
      console.log(
        `payment-response: success ${String(decoded.success)}, network ${decoded.network ?? "absent"}, payer ${decoded.payer ?? "absent"}`,
      );
    } else if (paid.paymentResponse) {
      console.log("payment-response header was present but was not JSON.");
    } else {
      console.log("payment-response header was absent.");
    }
    if (paid.costTia) {
      const usd = paid.costUsd ? `, cost_usd ${paid.costUsd}` : "";
      console.log(`houston cost_tia: ${formatTia(BigInt(paid.costTia))} TIA (${paid.costTia} wei)${usd}`);
    }
    const depositUrl = edenTxUrl(paid.depositTxHash);
    if (paid.tiaCharged === null) {
      console.log(
        `settled TIA was not in the houston block or payment-response; tiaCharged is null. The quote is a ceiling, not the charge. ${depositUrl}`,
      );
    } else {
      console.log(`tiaCharged: ${paid.tiaCharged} wei. The quote is a ceiling, not this charge. ${depositUrl}`);
    }
    console.log("Local receipt written. Submitting unposted lines to Mocha. That post is a testnet log, not revenue.");
    await postUnpostedReceipts(cfg, postDeps, "demo");
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
      });
    }
    throw error;
  }
}

function writeDryRun(cfg: Config, quote: ParsedQuote): void {
  const now = new Date();
  appendReceipt(
    cfg.receiptsPath,
    {
      type: "inference",
      requestId: quote.accepted.extra.paymentId,
      model: cfg.model,
      tokensIn: null,
      tokensOut: null,
      tiaCharged: null,
      tiaQuoted: quote.accepted.amount,
      escrow: quote.accepted.extra.escrowContract,
      depositTxHash: null,
      paymentHeaderSha256: null,
      quoteHeaderSha256: sha256Hex(quote.header),
      dryRun: true,
    },
    now,
  );
  appendReceipt(
    cfg.receiptsPath,
    {
      type: "sale",
      checkoutId: "dry_run_not_a_stripe_payment",
      paymentId: null,
      amount: "0.00",
      currency: "GBP",
      customerRef: "dry-run",
      livemode: false,
      note: "Example line only. Not a customer payment and not revenue.",
    },
    now,
  );
  appendReceipt(
    cfg.receiptsPath,
    {
      type: "human",
      who: "demo",
      what: "skipped the Eden deposit and the Mocha submit",
      why: "Dry-run has no wallet key. It must not spend TIA or present a testnet post as revenue.",
    },
    now,
  );

  const lines = readReceiptLines(cfg.receiptsPath);
  const log = readPostLog(cfg.postsPath, cfg.namespaceId);
  if (log.namespaceId !== cfg.namespaceId) {
    throw new Error(`posts.json namespace is ${log.namespaceId}, config is ${cfg.namespaceId}`);
  }
  const start = log.posts.reduce((max, post) => Math.max(max, post.lineEnd), 0);
  const fresh = lines.slice(start);
  const post = recordMockPost(log, fresh, start, now);
  writePostLog(cfg.postsPath, log);
  localPostMatches(lines, post);

  console.log("");
  console.log("Dry-run receipts (nothing was paid, deposited, or posted to Celestia):");
  for (const line of fresh) console.log(line);
  console.log("");
  console.log(`mock Mocha post: lines ${post.lineStart}-${post.lineEnd}, payload sha256 ${post.payloadSha256}`);
  console.log("The mock post is local only. It is not a Celestia proof and it is not revenue.");
  console.log(
    "Dry-run records a local mock post only. It does not submit to Mocha, and `npm run post` skips these lines because posts.json already covers them.",
  );
  console.log(`wrote ${cfg.receiptsPath} and ${cfg.postsPath}`);
  console.log(`quote header sha256: ${sha256Hex(quote.header)}`);
}
