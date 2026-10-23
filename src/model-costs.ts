/** USD rates from Houston `GET /v1/models`, turned into a cost table for a GBP budget. */

export const TYPICAL_INPUT_TOKENS = 2_000;
export const TYPICAL_OUTPUT_TOKENS = 500;
/** Default team budget for `npm run models`. Houston prices stay in USD. */
export const DEFAULT_BUDGET_GBP = 20;
export const COINGECKO_EXCHANGE_RATES = "https://api.coingecko.com/api/v3/exchange_rates";

const MICRO = 1_000_000n;
const PICO = 1_000_000_000_000n;

export type ListedModel = {
  id: string;
  inputUsdPer1m: number;
  outputUsdPer1m: number;
};

export type BudgetInput = {
  /** Pounds, `BUDGET_GBP`. */
  gbp: number;
  /** USD per 1 GBP. Live CoinGecko rate, or `GBP_USD`. */
  usdPerGbp: number;
};

type ResolvedBudget = {
  gbpMicro: bigint;
  usdPerGbpMicro: bigint;
  budgetPico: bigint;
};

type PricedModel = ListedModel & {
  inputMicro: bigint;
  outputMicro: bigint;
  callPico: bigint;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function priceMicro(usd: number, label: string): bigint {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  const scaled = Math.round(usd * 1_000_000);
  if (!Number.isSafeInteger(scaled)) {
    throw new Error(`${label} is out of range`);
  }
  return BigInt(scaled);
}

function parsePositiveDecimal(value: string, label: string): number {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a positive decimal`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be greater than 0`);
  }
  return parsed;
}

export function readBudgetGbp(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BUDGET_GBP?.trim() ?? "";
  if (raw.length === 0) return DEFAULT_BUDGET_GBP;
  return parsePositiveDecimal(raw, "BUDGET_GBP");
}

/** `GBP_USD` is USD per 1 GBP. Unset means the caller should read a live rate. */
export function readGbpUsdOverride(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.GBP_USD?.trim() ?? "";
  if (raw.length === 0) return null;
  return parsePositiveDecimal(raw, "GBP_USD");
}

function rateValue(rates: Record<string, unknown>, code: string): number {
  const entry = rates[code];
  if (!isRecord(entry) || typeof entry.value !== "number" || !(entry.value > 0)) {
    throw new Error(`CoinGecko exchange rates are missing ${code}`);
  }
  return entry.value;
}

/** USD per GBP from CoinGecko `GET /api/v3/exchange_rates` (each fiat value is per 1 BTC). */
export function usdPerGbpFromCoinGecko(body: unknown): number {
  if (!isRecord(body) || !isRecord(body.rates)) {
    throw new Error("CoinGecko exchange rates are missing rates");
  }
  return rateValue(body.rates, "usd") / rateValue(body.rates, "gbp");
}

function resolveBudget(input: BudgetInput): ResolvedBudget {
  const gbpMicro = priceMicro(input.gbp, "BUDGET_GBP");
  const usdPerGbpMicro = priceMicro(input.usdPerGbp, "GBP_USD");
  if (gbpMicro === 0n) throw new Error("BUDGET_GBP must be greater than 0");
  if (usdPerGbpMicro === 0n) throw new Error("GBP_USD must be greater than 0");
  return { gbpMicro, usdPerGbpMicro, budgetPico: gbpMicro * usdPerGbpMicro };
}

/** `£20 = $26.7767 at 1.338835 USD per GBP`, using the rounded inputs the table divides by. */
export function describeBudget(input: BudgetInput): string {
  const budget = resolveBudget(input);
  const gbp = formatScaled(budget.gbpMicro, MICRO);
  const usd = formatScaled(budget.budgetPico, PICO);
  const rate = formatScaled(budget.usdPerGbpMicro, MICRO);
  return `£${gbp} = $${usd} at ${rate} USD per GBP`;
}

function tokenCount(tokens: number, label: string): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return BigInt(tokens);
}

/** Nearest integer, half away from zero for the positive amounts this table uses. */
function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("cannot divide by a non-positive cost");
  return (numerator + denominator / 2n) / denominator;
}

function formatScaled(value: bigint, scale: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / scale;
  const fracDigits = scale.toString().length - 1;
  const frac = (abs % scale).toString().padStart(fracDigits, "0").replace(/0+$/, "");
  const text = frac.length === 0 ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

function formatCount(value: bigint): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${withCommas}` : withCommas;
}

export function parseModelList(body: unknown): ListedModel[] {
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new Error("model list is missing models");
  }
  return body.models.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new Error(`model list entry ${index} is missing id`);
    }
    if (typeof entry.input_usd_per_1m !== "number" || typeof entry.output_usd_per_1m !== "number") {
      throw new Error(`model ${entry.id} is missing input_usd_per_1m or output_usd_per_1m`);
    }
    return {
      id: entry.id,
      inputUsdPer1m: entry.input_usd_per_1m,
      outputUsdPer1m: entry.output_usd_per_1m,
    };
  });
}

/** Call cost in USD, trimmed. `input_usd_per_1m` and `output_usd_per_1m` are the list rates. */
export function callCostUsd(model: ListedModel, inputTokens: number, outputTokens: number): string {
  const pico =
    priceMicro(model.inputUsdPer1m, `${model.id} input_usd_per_1m`) * tokenCount(inputTokens, "input tokens") +
    priceMicro(model.outputUsdPer1m, `${model.id} output_usd_per_1m`) * tokenCount(outputTokens, "output tokens");
  return formatScaled(pico, PICO);
}

function priceModel(model: ListedModel): PricedModel {
  const inputMicro = priceMicro(model.inputUsdPer1m, `${model.id} input_usd_per_1m`);
  const outputMicro = priceMicro(model.outputUsdPer1m, `${model.id} output_usd_per_1m`);
  return {
    ...model,
    inputMicro,
    outputMicro,
    callPico: inputMicro * BigInt(TYPICAL_INPUT_TOKENS) + outputMicro * BigInt(TYPICAL_OUTPUT_TOKENS),
  };
}

export function formatModelCostTable(models: ListedModel[], budgetInput: BudgetInput): string {
  const rows = models.map(priceModel).sort((a, b) => {
    if (a.callPico < b.callPico) return -1;
    if (a.callPico > b.callPico) return 1;
    return a.id.localeCompare(b.id);
  });
  const budget = resolveBudget(budgetInput);
  const gbp = formatScaled(budget.gbpMicro, MICRO);
  const usd = formatScaled(budget.budgetPico, PICO);
  const header = [
    `| Model | $ / 1M input | $ / 1M output | $ / call | Calls / £${gbp} ($${usd}) | Output tokens / £${gbp} ($${usd}) |`,
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  const budgetPico = budget.budgetPico;
  const lines = rows.map((row) => {
    const call = formatScaled(row.callPico, PICO);
    const calls = row.callPico === 0n ? "unlimited" : formatCount(roundDiv(budgetPico, row.callPico));
    const outputTokens =
      row.callPico === 0n
        ? "unlimited"
        : formatCount(roundDiv(budgetPico * BigInt(TYPICAL_OUTPUT_TOKENS), row.callPico));
    return `| \`${row.id}\` | ${formatScaled(row.inputMicro, MICRO)} | ${formatScaled(row.outputMicro, MICRO)} | ${call} | ${calls} | ${outputTokens} |`;
  });
  return [...header, ...lines, ""].join("\n");
}
