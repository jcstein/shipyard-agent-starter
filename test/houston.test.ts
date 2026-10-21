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
  explainsInvalidSignature,
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

  it("parses the 21 Oct 2026 live payment-required header and recovers the facilitator", () => {
    const header = readFileSync(join(fixtureDir, "live-402-20261021T160130Z.payment-required.b64"), "utf8").trim();
    const decoded = JSON.parse(readFileSync(join(fixtureDir, "live-402-20261021T160130Z.json"), "utf8")) as {
      accepts: Array<{ amount: string; extra: { facilitator: string; paymentId: string; nonce: string; serverSignature: string } }>;
    };
    const headers = readFileSync(join(fixtureDir, "live-402-20261021T160130Z.headers.txt"), "utf8");
    assert.equal(headers.includes(header), true);
    const parsed = parsePaymentRequired(header, { error: "Payment Required" }, NATIVE_ESCROW);
    const extra = decoded.accepts[0]?.extra;
    assert.ok(extra);
    assert.equal(parsed.accepted.scheme, "escrow-upto");
    assert.equal(parsed.accepted.network, "eip155:714");
    assert.equal(parsed.accepted.amount, "4085087032311");
    assert.equal(parsed.accepted.amount, decoded.accepts[0]?.amount);
    assert.equal(parsed.accepted.extra.paymentId, extra.paymentId);
    assert.equal(parsed.accepted.extra.serverSignature, extra.serverSignature);
    assert.equal(assertFacilitatorSigned(parsed).toLowerCase(), extra.facilitator.toLowerCase());
    const nonceSigner = recoverPersonalSigner(getBytes(parsed.accepted.extra.nonce), parsed.accepted.extra.serverSignature);
    assert.notEqual(nonceSigner.toLowerCase(), extra.facilitator.toLowerCase());
  });

  it("treats an invalid signature as a rejection and a missing header as not one", () => {
    assert.equal(explainsInvalidSignature({ error: { message: "invalid signature" } }), true);
    assert.equal(explainsInvalidSignature("signature verification failed"), true);
    assert.equal(explainsInvalidSignature("Payment-Signature header is required"), false);
    assert.equal(explainsInvalidSignature({ message: "deposit not indexed" }), false);
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
