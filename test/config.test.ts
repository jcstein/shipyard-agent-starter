import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { DEFAULT_TASK } from "../src/jobs.ts";
import { DEMO_MESSAGES } from "../src/run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("HOUSTON_MAX_TOKENS", () => {
  it("defaults to 128 for the one-sentence pitch", () => {
    assert.equal(loadConfig({}).maxTokens, 128);
    assert.equal(DEMO_MESSAGES[0]?.content, DEFAULT_TASK);
    assert.match(DEFAULT_TASK, /one sentence/);
    assert.match(DEFAULT_TASK, /£15–£30/);
  });

  it("keeps the 1–4096 range", () => {
    assert.equal(loadConfig({ HOUSTON_MAX_TOKENS: "1" }).maxTokens, 1);
    assert.equal(loadConfig({ HOUSTON_MAX_TOKENS: "32" }).maxTokens, 32);
    assert.equal(loadConfig({ HOUSTON_MAX_TOKENS: "4096" }).maxTokens, 4096);
    for (const value of ["0", "4097", "-1", "1.5", "nope", ""]) {
      assert.throws(
        () => loadConfig({ HOUSTON_MAX_TOKENS: value }),
        /HOUSTON_MAX_TOKENS must be an integer from 1 to 4096/,
      );
    }
  });

  it("matches the documented default", () => {
    const example = readFileSync(join(root, ".env.example"), "utf8");
    const readme = readFileSync(join(root, "README.md"), "utf8");
    assert.match(example, /^HOUSTON_MAX_TOKENS=256$/m);
    assert.match(
      readme,
      /`HOUSTON_MAX_TOKENS` \| Completion cap \(`max_tokens`\)\. Unset defaults to `128`, range 1–4096\. `\.env\.example` sets `256`\./,
    );
  });
});
