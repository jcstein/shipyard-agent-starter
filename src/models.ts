import { HOUSTON_INFERENCE } from "./eden.ts";
import {
  BUDGET_USD,
  formatModelCostTable,
  parseModelList,
  TYPICAL_INPUT_TOKENS,
  TYPICAL_OUTPUT_TOKENS,
} from "./model-costs.ts";

const base = (process.env.HOUSTON_BASE_URL?.trim() || HOUSTON_INFERENCE).replace(/\/$/, "");
const url = `${base}/models`;

fetch(url, { signal: AbortSignal.timeout(15_000) })
  .then(async (res) => {
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    const body: unknown = await res.json();
    console.log(`Prices from ${url}`);
    console.log(
      `Typical call: ${TYPICAL_INPUT_TOKENS} input tokens and ${TYPICAL_OUTPUT_TOKENS} output tokens.`,
    );
    console.log(
      `Calls / $${BUDGET_USD} is $${BUDGET_USD} divided by that cost. Output tokens / $${BUDGET_USD} is that many calls times ${TYPICAL_OUTPUT_TOKENS}.`,
    );
    console.log("Counts are rounded to the nearest whole number. Re-check the endpoint; prices change.");
    console.log("");
    process.stdout.write(formatModelCostTable(parseModelList(body)));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
