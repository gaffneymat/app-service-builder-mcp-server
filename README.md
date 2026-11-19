# Northlight Cameras: an AI and MCP demo on Azure App Service Builder

A small Node.js app that shows, in the browser, how an AI model uses MCP tools to answer real questions.
Northlight Cameras is a **fictional** camera shop: every brand, product, price, store and order is invented
(`catalogue.mjs`).

Ask the shop assistant something like "a mirrorless camera under 15 000 kr that I can pick up in Stockholm".
The page shows, step by step:

1. the app's AI agent connecting to the app's own MCP server (`initialize`, `tools/list`),
2. the AI model deciding which tools to call and with which arguments,
3. each MCP `tools/call` and what it returned (the raw JSON-RPC is one click away),
4. the model's answer, plus cards for every product the tools returned.

It started from Microsoft's App Service Builder MCP server and AI assistant samples; the sample pages are gone.

## Routes

| Route | Who can call it | What it does |
|---|---|---|
| `GET /` | Signed-in visitors | The demo page |
| `POST /api/demo/chat` | Signed-in visitors, same-origin browser requests only | Runs the agent and streams each step as NDJSON |
| `POST /mcp` | Clients with `APP_API_TOKEN` | Stateless MCP server: `search_products`, `get_product`, `check_stock`, `get_order_status`, `ask_model` |
| `POST /agent` | Clients with `APP_API_TOKEN` | One tool-free question to the model |
| `GET /health` | Anyone who reaches the app | Liveness, never calls the model |
| `GET /ready` | Signed-in visitors | Model readiness: 200 only after a real model reply in the last 5 minutes |

Visitors are admitted by Builder's own Entra sign-in (the app's Authentication settings). The demo route trusts that
sign-in and adds its own limits: same-origin requests only, 12 questions a minute and 300 a day per running instance
(`DEMO_PER_MINUTE`, `DEMO_PER_DAY`), at most 5 model calls and 8 tool calls per question, 45 seconds per question.
The counters reset when the app restarts.

## How the agent works

`demo.mjs` is a real MCP client. For each question it posts JSON-RPC to `http://127.0.0.1:<port>/mcp` with the app
token, lists the tools, offers the four shop tools to the model as functions (never `ask_model`), runs every
`tools/call` the model asks for, and feeds the results back as `function_call_output` items until the model answers.
The token never leaves the server process.

The model is Azure OpenAI through the Responses API (`model.mjs`), reached with the app's system-assigned managed
identity, so no model key is stored.

## Configuration

| Variable | Purpose |
|---|---|
| `APP_API_TOKEN` | At least 32 characters. Protects `/mcp` and `/agent`; the demo agent uses it for its loopback MCP calls |
| `MODEL_SERVICE` | `azure-openai` (or `openai` with `OPENAI_API_KEY` and `OPENAI_MODEL`) |
| `AZURE_OPENAI_ENDPOINT` | `https://<account>.openai.azure.com/openai/v1/` |
| `AZURE_OPENAI_DEPLOYMENT` | The deployment name, for example `gpt-4.1-mini` |
| `PUBLIC_ORIGIN` | The app's exact HTTPS origin; required for browser calls to the demo route |
| `DEMO_PER_MINUTE`, `DEMO_PER_DAY` | Optional demo caps (defaults 12 and 300) |

The app's identity needs **Cognitive Services OpenAI User** on the Azure OpenAI account. `infra/model.bicep` and
`infra/app.bicep` describe the model account and app. In Builder, saved variables only take effect on the next
deployment.

## Run locally

```sh
npm ci
npm test
```

`npm test` runs Node's built-in test runner against a scripted model; no Azure calls are made. Run it serially on
slow machines (`node --test --test-concurrency=1`). `node client.mjs` with `MCP_URL` and `APP_API_TOKEN` set
exercises `/mcp` from the command line; in Builder, outside clients also need a platform credential in
`X-Embr-Authorization`.

## Licence

MIT, see `LICENSE.md`. Derived from Microsoft's App Service Builder samples.
