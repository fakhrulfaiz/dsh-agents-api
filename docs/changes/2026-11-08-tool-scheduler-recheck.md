# Tool scheduler recheck on DSH master (2026-11-08)

## Verdict

`resolved`

## Setup

- DSH commit: `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159` (master).
- Profile `agents` bundles `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, and `@deepseek-ai/dsh-experimental-agents-api` (linked to this repo).
- Host: `pnpm dsh --profile agents --no-open`, listening on 127.0.0.1:3080. DSH needed `pnpm run build:artifacts` first; before it, startup failed on missing `lib/` output.
- Smoke: `../agents-api-client/function_tool_smoke.py`.

## Results

1. Unmodified smoke (model `deepseek/deepseek-v4.1-flash`): `turn.failed` with `INVALID_REQUEST: The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek/deepseek-v4.1-flash`. This is a model-name error from the DeepSeek API, not the scheduler error.
2. Smoke with the model changed to `deepseek-flash` (a copy outside the client repo): the turn completed.

```
turn.item.added          message item_msg_20
turn.item.done           message item_msg_20
requires_action          get_weather({"city": "San Francisco"})
tool_result              {"city": "San Francisco", "temp_f": 68, "condition": "clear"}
turn.item.added          message item_msg_26
San Francisco is currently clear and 68°F.
turn.item.done           message item_msg_26
turn.completed           turn_339e227a554c4380b0a3b675d87c9832
```

The `Cannot read properties of undefined (reading 'prepare')` error did not appear.

## Follow-up

The client smoke script hardcodes `deepseek/deepseek-v4.1-flash`, which the API rejects. Use `deepseek-flash` or `deepseek-v4-pro`.
