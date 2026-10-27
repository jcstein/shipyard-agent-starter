import { blobPayload, fetchReceiptBlob, localPostMatches, readPostLog } from "./celestia.ts";
import { loadConfig } from "./config.ts";
import { readReceiptBlob, runMochaHelper, type HelperRun } from "./mocha.ts";
import { formatTia } from "./money.ts";
import { readReceiptLines, verifyHashChain } from "./receipts.ts";

const DRY_RUN_CHECKOUT = "dry_run_not_a_stripe_payment";

type SaleView = {
  checkoutId: string;
  paymentId: string | null;
  amount: string;
  livemode: boolean;
};

type InferenceView = {
  checkoutId: string;
  stripePaymentId: string | null;
  tiaCharged: string | null;
  tiaQuoted: string;
  dryRun: boolean;
  edictaCommitment: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function weiText(wei: string): string {
  return /^\d+$/.test(wei) ? `${formatTia(BigInt(wei))} TIA (${wei} wei)` : wei;
}

/** Pair a checkout sale with the inference it paid for. The dry-run example sale is skipped. */
export function describeCheckoutJobs(lines: string[]): string[] {
  const sales: SaleView[] = [];
  const inferences: InferenceView[] = [];
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event) || typeof event.checkoutId !== "string") continue;
    if (event.checkoutId === DRY_RUN_CHECKOUT) continue;
    if (event.type === "sale") {
      sales.push({
        checkoutId: event.checkoutId,
        paymentId: typeof event.paymentId === "string" ? event.paymentId : null,
        amount: typeof event.amount === "string" ? event.amount : "0.00",
        livemode: event.livemode === true,
      });
    }
    if (event.type === "inference") {
      const edicta = isRecord(event.edicta) ? event.edicta : null;
      inferences.push({
        checkoutId: event.checkoutId,
        stripePaymentId: typeof event.stripePaymentId === "string" ? event.stripePaymentId : null,
        tiaCharged: typeof event.tiaCharged === "string" ? event.tiaCharged : null,
        tiaQuoted: typeof event.tiaQuoted === "string" ? event.tiaQuoted : "0",
        dryRun: event.dryRun === true,
        edictaCommitment: edicta && typeof edicta.commitmentHash === "string" ? edicta.commitmentHash : null,
      });
    }
  }
  return sales.map((sale) => {
    const inference = inferences.find((item) => item.checkoutId === sale.checkoutId);
    const gbp = sale.livemode
      ? `£${sale.amount} in (livemode true). Only an outside customer paying in live mode is revenue.`
      : `£${sale.amount} in (livemode false, not revenue).`;
    if (!inference) return `Job ${sale.checkoutId}: ${gbp} Inference is not recorded yet.`;
    const tia = inference.dryRun
      ? "TIA not charged (dry-run mock, no Houston call)."
      : inference.tiaCharged === null
        ? `TIA charged was not reported. Quote ceiling ${weiText(inference.tiaQuoted)}.`
        : `TIA charged ${weiText(inference.tiaCharged)}. Quote ceiling ${weiText(inference.tiaQuoted)}.`;
    const payment =
      sale.paymentId && inference.stripePaymentId === sale.paymentId
        ? `Stripe payment ${sale.paymentId} is on both receipts.`
        : `Sale payment ${sale.paymentId ?? "absent"}; inference payment ${inference.stripePaymentId ?? "absent"}.`;
    const edicta = inference.edictaCommitment ? ` Edicta commitment ${inference.edictaCommitment}.` : "";
    return `Job ${sale.checkoutId}: ${gbp} ${tia} ${payment}${edicta}`;
  });
}

export async function verifyReceipts(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  run: HelperRun = runMochaHelper,
): Promise<string[]> {
  const cfg = loadConfig(env);
  const lines = readReceiptLines(cfg.receiptsPath);
  verifyHashChain(lines);
  const notes = [`Hash chain: ${lines.length} receipt${lines.length === 1 ? "" : "s"}, ok.`];
  notes.push(...describeCheckoutJobs(lines));
  const log = readPostLog(cfg.postsPath, cfg.namespaceId);
  if (log.posts.length === 0) {
    notes.push("No Mocha posts recorded.");
    return notes;
  }
  if (log.namespaceId !== cfg.namespaceId) {
    throw new Error(`posts.json namespace is ${log.namespaceId}, config is ${cfg.namespaceId}`);
  }
  for (const [index, post] of log.posts.entries()) {
    localPostMatches(lines, post);
    if (post.mock || post.height === null || post.commitment === null) {
      notes.push(
        `Post ${index + 1}: mock, lines ${post.lineStart}-${post.lineEnd}, local payload matches. Mocha was not queried. A mock post is not a Celestia proof and not revenue.`,
      );
      continue;
    }
    const data = cfg.celestiaRpc
      ? await fetchReceiptBlob({
          rpcUrl: cfg.celestiaRpc,
          token: cfg.celestiaToken,
          namespaceId: cfg.namespaceId,
          height: post.height,
          commitment: post.commitment,
          fetchImpl,
        })
      : await readReceiptBlob(cfg, post.height, post.commitment, run);
    const expected = Buffer.from(blobPayload(lines.slice(post.lineStart, post.lineEnd)));
    if (!data.equals(expected)) {
      throw new Error(`Post ${index + 1} blob at height ${post.height} does not match the local receipt lines`);
    }
    notes.push(
      `Post ${index + 1}: Mocha height ${post.height}, commitment ${post.commitment}, blob matches the local lines. This is a testnet log, not revenue.`,
    );
  }
  return notes;
}

const isMain = process.argv[1]?.endsWith("verify.ts") === true;
if (isMain) {
  verifyReceipts()
    .then((notes) => {
      for (const note of notes) console.log(note);
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
