# Model costs

Each SHIPYARD team gets about $10 of TIA to pay for Houston inference on Eden mainnet (chain id 714). At about $0.56 per TIA on 22 Oct 2026, that is about 18-20 TIA. Celestia receipts use free Mocha faucet TIA from [mocha.celenium.io/faucet](https://mocha.celenium.io/faucet). Faucet TIA pays for Mocha blob posts. Eden TIA pays Houston.

## Prices

Prices come from Houston's live model list:

```
GET https://inference.bot.fun/v1/models
```

Each model has `input_usd_per_1m` and `output_usd_per_1m`, USD per 1,000,000 tokens. Re-check that endpoint before you treat a figure as current. Prices change. `npm run models` prints the table below from whatever the list returns now.

## A measured call

On 22 Oct 2026 a paid `qwen/qwen-flash` completion used 31 input tokens and 19 output tokens. Houston reported `cost_tia` `9147039588615` wei (see [First funded run](../README.md#first-funded-run)).

`9147039588615` wei is `0.000009147039588615` TIA. At $0.56/TIA that is about $0.0000051.

The list price for `qwen/qwen-flash` is $0.022 per 1M input tokens and $0.22 per 1M output tokens:

```
31 / 1,000,000 * 0.022 + 19 / 1,000,000 * 0.22 = $0.00000486
```

That matches the settled wei at about $0.56/TIA.

## What $10 buys

A typical call in this table is 2,000 input tokens and 500 output tokens. Cost per call is:

```
2,000 / 1,000,000 * input_usd_per_1m + 500 / 1,000,000 * output_usd_per_1m
```

Calls per $10 is $10 divided by that cost. Output tokens per $10 is that many calls times 500. Both columns use the same assumption: every call is 2,000 input tokens and 500 output tokens. Counts are rounded to the nearest whole number.

Snapshot of `GET /v1/models` on 23 Oct 2026. Cheapest call first.

| Model | $ / 1M input | $ / 1M output | $ / call | Calls / $10 | Output tokens / $10 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen/qwen-flash` | 0.022 | 0.22 | 0.000154 | 64,935 | 32,467,532 |
| `deepseek/deepseek-v4-flash` | 0.08 | 0.252 | 0.000286 | 34,965 | 17,482,517 |
| `openai/gpt-5-nano` | 0.05 | 0.4 | 0.0003 | 33,333 | 16,666,667 |
| `google/gemini-2.5-flash-lite` | 0.1 | 0.4 | 0.0004 | 25,000 | 12,500,000 |
| `mistralai/ministral-3-14b` | 0.2 | 0.2 | 0.0005 | 20,000 | 10,000,000 |
| `qwen/qwen3.8-flash` | 0.15 | 0.47 | 0.000535 | 18,692 | 9,345,794 |
| `openai/gpt-oss-120b` | 0.1 | 0.7 | 0.00055 | 18,182 | 9,090,909 |
| `z-ai/glm-5.3-flash` | 0.15 | 0.5 | 0.00055 | 18,182 | 9,090,909 |
| `google/gemma-4-31b-it` | 0.18 | 0.5 | 0.00061 | 16,393 | 8,196,721 |
| `x-ai/grok-4.1-fast` | 0.2 | 0.5 | 0.00065 | 15,385 | 7,692,308 |
| `meta-llama/llama-4-maverick` | 0.25 | 0.87 | 0.000935 | 10,695 | 5,347,594 |
| `minimax/minimax-m2.5` | 0.3 | 1.2 | 0.0012 | 8,333 | 4,166,667 |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.5 | 0.00125 | 8,000 | 4,000,000 |
| `qwen/qwen3-max` | 0.36 | 1.43 | 0.001435 | 6,969 | 3,484,321 |
| `xiaomi/mimo-v2.5-pro` | 0.4 | 1.5 | 0.00155 | 6,452 | 3,225,806 |
| `deepseek/deepseek-v3.2` | 0.5 | 1.6 | 0.0018 | 5,556 | 2,777,778 |
| `qwen/qwen3.8-27b` | 0.45 | 3.2 | 0.0025 | 4,000 | 2,000,000 |
| `z-ai/glm-5.2` | 0.7 | 2.2 | 0.0025 | 4,000 | 2,000,000 |
| `qwen/qwen3.5-397b-a17b` | 0.55 | 3.5 | 0.00285 | 3,509 | 1,754,386 |
| `z-ai/glm-5` | 1 | 3.2 | 0.0036 | 2,778 | 1,388,889 |
| `openai/gpt-5.4-mini` | 0.75 | 4.5 | 0.00375 | 2,667 | 1,333,333 |
| `moonshotai/kimi-k2.6` | 0.95 | 4 | 0.0039 | 2,564 | 1,282,051 |
| `anthropic/claude-haiku-4.5` | 1 | 5 | 0.0045 | 2,222 | 1,111,111 |
| `deepseek/deepseek-v4-pro` | 1.74 | 3.48 | 0.00522 | 1,916 | 957,854 |
| `qwen/qwen3.8-max` | 2 | 6 | 0.007 | 1,429 | 714,286 |
| `x-ai/grok-4.6` | 2 | 6 | 0.007 | 1,429 | 714,286 |
| `google/gemini-2.5-pro` | 1.25 | 10 | 0.0075 | 1,333 | 666,667 |
| `anthropic/claude-sonnet-5` | 2 | 10 | 0.009 | 1,111 | 555,556 |
| `google/gemini-3.1-pro-preview` | 2 | 12 | 0.01 | 1,000 | 500,000 |
| `openai/gpt-5.4` | 2.5 | 15 | 0.0125 | 800 | 400,000 |
| `anthropic/claude-sonnet-4.6` | 3 | 15 | 0.0135 | 741 | 370,370 |
| `anthropic/claude-opus-4.8` | 5 | 25 | 0.0225 | 444 | 222,222 |
| `openai/gpt-5.5` | 5 | 30 | 0.025 | 400 | 200,000 |

## Spending the $10

The only realistic way to burn through $10 is running the priciest models (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`) in tight loops with big contexts. At 2,000 input and 500 output tokens, GPT-5.5 is $0.025 a call (400 calls per $10) and Opus 4.8 is $0.0225 (444 calls). The same size on `qwen/qwen-flash` is $0.000154 (about 65,000 calls). A single `npm run demo` is one call.

Keep `SPEND_CAP_TIA` set. The default is `0.05` TIA, enforced in this process before a deposit is signed. See [Spend cap](../README.md#spend-cap).
