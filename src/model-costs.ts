/** USD rates from Houston `GET /v1/models`, turned into a cost table. */

export const TYPICAL_INPUT_TOKENS = 2_000;
export const TYPICAL_OUTPUT_TOKENS = 500;
export const BUDGET_USD = 10;

const MICRO = 1_000_000n;
const PICO = 1_000_000_000_000n;

export type ListedModel = {
  id: string;
  inputUsdPer1m: number;
  outputUsdPer1m: number;
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

export function formatModelCostTable(models: ListedModel[]): string {
  const rows = models.map(priceModel).sort((a, b) => {
    if (a.callPico < b.callPico) return -1;
    if (a.callPico > b.callPico) return 1;
    return a.id.localeCompare(b.id);
  });
  const budgetPico = BigInt(BUDGET_USD) * PICO;
  const header = [
    "| Model | $ / 1M input | $ / 1M output | $ / call | Calls / $10 | Output tokens / $10 |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
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
