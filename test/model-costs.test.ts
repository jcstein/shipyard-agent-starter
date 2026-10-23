import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  callCostUsd,
  describeBudget,
  formatModelCostTable,
  parseModelList,
  readBudgetGbp,
  readGbpUsdOverride,
  usdPerGbpFromCoinGecko,
} from "../src/model-costs.ts";

const flash = { id: "qwen/qwen-flash", inputUsdPer1m: 0.022, outputUsdPer1m: 0.22 };
const budget = { gbp: 20, usdPerGbp: 1.338835 };

describe("model costs", () => {
  it("prices the measured qwen-flash call from the list rates", () => {
    assert.equal(callCostUsd(flash, 31, 19), "0.000004862");
    assert.equal(callCostUsd(flash, 2_000, 500), "0.000154");
  });

  it("converts £20 at the 23 Oct 2026 CoinGecko cross", () => {
    const rate = usdPerGbpFromCoinGecko({
      rates: { usd: { value: 81647.751 }, gbp: { value: 60984.175 } },
    });
    assert.equal(describeBudget({ gbp: 20, usdPerGbp: rate }), "£20 = $26.7767 at 1.338835 USD per GBP");
  });

  it("reads BUDGET_GBP and GBP_USD", () => {
    assert.equal(readBudgetGbp({}), 20);
    assert.equal(readBudgetGbp({ BUDGET_GBP: "12.5" }), 12.5);
    assert.equal(readGbpUsdOverride({}), null);
    assert.equal(readGbpUsdOverride({ GBP_USD: "1.34" }), 1.34);
    assert.throws(() => readBudgetGbp({ BUDGET_GBP: "0" }), /BUDGET_GBP/);
    assert.throws(() => usdPerGbpFromCoinGecko({}), /missing rates/);
  });

  it("sorts by typical-call cost, then id, and counts calls per £20", () => {
    const table = formatModelCostTable(
      [
        { id: "openai/gpt-5.5", inputUsdPer1m: 5, outputUsdPer1m: 30 },
        { id: "z-ai/glm-5.3-flash", inputUsdPer1m: 0.15, outputUsdPer1m: 0.5 },
        { id: "openai/gpt-oss-120b", inputUsdPer1m: 0.1, outputUsdPer1m: 0.7 },
        flash,
      ],
      budget,
    );
    const ids = [...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert.deepEqual(ids, ["qwen/qwen-flash", "openai/gpt-oss-120b", "z-ai/glm-5.3-flash", "openai/gpt-5.5"]);
    assert.match(table, /Calls \/ £20 \(\$26\.7767\)/);
    assert.match(table, /\| `qwen\/qwen-flash` \| 0\.022 \| 0\.22 \| 0\.000154 \| 173,875 \| 86,937,338 \|/);
    assert.match(table, /\| `openai\/gpt-5\.5` \| 5 \| 30 \| 0\.025 \| 1,071 \| 535,534 \|/);
  });

  it("reads id and the two rates and ignores the other fields", () => {
    const models = parseModelList({
      models: [{ id: flash.id, provider: "qwen", name: "Qwen Flash", input_usd_per_1m: 0.022, output_usd_per_1m: 0.22 }],
    });
    assert.deepEqual(models, [flash]);
  });

  it("prints unlimited when the list price is zero", () => {
    const table = formatModelCostTable([{ id: "free/zero", inputUsdPer1m: 0, outputUsdPer1m: 0 }], budget);
    assert.match(table, /\| `free\/zero` \| 0 \| 0 \| 0 \| unlimited \| unlimited \|/);
  });

  it("rejects a body that is not a model list", () => {
    assert.throws(() => parseModelList({}), /missing models/);
    assert.throws(() => parseModelList({ models: [{ id: "x" }] }), /input_usd_per_1m/);
  });
});
