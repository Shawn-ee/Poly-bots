# poly-bot

`poly-bot` is a separate Node.js + TypeScript project that acts like an external user of `Poly`. It talks only to the canonical HTTP/SSE API, authenticates with API keys, and does not import `Poly` server internals or access the database.

## What It Does

- Runs one or more conservative autonomous bots locally against `http://localhost:3000`
- Uses canonical routes only:
  - `GET /api/markets`
  - `GET /api/markets/:id/quote`
  - `POST /api/orders`
  - `GET /api/orders`
  - `GET /api/orders/:id`
  - `DELETE /api/orders/:id`
  - `GET /api/fills`
  - `GET /api/account/balance`
  - `GET /api/account/positions`
  - `GET /api/account/ledger`
  - optional helpers for `GET /api/stream/market/:marketId` and `GET /api/stream/me/orders`
- Uses limit orders only
- Sends `Idempotency-Key` on every order submission
- Writes readable per-bot logs to `logs/`

## Current Strategies

- `passiveBuyer`: posts small buy limits at or below the top of book, respects total open-order caps, and skips duplicate working quotes
- `passiveSeller`: posts small sell limits conservatively when inventory exists and avoids redundant working orders
- `randomMaker`: occasionally posts very small buy or sell limits near the book with cooldowns and duplicate suppression

## Requirements

- Node.js 20+
- API keys created inside the `Poly` exchange app
- The `Poly` app running locally, usually at `http://localhost:3000`

## Install

```bash
npm install
```

## Configure

1. Copy `.env.example` to `.env`
2. Copy `bots.example.json` to `bots.json`
3. Replace each `apiKey` with a real canonical API key in the format `keyId.secret`
4. Update `marketIds` and optional bot limits

Environment variables are optional overrides for safe defaults, including:

- `POLY_BOT_CONFIG`
- `POLY_BOT_BASE_URL`
- `POLY_BOT_POLL_INTERVAL_MS`
- `POLY_BOT_STALE_ORDER_MS`
- `POLY_BOT_DECISION_COOLDOWN_MS`
- `POLY_BOT_CAP_BACKOFF_MS`
- `POLY_BOT_TICK_SIZE`
- `POLY_BOT_MAX_ORDER_SIZE`
- `POLY_BOT_MAX_OPEN_ORDERS`
- `POLY_BOT_SIMILAR_ORDER_TICKS`
- `POLY_BOT_MAX_SIMILAR_OPEN_ORDERS`
- `POLY_BOT_MAX_ORDERS_PER_SIDE_PER_OUTCOME`
- `POLY_BOT_STARTUP_STAGGER_MS`

## Run One Or More Bots

Development:

```bash
npm run dev
```

Build and run:

```bash
npm run build
npm start
```

All bots listed in the config file are started by the orchestrator. To run just one bot, keep only one entry in `bots.json`.

## Simulation Defaults

- The local sim credential generator in `Poly/scripts/create_sim_bot_credentials.ts` now creates API keys with `maxOpenOrders: 6`
- Generated sim bot configs use `staleOrderMs: 12000`
- The runner enforces the total open-order cap using `GET /api/orders?status=OPEN,PARTIAL`
- When the exchange still returns `OPEN_ORDER_LIMIT_EXCEEDED`, the bot enters a short cooldown before trying to place again
- Bots skip placing a new order when an existing same-side order is already within one tick of the target quote

## Logging

- Each bot logs to console and `logs/<bot-name>.log`
- Logs include timestamps, bot name, `quote_seen`, `decision_made`, `order_submitted`, `order_submit_skipped`, `order_canceled`, `fill_seen`, and `error`

## Limitations

- Limit orders only
- No market orders
- External-user style only
- No database access
- No imports from `Poly` internals
- Polling-first runner design
- Account balances and positions are user-level on the server, not isolated per API key
- Optional SSE helper is included for future use but is not required by the runner
