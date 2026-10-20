import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendReceipt, committedWei, readReceiptLines, verifyHashChain } from "../src/receipts.ts";

describe("receipts", () => {
  it("chains hashes and ignores dry-run deposits in the cap", () => {
    const path = join(mkdtempSync(join(tmpdir(), "receipts-")), "receipts.jsonl");
    appendReceipt(path, {
      type: "inference",
      requestId: "0x" + "ab".repeat(32),
      model: "qwen/qwen-flash",
      tokensIn: null,
      tokensOut: null,
      tiaCharged: null,
      tiaQuoted: "1000",
      escrow: "0x65d77c98E73DFbEA91eCb72B27c9753e186a94c8",
      depositTxHash: null,
      paymentHeaderSha256: null,
      quoteHeaderSha256: "aa",
      dryRun: true,
    });
    appendReceipt(path, {
      type: "human",
      who: "Ada",
      what: "checked the log",
      why: "the quote was a dry-run",
    });
    const lines = readReceiptLines(path);
    verifyHashChain(lines);
    assert.equal(committedWei(lines), 0n);
    const broken = lines.slice();
    broken[0] = broken[0]?.replace("qwen-flash", "other-model") ?? "";
    assert.throws(() => verifyHashChain(broken), /hash chain/);
  });
});
