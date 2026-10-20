import { mochaReadHint, readPostLog, submitReceiptBlob, unpostedLines, writePostLog } from "./celestia.ts";
import { loadConfig } from "./config.ts";
import { readReceiptLines } from "./receipts.ts";

const cfg = loadConfig();
const lines = readReceiptLines(cfg.receiptsPath);
const log = readPostLog(cfg.postsPath, cfg.namespaceId);
if (log.namespaceId !== cfg.namespaceId) {
  console.error(`posts.json namespace is ${log.namespaceId}, config is ${cfg.namespaceId}`);
  process.exitCode = 1;
} else {
  const pending = unpostedLines(lines, log);
  if (pending.lines.length === 0) {
    const mocks = log.posts.filter((post) => post.mock).length;
    if (mocks > 0 && mocks === log.posts.length) {
      console.log(
        "No unposted receipt lines. The recorded post is a local mock and was not sent to Mocha. A live inference, a Stripe sale, or `npm run human` adds lines you can submit.",
      );
    } else {
      console.log("No unposted receipt lines.");
    }
  } else if (!cfg.celestiaRpc) {
    console.error(`CELESTIA_RPC_URL is required to submit a blob. ${mochaReadHint()}`);
    console.error("A missing node is not a Mocha post. Nothing was marked as posted.");
    process.exitCode = 1;
  } else {
    submitReceiptBlob({
      rpcUrl: cfg.celestiaRpc,
      token: cfg.celestiaToken,
      namespaceId: cfg.namespaceId,
      lines: pending.lines,
    })
      .then((posted) => {
        log.posts.push({
          at: new Date().toISOString(),
          lineStart: pending.start,
          lineEnd: pending.start + pending.lines.length,
          mock: false,
          height: posted.height,
          commitment: posted.commitment,
          payloadSha256: posted.payloadSha256,
        });
        writePostLog(cfg.postsPath, log);
        console.log(`Submitted ${pending.lines.length} lines to Mocha (${cfg.namespaceId}).`);
        console.log(`height ${posted.height}`);
        console.log(`commitment ${posted.commitment}`);
        console.log("Mocha is testnet. This blob is a log, not revenue.");
      })
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
      });
  }
}
