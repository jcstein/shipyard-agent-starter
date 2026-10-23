# Model costs

Each SHIPYARD team gets about £20 to pay for Houston inference on Eden mainnet (chain id 714). Houston's list prices are USD. On 23 Oct 2026 [CoinGecko's exchange rates](https://api.coingecko.com/api/v3/exchange_rates) were 1.338835 USD per GBP (the USD and GBP value of 1 BTC), so £20 is $26.7767. The same feed priced TIA at $0.558911 and £0.41746, the same cross, and £20 is about 48 TIA. Celestia receipts use free Mocha faucet TIA from [mocha.celenium.io/faucet](https://mocha.celenium.io/faucet). Faucet TIA pays for Mocha blob posts. Eden TIA pays Houston.

## Prices

Prices come from Houston's live model list:

```
GET https://inference.bot.fun/v1/models
```

Each model has `input_usd_per_1m` and `output_usd_per_1m`, USD per 1,000,000 tokens. Re-check that endpoint before you treat a figure as current. Prices change.

`npm run models` prints the table below from the live list and prints both £ and $. `BUDGET_GBP` is the budget in pounds (default `20`). `GBP_USD`, when set, is USD per 1 GBP and the command uses that instead of CoinGecko.

## A measured call

On 22 Oct 2026 a paid `qwen/qwen-flash` completion used 31 input tokens and 19 output tokens. Houston reported `cost_tia` `9147039588615` wei (see [First funded run](../README.md#first-funded-run)).

`9147039588615` wei is `0.000009147039588615` TIA. At $0.56/TIA that is about $0.0000051.

The list price for `qwen/qwen-flash` is $0.022 per 1M input tokens and $0.22 per 1M output tokens:

```
31 / 1,000,000 * 0.022 + 19 / 1,000,000 * 0.22 = $0.00000486
```

That matches the settled wei at about $0.56/TIA.

## What £20 buys

A typical call in this table is 2,000 input tokens and 500 output tokens. Cost per call is USD:

```
2,000 / 1,000,000 * input_usd_per_1m + 500 / 1,000,000 * output_usd_per_1m
```

Calls per £20 is $26.7767 divided by that cost. Output tokens per £20 is that many calls times 500. Both columns use the same assumption: every call is 2,000 input tokens and 500 output tokens. Counts are rounded to the nearest whole number.

The rate for this snapshot is 1.338835 USD per GBP on 23 Oct 2026, from CoinGecko. Model prices are a snapshot of `GET /v1/models` the same day. Cheapest call first.

| Model | $ / 1M input | $ / 1M output | $ / call | Calls / £20 ($26.7767) | Output tokens / £20 ($26.7767) |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen/qwen-flash` | 0.022 | 0.22 | 0.000154 | 173,875 | 86,937,338 |
| `deepseek/deepseek-v4-flash` | 0.08 | 0.252 | 0.000286 | 93,625 | 46,812,413 |
| `openai/gpt-5-nano` | 0.05 | 0.4 | 0.0003 | 89,256 | 44,627,833 |
| `google/gemini-2.5-flash-lite` | 0.1 | 0.4 | 0.0004 | 66,942 | 33,470,875 |
| `mistralai/ministral-3-14b` | 0.2 | 0.2 | 0.0005 | 53,553 | 26,776,700 |
| `qwen/qwen3.8-flash` | 0.15 | 0.47 | 0.000535 | 50,050 | 25,024,953 |
| `openai/gpt-oss-120b` | 0.1 | 0.7 | 0.00055 | 48,685 | 24,342,455 |
| `z-ai/glm-5.3-flash` | 0.15 | 0.5 | 0.00055 | 48,685 | 24,342,455 |
| `google/gemma-4-31b-it` | 0.18 | 0.5 | 0.00061 | 43,896 | 21,948,115 |
| `x-ai/grok-4.1-fast` | 0.2 | 0.5 | 0.00065 | 41,195 | 20,597,462 |
| `meta-llama/llama-4-maverick` | 0.25 | 0.87 | 0.000935 | 28,638 | 14,319,091 |
| `minimax/minimax-m2.5` | 0.3 | 1.2 | 0.0012 | 22,314 | 11,156,958 |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.5 | 0.00125 | 21,421 | 10,710,680 |
| `qwen/qwen3-max` | 0.36 | 1.43 | 0.001435 | 18,660 | 9,329,861 |
| `xiaomi/mimo-v2.5-pro` | 0.4 | 1.5 | 0.00155 | 17,275 | 8,637,645 |
| `deepseek/deepseek-v3.2` | 0.5 | 1.6 | 0.0018 | 14,876 | 7,437,972 |
| `qwen/qwen3.8-27b` | 0.45 | 3.2 | 0.0025 | 10,711 | 5,355,340 |
| `z-ai/glm-5.2` | 0.7 | 2.2 | 0.0025 | 10,711 | 5,355,340 |
| `qwen/qwen3.5-397b-a17b` | 0.55 | 3.5 | 0.00285 | 9,395 | 4,697,667 |
| `z-ai/glm-5` | 1 | 3.2 | 0.0036 | 7,438 | 3,718,986 |
| `openai/gpt-5.4-mini` | 0.75 | 4.5 | 0.00375 | 7,140 | 3,570,227 |
| `moonshotai/kimi-k2.6` | 0.95 | 4 | 0.0039 | 6,866 | 3,432,910 |
| `anthropic/claude-haiku-4.5` | 1 | 5 | 0.0045 | 5,950 | 2,975,189 |
| `deepseek/deepseek-v4-pro` | 1.74 | 3.48 | 0.00522 | 5,130 | 2,564,818 |
| `qwen/qwen3.8-max` | 2 | 6 | 0.007 | 3,825 | 1,912,621 |
| `x-ai/grok-4.6` | 2 | 6 | 0.007 | 3,825 | 1,912,621 |
| `google/gemini-2.5-pro` | 1.25 | 10 | 0.0075 | 3,570 | 1,785,113 |
| `anthropic/claude-sonnet-5` | 2 | 10 | 0.009 | 2,975 | 1,487,594 |
| `google/gemini-3.1-pro-preview` | 2 | 12 | 0.01 | 2,678 | 1,338,835 |
| `openai/gpt-5.4` | 2.5 | 15 | 0.0125 | 2,142 | 1,071,068 |
| `anthropic/claude-sonnet-4.6` | 3 | 15 | 0.0135 | 1,983 | 991,730 |
| `anthropic/claude-opus-4.8` | 5 | 25 | 0.0225 | 1,190 | 595,038 |
| `openai/gpt-5.5` | 5 | 30 | 0.025 | 1,071 | 535,534 |

## Spending the £20

The only realistic way to burn through £20 is running the priciest models (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`) in tight loops with big contexts. At 2,000 input and 500 output tokens, GPT-5.5 is $0.025 a call (1,071 calls per £20) and Opus 4.8 is $0.0225 (1,190 calls). The same size on `qwen/qwen-flash` is $0.000154 (173,875 calls). A single `npm run demo` is one call.

Keep `SPEND_CAP_TIA` set. The default is `0.05` TIA, enforced in this process before a deposit is signed. See [Spend cap](../README.md#spend-cap).
