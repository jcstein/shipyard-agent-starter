import { blobPayload, fetchReceiptBlob, localPostMatches, mochaReadHint, readPostLog } from "./celestia.ts";
import { loadConfig } from "./config.ts";
import { readReceiptLines, verifyHashChain } from "./receipts.ts";

export async function verifyReceipts(env = process.env, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const cfg = loadConfig(env);
  const lines = readReceiptLines(cfg.receiptsPath);
  verifyHashChain(lines);
  const notes = [`Hash chain: ${lines.length} receipt${lines.length === 1 ? "" : "s"}, ok.`];
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
    if (!cfg.celestiaRpc) {
      throw new Error(`Post ${index + 1} is a real Mocha blob at height ${post.height}, but CELESTIA_RPC_URL is unset. ${mochaReadHint()}`);
    }
    const data = await fetchReceiptBlob({
      rpcUrl: cfg.celestiaRpc,
      token: cfg.celestiaToken,
      namespaceId: cfg.namespaceId,
      height: post.height,
      commitment: post.commitment,
      fetchImpl,
    });
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
