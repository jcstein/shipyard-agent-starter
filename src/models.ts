import { HOUSTON_INFERENCE } from "./eden.ts";
import {
  COINGECKO_EXCHANGE_RATES,
  describeBudget,
  formatModelCostTable,
  parseModelList,
  readBudgetGbp,
  readGbpUsdOverride,
  TYPICAL_INPUT_TOKENS,
  TYPICAL_OUTPUT_TOKENS,
  usdPerGbpFromCoinGecko,
} from "./model-costs.ts";

const base = (process.env.HOUSTON_BASE_URL?.trim() || HOUSTON_INFERENCE).replace(/\/$/, "");
const modelsUrl = `${base}/models`;

Promise.resolve()
  .then(async () => {
    const gbp = readBudgetGbp();
    const override = readGbpUsdOverride();
    const [rate, res] = await Promise.all([
      loadUsdPerGbp(override),
      fetch(modelsUrl, { signal: AbortSignal.timeout(15_000) }),
    ]);
    if (!res.ok) throw new Error(`GET ${modelsUrl} returned ${res.status}`);
    const body: unknown = await res.json();
    const budget = { gbp, usdPerGbp: rate.usdPerGbp };
    console.log(`Prices from ${modelsUrl}`);
    console.log(`Budget: ${describeBudget(budget)} (${rate.source}, ${formatUtcDate(new Date())}).`);
    console.log(
      `Typical call: ${TYPICAL_INPUT_TOKENS} input tokens and ${TYPICAL_OUTPUT_TOKENS} output tokens.`,
    );
    console.log(
      `Calls are the USD value of that GBP budget divided by the USD call cost. Output tokens are that many calls times ${TYPICAL_OUTPUT_TOKENS}.`,
    );
    console.log("Counts are rounded to the nearest whole number. Re-check both endpoints; prices change.");
    console.log("");
    process.stdout.write(formatModelCostTable(parseModelList(body), budget));
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });

function formatUtcDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

async function loadUsdPerGbp(gbpUsd: number | null): Promise<{ usdPerGbp: number; source: string }> {
  if (gbpUsd !== null) return { usdPerGbp: gbpUsd, source: "GBP_USD" };
  const res = await fetch(COINGECKO_EXCHANGE_RATES, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${COINGECKO_EXCHANGE_RATES} returned ${res.status}. Set GBP_USD to USD per 1 GBP.`);
  }
  return { usdPerGbp: usdPerGbpFromCoinGecko(await res.json()), source: "CoinGecko" };
}
