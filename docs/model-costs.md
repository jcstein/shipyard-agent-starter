# Model costs

Each SHIPYARD team gets about $20 of TIA to pay for Houston inference on Eden mainnet (chain id 714). At about $0.56 per TIA on 22 Oct 2026, that is about 35–36 TIA. Celestia receipts use free Mocha faucet TIA from [mocha.celenium.io/faucet](https://mocha.celenium.io/faucet). Faucet TIA pays for Mocha blob posts. Eden TIA pays Houston.

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

## What $20 buys

A typical call in this table is 2,000 input tokens and 500 output tokens. Cost per call is:

```
2,000 / 1,000,000 * input_usd_per_1m + 500 / 1,000,000 * output_usd_per_1m
```

Calls per $20 is $20 divided by that cost. Output tokens per $20 is that many calls times 500. Both columns use the same assumption: every call is 2,000 input tokens and 500 output tokens. Counts are rounded to the nearest whole number.

Snapshot of `GET /v1/models` on 23 Oct 2026. Cheapest call first.

| Model | $ / 1M input | $ / 1M output | $ / call | Calls / $20 | Output tokens / $20 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `qwen/qwen-flash` | 0.022 | 0.22 | 0.000154 | 129,870 | 64,935,065 |
| `deepseek/deepseek-v4-flash` | 0.08 | 0.252 | 0.000286 | 69,930 | 34,965,035 |
| `openai/gpt-5-nano` | 0.05 | 0.4 | 0.0003 | 66,667 | 33,333,333 |
| `google/gemini-2.5-flash-lite` | 0.1 | 0.4 | 0.0004 | 50,000 | 25,000,000 |
| `mistralai/ministral-3-14b` | 0.2 | 0.2 | 0.0005 | 40,000 | 20,000,000 |
| `qwen/qwen3.8-flash` | 0.15 | 0.47 | 0.000535 | 37,383 | 18,691,589 |
| `openai/gpt-oss-120b` | 0.1 | 0.7 | 0.00055 | 36,364 | 18,181,818 |
| `z-ai/glm-5.3-flash` | 0.15 | 0.5 | 0.00055 | 36,364 | 18,181,818 |
| `google/gemma-4-31b-it` | 0.18 | 0.5 | 0.00061 | 32,787 | 16,393,443 |
| `x-ai/grok-4.1-fast` | 0.2 | 0.5 | 0.00065 | 30,769 | 15,384,615 |
| `meta-llama/llama-4-maverick` | 0.25 | 0.87 | 0.000935 | 21,390 | 10,695,187 |
| `minimax/minimax-m2.5` | 0.3 | 1.2 | 0.0012 | 16,667 | 8,333,333 |
| `google/gemini-3.1-flash-lite` | 0.25 | 1.5 | 0.00125 | 16,000 | 8,000,000 |
| `qwen/qwen3-max` | 0.36 | 1.43 | 0.001435 | 13,937 | 6,968,641 |
| `xiaomi/mimo-v2.5-pro` | 0.4 | 1.5 | 0.00155 | 12,903 | 6,451,613 |
| `deepseek/deepseek-v3.2` | 0.5 | 1.6 | 0.0018 | 11,111 | 5,555,556 |
| `qwen/qwen3.8-27b` | 0.45 | 3.2 | 0.0025 | 8,000 | 4,000,000 |
| `z-ai/glm-5.2` | 0.7 | 2.2 | 0.0025 | 8,000 | 4,000,000 |
| `qwen/qwen3.5-397b-a17b` | 0.55 | 3.5 | 0.00285 | 7,018 | 3,508,772 |
| `z-ai/glm-5` | 1 | 3.2 | 0.0036 | 5,556 | 2,777,778 |
| `openai/gpt-5.4-mini` | 0.75 | 4.5 | 0.00375 | 5,333 | 2,666,667 |
| `moonshotai/kimi-k2.6` | 0.95 | 4 | 0.0039 | 5,128 | 2,564,103 |
| `anthropic/claude-haiku-4.5` | 1 | 5 | 0.0045 | 4,444 | 2,222,222 |
| `deepseek/deepseek-v4-pro` | 1.74 | 3.48 | 0.00522 | 3,831 | 1,915,709 |
| `qwen/qwen3.8-max` | 2 | 6 | 0.007 | 2,857 | 1,428,571 |
| `x-ai/grok-4.6` | 2 | 6 | 0.007 | 2,857 | 1,428,571 |
| `google/gemini-2.5-pro` | 1.25 | 10 | 0.0075 | 2,667 | 1,333,333 |
| `anthropic/claude-sonnet-5` | 2 | 10 | 0.009 | 2,222 | 1,111,111 |
| `google/gemini-3.1-pro-preview` | 2 | 12 | 0.01 | 2,000 | 1,000,000 |
| `openai/gpt-5.4` | 2.5 | 15 | 0.0125 | 1,600 | 800,000 |
| `anthropic/claude-sonnet-4.6` | 3 | 15 | 0.0135 | 1,481 | 740,741 |
| `anthropic/claude-opus-4.8` | 5 | 25 | 0.0225 | 889 | 444,444 |
| `openai/gpt-5.5` | 5 | 30 | 0.025 | 800 | 400,000 |

## Spending the $20

The only realistic way to burn through $20 is running the priciest models (`anthropic/claude-opus-4.8`, `openai/gpt-5.5`) in tight loops with big contexts. At 2,000 input and 500 output tokens, GPT-5.5 is $0.025 a call (800 calls per $20) and Opus 4.8 is $0.0225 (889 calls). The same size on `qwen/qwen-flash` is $0.000154 (129,870 calls). A single `npm run demo` is one call.

Keep `SPEND_CAP_TIA` set. The default is `0.05` TIA, enforced in this process before a deposit is signed. See [Spend cap](../README.md#spend-cap).
