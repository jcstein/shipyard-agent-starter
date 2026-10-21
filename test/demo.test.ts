import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { runDemo } from "../src/run.ts";
import { verifyReceipts } from "../src/verify.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/payment-required.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { accepts: Array<{ extra: { serverSignature: string } }> };
const header = Buffer.from(JSON.stringify(fixture)).toString("base64");

function quoteFetch(): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (!url.endsWith("/chat/completions")) throw new Error(`unexpected ${url}`);
    return new Response(
      JSON.stringify({
        error: "Payment Required",
        message: "This endpoint requires x402 payment",
        price: { amount: "0.000007", currency: "TIA" },
      }),
      { status: 402, headers: { "payment-required": header } },
    );
  };
}

describe("demo", () => {
  it("dry-run writes a quote, three receipt types, and a mock post", async () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-"));
    const env = {
      RECEIPTS_PATH: join(dir, "receipts.jsonl"),
      POSTS_PATH: join(dir, "posts.json"),
      TRACE_DIR: join(dir, "traces"),
      SPEND_CAP_TIA: "0.05",
    };
    await runDemo(loadConfig(env), quoteFetch());
    const receipts = readFileSync(env.RECEIPTS_PATH, "utf8");
    assert.equal(receipts.includes(fixture.accepts[0]?.extra.serverSignature ?? "missing"), false);
    assert.match(receipts, /"type":"inference"/);
    assert.match(receipts, /"type":"sale"/);
    assert.match(receipts, /"type":"human"/);
    assert.match(receipts, /"dryRun":true/);
    assert.match(receipts, /"tiaCharged":null/);
    const notes = await verifyReceipts(env, async () => {
      throw new Error("verify should not call Mocha for a mock post");
    });
    assert.match(notes.join("\n"), /mock/);
    assert.match(notes.join("\n"), /not revenue/);
    assert.equal(existsSync(env.TRACE_DIR), false);
  });

  it("refuses live mode with no key before calling the network", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-nokey-"));
    const traces = join(dir, "traces");
    await assert.rejects(
      () =>
        runDemo(
          loadConfig({ DEMO_MODE: "live", TRACE_DIR: traces }),
          async () => {
            throw new Error("network was called");
          },
        ),
      /EDEN_PRIVATE_KEY/,
    );
    assert.equal(existsSync(traces), false);
  });

  it("refuses a quote above the spend cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-"));
    await assert.rejects(
      () =>
        runDemo(
          loadConfig({
            RECEIPTS_PATH: join(dir, "receipts.jsonl"),
            POSTS_PATH: join(dir, "posts.json"),
            SPEND_CAP_TIA: "0.000000000000001",
          }),
          quoteFetch(),
        ),
      /spend cap/,
    );
  });
});
