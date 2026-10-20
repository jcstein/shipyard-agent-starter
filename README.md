# SHIPYARD agent starter

Hands-on companion for Josh Stein's session at SHIPYARD "MAKE ME MONEY" (London, Nov 2026): **"Earn, pay, verify: build an agent that sells, pays for its compute, and posts its receipts to Celestia."**

A team gives an agent up to £100. The agent has to earn **real GBP from outside customers**. This repo is the small loop around that:

1. Customers pay **GBP** through Stripe. That is the revenue.
2. The agent pays **its own inference** in **TIA on Eden** (chain id 714), into the NativeEscrow contract, using Houston Inference.
3. Every sale, inference, and human intervention is appended to a local hash-chained log and can be posted as a blob to **Celestia Mocha**. Mocha is a testnet. Those blobs are logs, not revenue, and Mocha TIA cannot pay for Eden inference.

```
customer -- GBP (Stripe) --> you
agent -- TIA on Eden --> NativeEscrow --> Houston Inference
receipts -- blob --> Celestia Mocha (testnet log)
```

`npm run demo` is a dry-run. It does not spend TIA, does not create a Stripe charge, and does not post to Mocha.

## Quick start

```bash
npm i
npm run demo
npm run verify
```

You need Node 22+. Copy `.env.example` to `.env` when you are ready to spend or charge. The dry-run works with no keys.

## What the dry-run shows

- A live `HTTP 402` from `https://inference.bot.fun/v1/chat/completions`, parsed as an `escrow-upto` quote.
- A check that the quote's `serverSignature` is an EIP-191 signature over the raw `paymentId` bytes and recovers to the quoted facilitator.
- The spend cap, applied in this process, refusing the quote if it does not fit.
- Three receipt lines (`inference`, `sale`, `human`) in `receipts.jsonl`, each carrying the hash of the previous line.
- A **mock** Mocha post in `posts.json`. `npm run verify` checks the hash chain and the mock payload locally, and says Mocha was not queried.

The dry-run `sale` line uses `checkoutId: "dry_run_not_a_stripe_payment"` and `amount: "0.00"`. It is an example of the shape, not a payment.

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo` | Dry-run by default. `DEMO_MODE=live` pays for one completion. |
| `npm run verify` | Checks the hash chain. Fetches a real Mocha blob when one was posted. |
| `npm run post` | Submits unposted receipt lines to your celestia-node. |
| `npm run checkout` | Creates a Stripe Checkout Session in the mode of your secret key. |
| `npm run webhook` | `POST /webhook` on `127.0.0.1:8787`. A completed checkout writes a `sale` receipt. |
| `npm run human -- --who "Ada" --what "paused spending" --why "quote was too high"` | Appends a `human` receipt. |
| `npm test` | Offline tests. |
| `npm run typecheck` / `npm run lint` | `tsc` and eslint. |

## Money flow

**GBP in.** `npm run checkout` opens a Stripe Checkout Session priced in GBP. Point Stripe at the webhook (`stripe listen --forward-to localhost:8787/webhook`, or the dashboard). `checkout.session.completed` appends a `sale` with the checkout id, payment intent id, amount, `GBP`, and your customer ref (`client_reference_id`). `livemode: false` means a test-mode event. Test cards are not revenue. A live-mode charge from an outside customer is.

**TIA out.** Inference is Houston's OpenAI-compatible chat API. An unpaid `POST /v1/chat/completions` returns `402` with a base64 `payment-required` header (x402 v2, scheme `escrow-upto`, network `eip155:714`, asset `native`). The client then:

1. Refuses the quote unless the escrow address, chain, and facilitator signature match what this process expects, and the wei amount fits the spend cap.
2. `POST /v1/deposit/build` with `{ "from", "accepted" }` where `accepted` is the quote entry. The helper returns an unsigned Eden transaction. This client signs it only when `to` is the pinned escrow, `value` equals the quote, and the calldata is `deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd)` for those same fields.
3. Signs that transaction locally and `POST /v1/deposit/send` with `{ "signedTx", "paymentId" }`.
4. Polls `GET /v1/deposit/status/:txHash` until `confirmed`.
5. Signs an EIP-191 `Payment-Signature` and retries the chat request.

The header is base64 JSON:

```json
{
  "x402Version": 2,
  "resource": {},
  "accepted": {},
  "payload": { "signature": "0x…", "paymentId": "0x…", "nonce": "0x…" }
}
```

`signature` is `personal_sign` of the raw nonce bytes (the same EIP-191 shape the facilitator uses for `paymentId`). Set `HOUSTON_SIGN_FIELD=paymentId` to sign the payment id instead. The paid retry has not been confirmed against the live API. See the status section below.

NativeEscrow is `0x65d77c98E73DFbEA91eCb72B27c9753e186a94c8` on Eden. The client will not sign a deposit aimed at any other contract. Explorer: [eden.blockscout.com](https://eden.blockscout.com/address/0x65d77c98E73DFbEA91eCb72B27c9753e186a94c8).

The quote amount is a **ceiling**. `upto` means the facilitator can settle less and refund the rest. `tiaQuoted` on a receipt is that ceiling. `tiaCharged` is the settled wei when the `payment-response` header includes it, and `null` when it does not. Do not treat the ceiling as the cost, and do not treat either number as revenue.

**Logs out.** `npm run post` batches receipt lines that are not in `posts.json` yet and submits one blob to a celestia-node light node (`blob.Submit`, then `blob.GetAll` to record the commitment). `npm run verify` calls `blob.Get` and checks the bytes match the local lines.

## Spend cap

`SPEND_CAP_TIA` (default `0.05`) is enforced here, before a transaction is signed. It is not a hint to the model. The cap is the sum of live quotes already deposited plus this quote (and, on the live path, the deposit's max gas). Dry-run lines are not counted. An optional `SPEND_CAP_USD` compares the quote against the TIA/USD price inside the 402. The £100 hackathon budget is not a balance this process holds.

The private key is read from `EDEN_PRIVATE_KEY` and used only to sign. It is never written to a receipt, a blob, or the chat prompt. Receipts store `sha256` of the payment header, not the signature.

## Receipts

`receipts.jsonl` is one JSON object per line. Each line has `ts` and `prev`, the sha256 of the previous line (`prev` is 64 zeroes on the first line).

- `sale`: `checkoutId`, `paymentId`, `amount`, `currency` (`GBP`), `customerRef`, `livemode`
- `inference`: `requestId` (the quote `paymentId`), `model`, `tokensIn`, `tokensOut`, `tiaCharged`, `tiaQuoted`, `escrow`, `depositTxHash`, `paymentHeaderSha256`, `quoteHeaderSha256`, `dryRun`
- `human`: `who`, `what`, `why`

## Environment

See `.env.example`. The ones that matter:

| Variable | Role |
| --- | --- |
| `DEMO_MODE` | `dry-run` (default) or `live` |
| `EDEN_PRIVATE_KEY` | Eden EVM key. Required for live mode. |
| `SPEND_CAP_TIA` | Cap in TIA. Default `0.05`. |
| `HOUSTON_BASE_URL` | Default `https://inference.bot.fun/v1` |
| `HOUSTON_MODEL` | Default `qwen/qwen-flash` |
| `HOUSTON_SIGN_FIELD` | `nonce` (default) or `paymentId` |
| `ESCROW_ADDRESS` | Pinned NativeEscrow |
| `CELESTIA_RPC_URL` | celestia-node RPC, usually `http://127.0.0.1:26658` |
| `CELESTIA_AUTH_TOKEN` | Bearer token from the node |
| `CELESTIA_NAMESPACE` | Default `shipyardmm` (10-byte v0 namespace id) |
| `STRIPE_SECRET_KEY` | Stripe secret. Use `sk_test_…` until you intend to charge. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
| `STRIPE_AMOUNT_GBP` | Checkout price, default `5.00` |

## Get TIA on Eden

Eden gas and the escrow deposit are real TIA on chain 714. Follow the bot.fun docs rather than a guessed bridge recipe:

- [What is Eden?](https://bot.fun/docs/eden) (chain id, RPC `https://rpc.eden.gateway.fm/`, explorer)
- [Fund Houston with TIA](https://bot.fun/docs/fund-houston)
- [bot.fun/deposit](https://bot.fun/deposit) to generate a Celestia deposit address for an Eden `0x` recipient, or the Bridge tab on that page

Put that Eden address's key in `EDEN_PRIVATE_KEY`. This starter does not custody it.

Mocha faucet TIA is only for posting blobs from a light node. It does not pay Houston Inference. The faucet is documented on the [Mocha testnet](https://docs.celestia.org/operate/networks/mocha-testnet/) page: [https://mocha.celenium.io/faucet](https://mocha.celenium.io/faucet), and the `#mocha-faucet` Discord command. Using it does not entitle anyone to a mainnet airdrop.

## Post the log to Mocha

Mocha-5 is a testnet. A blob there proves the bytes were published, nothing more.

Run a light node using the [light-node quickstart](https://docs.celestia.org/operate/data-availability/light-node/quickstart/):

```bash
celestia light init --p2p.network mocha
celestia light start \
  --core.ip public-endpoint.celestia-mocha.quiknode.pro \
  --core.port 9090 --core.tls --p2p.network mocha
```

Fund the node's Celestia address from the Mocha faucet, then create a token as documented in the [advanced light-node page](https://docs.celestia.org/operate/data-availability/light-node/advanced/):

```bash
celestia light auth admin --p2p.network mocha
```

Set `CELESTIA_RPC_URL=http://127.0.0.1:26658` and `CELESTIA_AUTH_TOKEN` to that token. `npm run post` sends `blob.Submit` with an empty tx config so the node estimates gas. The namespace is the 29-byte v0 form of `shipyardmm` (version byte `0`, id in the last 10 bytes).

Hosted option: a [Quicknode Celestia](https://www.quicknode.com/chains/celestia) node API speaks the same JSON-RPC. Point `CELESTIA_RPC_URL` and `CELESTIA_AUTH_TOKEN` at the endpoint they give you. The public read URL `https://public-endpoint.celestia-mocha.quiknode.pro` answers header and blob reads for development. Do not use it as your submit wallet. It has no SLA.

`npm run verify` refetches by height, namespace, and commitment. A mock record never contacts the network.

## What you can verify

- The 402 quote: scheme, wei amount, escrow, facilitator, and that `serverSignature` recovers to the facilitator.
- The spend cap rejects a quote that does not fit, with no transaction signed.
- The receipt hash chain, offline.
- For a real `npm run post`: the Mocha blob bytes equal the local lines. That equality is a testnet availability proof of the log. It is not a proof of GBP revenue.
- A Stripe `sale` receipt's `livemode` flag. Only `livemode: true` can be revenue, and only if the payer is an outside customer.

## What was exercised, and what was not

Exercised against live services while building this starter:

- `GET /v1/models` and an unpaid `POST /v1/chat/completions` (model `qwen/qwen-flash`), which returns 402 and a `payment-required` header.
- The facilitator EIP-191 check, against a captured quote (also covered by `npm test`).
- `POST /v1/deposit/build` with `{ from, accepted }`. A public Eden address that already held TIA was used only to read the unsigned transaction JSON. That transaction was not signed or broadcast.
- `POST /v1/deposit/send` rejects a body without `paymentId`, and a bogus signed transaction returns `failed to broadcast transaction`. The success body was not observed.
- `GET /v1/deposit/status/:txHash` returns `pending` for an unknown hash and `confirmed` for a hash that is already on Eden.
- Public Mocha RPC `header.NetworkHead` reports `chain_id` `mocha-5`. `blob.Get`, `blob.GetAll`, and `blob.Submit` accept the parameter shapes this client sends. No blob was submitted.

Not exercised, because there is no funded key in this environment:

- Signing and broadcasting a NativeEscrow deposit.
- The `deposit/send` success payload.
- A `Payment-Signature` accepted by Houston after a deposit. The client signs the nonce bytes. If a funded retry is rejected as a bad signature, set `HOUSTON_SIGN_FIELD=paymentId` and request a new quote. Do not reuse a payment id.
- Token counts and the settled TIA amount on a real completion (`payment-response`).
- A Stripe API call. Webhook signature checks are unit-tested with a local secret.
- A Mocha round trip of this app's blob. `npm run post` is untested against a funded light node.

## Layout

```
src/demo.ts        dry-run or live entry
src/houston.ts     402 quote, deposit helpers, Payment-Signature
src/receipts.ts    hash-chained JSONL
src/celestia.ts    Mocha blob submit and get
src/stripe.ts      Checkout and the webhook
src/run.ts         wires the demo together
```

Keep the diff small. The model does not get the key, and the cap does not live inside the prompt.
