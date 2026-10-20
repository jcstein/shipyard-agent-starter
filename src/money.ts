const WEI = 10n ** 18n;

export function parseTia(amount: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`TIA amount must be a decimal string, got ${amount}`);
  }
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > 18) {
    throw new Error(`TIA amount has more than 18 decimal places: ${amount}`);
  }
  return BigInt(whole) * WEI + BigInt(frac.padEnd(18, "0"));
}

export function formatTia(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / WEI;
  const frac = (abs % WEI).toString().padStart(18, "0").replace(/0+$/, "");
  const text = frac.length === 0 ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${text}` : text;
}

/** tiaPriceUsd is the quote's 18-decimal USD-per-TIA price. */
export function quoteUsd(amountWei: bigint, tiaPriceUsd: bigint): bigint {
  return (amountWei * tiaPriceUsd) / WEI;
}

export function formatUsd(usdWei: bigint): string {
  const whole = usdWei / WEI;
  const frac = (usdWei % WEI).toString().padStart(18, "0").slice(0, 8).replace(/0+$/, "");
  return frac.length === 0 ? whole.toString() : `${whole}.${frac}`;
}

export function parseUsd(amount: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    throw new Error(`USD amount must be a decimal string, got ${amount}`);
  }
  const [whole, frac = ""] = amount.split(".");
  if (frac.length > 18) {
    throw new Error(`USD amount has more than 18 decimal places: ${amount}`);
  }
  return BigInt(whole) * WEI + BigInt(frac.padEnd(18, "0"));
}

export function penceFromGbp(amount: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(amount)) {
    throw new Error(`GBP amount must be pounds with at most 2 decimals, got ${amount}`);
  }
  const [whole, frac = ""] = amount.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function gbpFromPence(pence: number): string {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  return `${sign}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}

export function assertWithinCap(input: {
  capWei: bigint;
  committedWei: bigint;
  nextWei: bigint;
  label: string;
}): void {
  const total = input.committedWei + input.nextWei;
  if (total > input.capWei) {
    throw new Error(
      `${input.label} of ${formatTia(input.nextWei)} TIA plus ${formatTia(input.committedWei)} TIA already committed exceeds the spend cap of ${formatTia(input.capWei)} TIA`,
    );
  }
}
