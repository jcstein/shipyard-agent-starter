import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Wallet, getBytes } from "ethers";
import {
  assertDepositTx,
  assertFacilitatorSigned,
  encodePaymentSignature,
  parsePaymentRequired,
  recoverPersonalSigner,
  type ParsedQuote,
  type TxData,
} from "../src/houston.ts";
import { NATIVE_ESCROW } from "../src/eden.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixturePath = join(fixtureDir, "payment-required.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  accepts: Array<{ extra: { facilitator: string; paymentId: string; nonce: string; serverSignature: string } }>;
};
const header = Buffer.from(JSON.stringify(fixture)).toString("base64");

function quote(): ParsedQuote {
  return parsePaymentRequired(header, { price: { amount: "0.000007", currency: "TIA" } }, NATIVE_ESCROW);
}

describe("houston quote", () => {
  it("parses a real 402 header and checks the facilitator signature", () => {
    const parsed = quote();
    assert.equal(parsed.accepted.scheme, "escrow-upto");
    assert.equal(parsed.accepted.amount, "7208392580248");
    assert.equal(assertFacilitatorSigned(parsed).toLowerCase(), fixture.accepts[0]?.extra.facilitator.toLowerCase());
  });

  it("rejects a quote whose serverSignature does not recover to the facilitator", () => {
    const parsed = quote();
    parsed.accepted.extra.serverSignature = `0x${"ab".repeat(65)}`;
    assert.throws(() => assertFacilitatorSigned(parsed), /signature/);
  });

  it("signs the nonce with EIP-191 and puts only the header, not the key, on the wire", async () => {
    const parsed = quote();
    const wallet = Wallet.createRandom();
    const signature = await wallet.signMessage(getBytes(parsed.accepted.extra.nonce));
    assert.equal(
      recoverPersonalSigner(getBytes(parsed.accepted.extra.nonce), signature).toLowerCase(),
      wallet.address.toLowerCase(),
    );
    const encoded = encodePaymentSignature(parsed, signature);
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      payload: { signature: string; paymentId: string; nonce: string };
    };
    assert.equal(decoded.payload.signature, signature);
    assert.equal(decoded.payload.paymentId, fixture.accepts[0]?.extra.paymentId);
    assert.equal(JSON.stringify(decoded).includes(wallet.privateKey), false);
  });

  it("accepts the observed deposit/build calldata only when it matches the quote", () => {
    const parsed = quote();
    const built = JSON.parse(readFileSync(join(fixtureDir, "deposit-build.json"), "utf8")) as { txData: TxData };
    assertDepositTx(built.txData, parsed, NATIVE_ESCROW);
    assert.throws(
      () => assertDepositTx({ ...built.txData, value: "1" }, parsed, NATIVE_ESCROW),
      /value/,
    );
  });
});
