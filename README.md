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
| `npm run preflight` | Reads the Eden address, TIA balance, and a fresh 402. Prints go or no-go. Does not sign or broadcast. |
| `npm run demo` | Dry-run by default. `DEMO_MODE=live` pays for one completion. |
| `npm run celestia:build` | Builds the Mocha helper with Go 1.25.1. |
| `npm run celestia:address` | Prints the celestia address to fund from the Mocha faucet. |
| `npm run celestia:head` | Reads the public Mocha DA chain head. |
| `npm run verify` | Checks the hash chain. Reads a real Mocha blob back when one was posted. |
| `npm run post` | Submits unposted receipt lines with the Mocha helper. |
| `npm run checkout` | Creates a Stripe Checkout Session in the mode of your secret key. |
| `npm run webhook` | `POST /webhook` on `127.0.0.1:8787`. A completed checkout writes a `sale` receipt. |
| `npm run human -- --who "Ada" --what "paused spending" --why "quote was too high"` | Appends a `human` receipt. |
| `npm run models` | Fetches Houston's live model list and prints the cost of a typical call. |
| `npm test` | Offline tests. |
| `npm run typecheck` / `npm run lint` | `tsc` and eslint. |

## Money flow

**GBP in.** `npm run checkout` opens a Stripe Checkout Session priced in GBP. Point Stripe at the webhook (`stripe listen --forward-to localhost:8787/webhook`, or the dashboard). `checkout.session.completed` appends a `sale` with the checkout id, payment intent id, amount, `GBP`, and your customer ref (`client_reference_id`). `livemode: false` means a test-mode event. Test cards are not revenue. A live-mode charge from an outside customer is.

**TIA out.** Inference is Houston's OpenAI-compatible chat API. An unpaid `POST /v1/chat/completions` returns `402` with a base64 `payment-required` header (x402 v2, scheme `escrow-upto`, network `eip155:714`, asset `native`). The client then:

1. Refuses the quote unless the escrow address, chain, and facilitator signature match what this process expects, and the wei amount fits the spend cap.
2. `POST /v1/deposit/build` with `{ "from", "accepted" }` where `accepted` is the quote entry. The helper returns an unsigned Eden transaction. This client signs it only when `to` is the pinned escrow, `value` equals the quote, and the calldata is `deposit(bytes32 paymentId, address payTo, address facilitator, uint256 expiresAt, uint256 refundAfter, uint256 tiaPriceUsd)` for those same fields.
3. Signs that transaction locally and `POST /v1/deposit/send` with `{ "signedTx", "paymentId" }`.
4. Polls `GET /v1/deposit/status/:txHash` until `confirmed`.
5. Signs an EIP-191 `Payment-Signature` over the raw paymentId bytes and retries the chat request. `HOUSTON_SIGN_FIELD=nonce` still signs the nonce first, which the funded run rejected. With `HOUSTON_RETRY_OTHER_SIGN_FIELD=1`, a signature mismatch — including the 403 `signer is neither the escrow buyer nor an authorized device key` — retries the chat completion once with the other field. That retry does not send a second deposit.

The header is base64 JSON:

```json
{
  "x402Version": 2,
  "resource": {},
  "accepted": {},
  "payload": { "signature": "0x…", "paymentId": "0x…", "nonce": "0x…" }
}
```

`signature` is `personal_sign` of the raw paymentId bytes (`signMessage(getBytes(paymentId))`). The payload still carries `signature`, `paymentId`, and `nonce`. The facilitator's `serverSignature` is EIP-191 over those same paymentId bytes. A signature over the nonce recovers to the buyer and is rejected. See [First funded run](#first-funded-run).

NativeEscrow is `0x65d77c98E73DFbEA91eCb72B27c9753e186a94c8` on Eden. The client will not sign a deposit aimed at any other contract. Explorer: [eden.blockscout.com](https://eden.blockscout.com/address/0x65d77c98E73DFbEA91eCb72B27c9753e186a94c8).

The quote amount is a **ceiling**. `upto` means the facilitator can settle less and refund the rest. `tiaQuoted` on a receipt is that ceiling. `tiaCharged` is `houston.cost_tia` from the completion body when that field is a wei integer, and otherwise the `amount` on `payment-response` when that header has one. It is `null` when neither is present. Do not treat the ceiling as the cost, and do not treat either number as revenue.

**Logs out.** `npm run post` batches receipt lines that are not in `posts.json` yet and submits one blob through the Go helper: the public Mocha core gRPC endpoint takes the PayForBlobs transaction, and the public DA endpoint reads the blob back before `posts.json` is written. `npm run verify` reads that blob again and checks the bytes match the local lines. Set `CELESTIA_RPC_URL` to send those calls to your own light node instead.

## Spend cap

`SPEND_CAP_TIA` (default `0.05`) is enforced here, before a transaction is signed. It is not a hint to the model. The cap is the sum of live quotes already deposited plus this quote (and, on the live path, the deposit's max gas). Dry-run lines are not counted. An optional `SPEND_CAP_USD` compares the quote against the TIA/USD price inside the 402. The £100 hackathon budget is not a balance this process holds.

The private key is read from `EDEN_PRIVATE_KEY` and used only to derive the address and to sign. It is never written to a receipt, a blob, the chat prompt, or a live trace. Receipts store `sha256` of the payment header, not the signature. A live trace does store the signed deposit transaction and the `Payment-Signature` header.

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
| `HOUSTON_SIGN_FIELD` | `paymentId` (default). `nonce` signs the nonce first; the funded run rejected that signature. |
| `HOUSTON_RETRY_OTHER_SIGN_FIELD` | `1` retries a signature mismatch once, on the other field, for the same paymentId. Unset does not. |
| `EDEN_RPC_URL` | Balance RPC for preflight. Default `https://rpc.eden.gateway.fm/` |
| `TRACE_DIR` | Live HTTP traces. Default `traces/`. Gitignored. |
| `ESCROW_ADDRESS` | Pinned NativeEscrow |
| `CELESTIA_HELPER` | Mocha helper binary. Default `celestia/mocha-helper`. |
| `CELESTIA_KEYRING` | Local test keyring directory. Default `celestia-keys`. Gitignored. |
| `CELESTIA_KEY_NAME` | Key name inside that keyring. Default `shipyard`. |
| `CELESTIA_DA_URL` | DA JSON-RPC used to read blobs. Default `https://public-endpoint.celestia-mocha.quiknode.pro`. |
| `CELESTIA_CORE_GRPC` | Core gRPC used to submit blobs. Default `public-endpoint.celestia-mocha.quiknode.pro:9090`. |
| `CELESTIA_RPC_URL` | Optional. When set, post and verify use this light-node JSON-RPC instead of the helper. |
| `CELESTIA_AUTH_TOKEN` | Bearer token for that light node. |
| `CELESTIA_NAMESPACE` | Default `shipyardmm` (10-byte v0 namespace id) |
| `STRIPE_SECRET_KEY` | Stripe secret. Use `sk_test_…` until you intend to charge. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret |
| `STRIPE_AMOUNT_GBP` | Checkout price, default `5.00` |

## Get TIA on Eden

Eden gas and the escrow deposit are real TIA on chain 714. Follow the bot.fun docs rather than a guessed bridge recipe:

- [What is Eden?](https://bot.fun/docs/eden) (chain id, RPC `https://rpc.eden.gateway.fm/`, explorer)
- [Fund Houston with TIA](https://bot.fun/docs/fund-houston)
- [bot.fun/deposit](https://bot.fun/deposit) to generate a Celestia deposit address for an Eden `0x` recipient, or the Bridge tab on that page

Put that Eden address's key in `EDEN_PRIVATE_KEY`. This starter does not custody it. `npm run preflight` prints the address it will use.

## Model costs

About $10 of Eden TIA is the inference budget (about 18-20 TIA at ~$0.56/TIA on 22 Oct 2026). What that buys on Houston's list is in [Model costs](docs/model-costs.md). `npm run models` prints the same table from the live list. Leave `SPEND_CAP_TIA` set.

## First funded run

Dry-run stays the default. A funded mainnet run has already answered the two open questions. Sign the paymentId. `deposit/send` returns `{ "txHash", "paymentId" }`.

That run, reported from mainnet and not re-executed in this repository:

- `POST /v1/deposit/build` returned 200. The client signed and `POST /v1/deposit/send` with `{ "signedTx", "paymentId" }` returned 200 and `{ "txHash", "paymentId" }`. The response carried a `deprecation: true` header. This client still posts that body and logs a note when the header is present.
- `GET /v1/deposit/status/<txHash>` returned `{ "txHash", "status": "confirmed" }` immediately.
- A paid retry whose `payload.signature` was EIP-191 `personal_sign` over the nonce bytes returned 403 `{"error":{"message":"signer is neither the escrow buyer nor an authorized device key","type":"inference_error"}}`. That signature recovers to the buyer over the nonce. Houston checks the paymentId.
- Re-signing with `signMessage(getBytes(paymentId))`, same payload shape (`signature`, `paymentId`, `nonce`), same paymentId, and no second deposit returned 200. `payment-response` decoded to `{ "success": true, "network": "eip155:714", "payer": "<buyer>" }`. The body `houston` block had `cost_tia` `9147039588615` against a deposit of `15603773415873`. `cost_usd` was present; its number is not recorded here.

The client now signs paymentId by default. Nonce is the fallback, and only when `HOUSTON_RETRY_OTHER_SIGN_FIELD=1`. That flag treats the buyer/device-key 403 as a signature mismatch and retries the chat completion once on the same paymentId. It does not deposit again. A 500, a missing `Payment-Signature`, and an unrelated 403 are not retried. `payment-response` is decoded and printed (`success`, `network`, `payer`). `houston.cost_tia` and `houston.cost_usd` are printed from the body. `tiaCharged` prefers `cost_tia`. The deposit remains the ceiling: on this run `9147039588615` settled against `15603773415873` deposited.

1. Fund the Eden address, not a Mocha faucet address. `npm run preflight` prints the address derived from `EDEN_PRIVATE_KEY`. Send a small amount of real TIA on Eden (chain 714) to it. Use [bot.fun/deposit](https://bot.fun/deposit) (Deposit Address for that `0x` recipient) or the Bridge tab. See [What is Eden?](https://bot.fun/docs/eden) and [Fund Houston with TIA](https://bot.fun/docs/fund-houston).

2. Preflight. It reads the balance from `https://rpc.eden.gateway.fm/` and a fresh 402. When the quote checks out it POSTs `deposit/build` and takes max gas as `gasLimit * maxFeePerGas`, the same figure a live run caps against. It does not sign, and it does not call `deposit/send`. If the address cannot cover the deposit and gas, `deposit/build` returns 402 `insufficient balance for escrow deposit and gas` and preflight is `NO-GO`. The preflight quote is thrown away. The live run asks for its own. On the 21 Oct 2026 capture, `expiresAt` was five minutes after the 402 and `refundAfter` was seven days after it, so start the live command while you are at the keyboard. `GO` exits 0. `NO-GO` exits 1.

```bash
npm run preflight
```

3. Live run, with the cap left low. Leave `HOUSTON_SIGN_FIELD` unset or set it to `paymentId`. `HOUSTON_RETRY_OTHER_SIGN_FIELD=1` is optional: if Houston rejects the paymentId signature, the process signs the nonce once for the paymentId that was just deposited. It does not deposit again. Do not set `HOUSTON_SIGN_FIELD=nonce` for a normal run.

```bash
DEMO_MODE=live npm run demo
```

4. The trace is `traces/<timestamp>.json` (gitignored). It has the 402 response headers, including the raw `payment-required` base64, the `deposit/build` body, the `deposit/send` request and response bodies (including `deprecation` when Houston sends it), the deposit status body, and the paid retry request headers plus the response status, body, and headers, including `payment-response`. The private key is not in the file. The signed transaction and `Payment-Signature` are. Do not commit it.

5. Read the log. A completion prints the decoded `payment-response` and `houston cost_tia` / `cost_usd`. The receipt stores `tiaCharged` from `cost_tia` when Houston returns it.

If the paid retry is rejected and the flag was unset, stop. The error names the deposit transaction, the paymentId, and `refundAfter`. Do not start another live run to reuse that paymentId. A new run requests a new quote and would deposit again. NativeEscrow reverts a second `deposit` for a paymentId that was already used. The TIA stays in escrow until the facilitator settles it, or until `refundAfter`, when the buyer can call `refundExpired(paymentId)` on the escrow. Anyone can submit that call. The refund goes to the buyer. The quote amount is a ceiling, not a settled charge.

Mocha faucet TIA funds the helper's celestia address so `npm run post` can publish a testnet log. It does not pay Houston Inference. The faucet is [https://mocha.celenium.io/faucet](https://mocha.celenium.io/faucet). Using it does not entitle anyone to a mainnet airdrop.

## Post the log to Mocha

Mocha-5 is a testnet. A blob there proves the bytes were published, nothing more. It does not pay for Eden inference.

`npm run post` and `npm run verify` shell out to `celestia/mocha-helper`. The helper uses the official celestia-node Go client (`github.com/celestiaorg/celestia-node/api/client`, tag `v0.28.2-mocha`). It submits the existing receipt bytes — the same JSON `blobPayload` already builds, under the `shipyardmm` namespace — to the public Mocha core gRPC endpoint `public-endpoint.celestia-mocha.quiknode.pro:9090` with TLS. It reads them back from the public DA JSON-RPC `https://public-endpoint.celestia-mocha.quiknode.pro`. You do not run a light node for this path.

The helper builds with Go 1.25.x. Go 1.26 is not supported by a transitive dependency (`bytedance/sonic`). `npm run celestia:build` sets `GOTOOLCHAIN=go1.25.1`, so the `go` on your PATH can be older or newer.

```bash
npm run celestia:build
npm run celestia:address
```

The address command prints a `celestia1…` address. The first time, it also writes a mnemonic to `celestia-keys/shipyard.mnemonic` (mode 0600). The keyring is the Cosmos **test** backend: unencrypted, local, and gitignored. Treat that directory like a private key. Fund the address from the Mocha faucet: [https://mocha.celenium.io/faucet](https://mocha.celenium.io/faucet).

`npm run celestia:head` reads the public DA chain head and prints the chain id and height. It does not need a funded account.

Append a receipt (`npm run human`, a sale, or an inference), then:

```bash
npm run post
npm run verify
```

`post` writes `posts.json` only after the helper has submitted the blob and read the same bytes back. `verify` fetches by height, namespace, and commitment and checks those bytes against the local lines. A mock post never contacts the network and never starts the helper. An account with no Mocha TIA makes `post` exit 1 with `insufficient funds` and leaves `posts.json` unchanged.

Mocha faucet TIA pays only this helper's blob transactions. It is not Eden TIA.

### Optional light node

Set `CELESTIA_RPC_URL` (and `CELESTIA_AUTH_TOKEN` when the node wants a bearer token) to use a celestia-node JSON-RPC endpoint instead of the helper. `npm run post` then calls `blob.Submit` and `blob.GetAll` on that URL, and `npm run verify` calls `blob.Get`. Leave `CELESTIA_RPC_URL` unset to use the helper. Do not put the public DA URL in `CELESTIA_RPC_URL`; that endpoint is for reads, and the helper already uses it.

The [light-node quickstart](https://docs.celestia.org/operate/data-availability/light-node/quickstart/) is still the path for running your own node. The namespace is the 29-byte v0 form of `shipyardmm` (version byte `0`, id in the last 10 bytes). A hosted [Quicknode Celestia](https://www.quicknode.com/chains/celestia) node API speaks the same JSON-RPC if you point `CELESTIA_RPC_URL` at it. The public endpoints have no SLA.

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
- `POST /v1/deposit/send` rejects a body without `paymentId`, and a bogus signed transaction returns `failed to broadcast transaction`.
- `GET /v1/deposit/status/:txHash` returns `pending` for an unknown hash and `confirmed` for a hash that is already on Eden.
- `eth_chainId` on `https://rpc.eden.gateway.fm/` returns `0x2ca` (714). Preflight uses that RPC for the balance and refuses any other chain id.
- Public Mocha RPC `header.NetworkHead` reports `chain_id` `mocha-5`. The light-node JSON-RPC client sends `blob.Get`, `blob.GetAll`, and `blob.Submit` in the shapes celestia-node accepts. No blob was submitted on that path.
- The Go helper, built with Go 1.25.1, against the public Mocha endpoints on 21 Oct 2026. `header.NetworkHead` on `https://public-endpoint.celestia-mocha.quiknode.pro` returned `mocha-5` (height 1893957 directly, and 1893965 through `npm run celestia:head`). `blob.Get` for 32 zero bytes at height 1893957 returned `blob: not found`, so the read reached the node. A throwaway key `celestia1zkf0tnwpqe08wc83ny0260wm6hs5c9tzd4cuwy` was created in a local test keyring. `npm run post` with that key connected to core gRPC `public-endpoint.celestia-mocha.quiknode.pro:9090` over TLS, read a zero balance (`0utia`; the account does not exist yet), and exited 1 with `insufficient funds: celestia1zkf0tnwpqe08wc83ny0260wm6hs5c9tzd4cuwy balance 0utia. Fund this address at https://mocha.celenium.io/faucet`. No PayForBlobs transaction was broadcast, and `posts.json` was not written. The faucet was not used. The mnemonic stayed on the local disk and is not in this repo.

Observed on a funded mainnet run (reported, not re-run from this environment):

- `POST /v1/deposit/send` returned 200 `{ "txHash", "paymentId" }` with response header `deprecation: true`. Status was `{ "txHash", "status": "confirmed" }` immediately.
- EIP-191 over the nonce returned 403 `signer is neither the escrow buyer nor an authorized device key`, even though that signature recovers to the buyer. EIP-191 over the paymentId, on the same paymentId and with no second deposit, returned 200.
- `payment-response` decoded to `{ "success": true, "network": "eip155:714", "payer": "<buyer>" }`. The completion's `houston.cost_tia` was `9147039588615` against a deposit of `15603773415873`. `cost_usd` was on that object; the number is not copied here. The buyer address and transaction hash are not copied here either. Redacted fixtures for the 403, the 200 body, `payment-response`, `deposit/send`, and `deposit/status` are in `test/fixtures/` and contain no signed transaction.

Not exercised from this environment:

- Another funded Eden deposit. This checkout has no funded Eden key, so the shapes above are locked to that report and to the unit fixtures.
- A Stripe API call. Webhook signature checks are unit-tested with a local secret.
- A funded Mocha submit. The helper reads the blob back after `Submit` and only then prints the height and commitment, but this environment has no faucet TIA, so that round trip was not run. `npm run post` on an unfunded key stops before broadcasting.

## Layout

```
src/demo.ts           dry-run or live entry
src/models.ts         live Houston price table (`npm run models`)
src/model-costs.ts    cost of a typical call from that list
src/preflight-cli.ts  read-only go/no-go
src/houston.ts        402 quote, deposit helpers, Payment-Signature
src/trace.ts          redacted live HTTP trace
src/receipts.ts       hash-chained JSONL
celestia/             Go helper: celestia-node client, public Mocha endpoints
src/mocha.ts          spawns the helper for post and verify
src/celestia.ts       namespace, payload bytes, optional light-node JSON-RPC
src/stripe.ts         Checkout and the webhook
src/run.ts            wires the demo together
```

Keep the diff small. The model does not get the key, and the cap does not live inside the prompt.
