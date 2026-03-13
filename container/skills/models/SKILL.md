---
name: models
description: Switch the AI model used for all conversations. Use when the user runs /models or asks to change, switch, or select the AI model.
allowed-tools: Bash(curl:*)
---

# /models — Model Switcher

## Step 1 — Show current status

Run:
```bash
curl -s http://host.docker.internal:3001/model-status
```

Parse the JSON and show the user (no markdown, use platform formatting):

```
Current model: Claude (Anthropic — current subscription) ✓

Available models:
1. claude — Claude (Anthropic — current subscription)
2. minimax — MiniMax M2.5 (200k context, cheaper)
3. openrouter — OpenRouter — Gemini 3 Flash free (1M context)

Reply with a number or name to switch, or "cancel" to keep the current model.
```

## Step 2 — Wait for user reply

Match their reply:
- Number (e.g. "2") → map to that position in the list
- Name (e.g. "minimax") → use directly
- "cancel" or "keep" → confirm no change and stop

## Step 3 — Switch

```bash
curl -s -X POST http://host.docker.internal:3001/model-switch \
  -H "Content-Type: application/json" \
  -d '{"model": "CHOSEN_ID"}'
```

On `"ok": true`, tell the user:
```
Switched to [description]. Takes effect on your next message.
```

On error, show the error message.

## Notes
- Switch takes effect on the **next** message, not the current session
- If a model's key isn't set in .env, calls will fail — warn the user
