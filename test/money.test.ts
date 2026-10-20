import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertWithinCap, formatTia, gbpFromPence, parseTia, penceFromGbp } from "../src/money.ts";

describe("money", () => {
  it("parses TIA to wei and prints it back", () => {
    assert.equal(parseTia("0.05"), 50_000_000_000_000_000n);
    assert.equal(formatTia(7208392580248n), "0.000007208392580248");
  });

  it("converts GBP", () => {
    assert.equal(penceFromGbp("5.00"), 500);
    assert.equal(gbpFromPence(500), "5.00");
  });

  it("refuses a quote above the cap", () => {
    assert.throws(
      () => assertWithinCap({ capWei: 10n, committedWei: 0n, nextWei: 11n, label: "quote" }),
      /spend cap/,
    );
  });
});
