import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callCostUsd, formatModelCostTable, parseModelList } from "../src/model-costs.ts";

const flash = { id: "qwen/qwen-flash", inputUsdPer1m: 0.022, outputUsdPer1m: 0.22 };

describe("model costs", () => {
  it("prices the measured qwen-flash call from the list rates", () => {
    assert.equal(callCostUsd(flash, 31, 19), "0.000004862");
    assert.equal(callCostUsd(flash, 2_000, 500), "0.000154");
  });

  it("sorts by typical-call cost, then id, and counts calls per $10", () => {
    const table = formatModelCostTable([
      { id: "openai/gpt-5.5", inputUsdPer1m: 5, outputUsdPer1m: 30 },
      { id: "z-ai/glm-5.3-flash", inputUsdPer1m: 0.15, outputUsdPer1m: 0.5 },
      { id: "openai/gpt-oss-120b", inputUsdPer1m: 0.1, outputUsdPer1m: 0.7 },
      flash,
    ]);
    const ids = [...table.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    assert.deepEqual(ids, ["qwen/qwen-flash", "openai/gpt-oss-120b", "z-ai/glm-5.3-flash", "openai/gpt-5.5"]);
    assert.match(table, /\| `qwen\/qwen-flash` \| 0\.022 \| 0\.22 \| 0\.000154 \| 64,935 \| 32,467,532 \|/);
    assert.match(table, /\| `openai\/gpt-5\.5` \| 5 \| 30 \| 0\.025 \| 400 \| 200,000 \|/);
  });

  it("reads id and the two rates and ignores the other fields", () => {
    const models = parseModelList({
      models: [{ id: flash.id, provider: "qwen", name: "Qwen Flash", input_usd_per_1m: 0.022, output_usd_per_1m: 0.22 }],
    });
    assert.deepEqual(models, [flash]);
  });

  it("prints unlimited when the list price is zero", () => {
    const table = formatModelCostTable([{ id: "free/zero", inputUsdPer1m: 0, outputUsdPer1m: 0 }]);
    assert.match(table, /\| `free\/zero` \| 0 \| 0 \| 0 \| unlimited \| unlimited \|/);
  });

  it("rejects a body that is not a model list", () => {
    assert.throws(() => parseModelList({}), /missing models/);
    assert.throws(() => parseModelList({ models: [{ id: "x" }] }), /input_usd_per_1m/);
  });
});
