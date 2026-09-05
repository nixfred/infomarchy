# Third-party notices

## LiteLLM pricing data

`pricing.json` contains selected numeric price fields (input, output, cache-read and cache-write cost per token, plus the >200k-context variants) for Claude, GPT/Codex, Grok and Gemini models, taken from LiteLLM's `model_prices_and_context_window.json`. Original copyright 2023 Berri AI; the file is distributed under the MIT license reproduced in `licenses/LiteLLM.txt`. The pinned upstream source and revision are recorded inside `pricing.json`.

Infomarchy uses these numbers only to show an *estimated API value* of tokens already processed. It is not a bill, not a subscription price, and models missing from the table are shown as unpriced.
