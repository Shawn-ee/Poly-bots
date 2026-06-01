# poly-bot

`poly-bot` is a separate Node.js + TypeScript project that acts like an external user of `Poly`. It talks only to the canonical HTTP/SSE API, authenticates with API keys, and does not import `Poly` server internals or access the database.

## What It Does

- Runs one or more deterministic, non-AI simulated traders against `http://localhost:3000`
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
- Uses limit orders only
- Writes readable per-bot logs to `logs/`

## Bot Types

- `tightMarketMaker`: keeps both bid and ask near fair price, improves the top of book when reasonable, and refreshes stale quotes quickly
- `inventoryAwareMaker`: keeps both sides quoted but leans prices based on current inventory so the bot does not drift too far one way
- `dynamicMarketMaker`: builds a small bid/ask ladder from the current binary book, widens or tightens spread from live market width, and scales quoting by inventory pressure
- `referenceArbitrageRebalancer`: takes local prices that are materially away from mapped reference fair value while respecting per-market bankroll and rollout guards
- `noiseTrader`: occasionally joins or crosses the spread with small size to generate fills and believable short-term price action

These bots are rule-based only. There is no LLM, news inference, or external intelligence.

## Market Model

- Fair price defaults to midpoint when both best bid and best ask exist
- If one side is missing, fair price is inferred conservatively from the available side
- If the book is empty, bots fall back to a configured reference price, usually `0.50`
- Prices are normalized to tick size and clamped to valid market bounds

## Simulation Behavior

- Makers quote within a few ticks of fair value instead of far away passive orders
- Some bots maintain both bid and ask simultaneously
- `noiseTrader` can take liquidity with a low bounded probability to create actual prints
- Orders are canceled when stale, too far from fair price, or too far from top-of-book
- Duplicate / near-duplicate quotes are suppressed unless a materially better replacement is needed
- Loop timing uses jitter so bots do not all act on the same cadence

## Safety Controls

- Total open-order cap per bot/API key
- Max orders per side
- Max long inventory per outcome
- Decision cooldowns
- Cap backoff for `OPEN_ORDER_LIMIT_EXCEEDED`
- Terminal pause or long cooldown for `DAILY_NOTIONAL_LIMIT_EXCEEDED`
- Transport / auth / validation errors classified separately in the runner

## Daily Notional Exhaustion

When the exchange returns `DAILY_NOTIONAL_LIMIT_EXCEEDED`, the bot no longer retries every poll.

- Default behavior is `pause_for_run`
- The runner emits a `bot_paused` event once
- Further placement attempts are suppressed instead of creating repeated submit/error loops
- Stale order cancellation can still happen if the bot has open orders

You can change this with `dailyNotionalPauseMode` if you want cooldown-until-reset behavior instead.

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
4. Update `marketIds` and any simulation knobs you care about

Useful config fields:

- `strategy`
- `loopIntervalMinMs` / `loopIntervalMaxMs`
- `pausedPollIntervalMs`
- `maxOpenOrders`
- `targetSpreadTicks`
- `quoteOffsetMinTicks` / `quoteOffsetMaxTicks`
- `staleOrderMs`
- `minQuoteLifetimeMs`
- `staleDistanceTicks`
- `replaceThresholdTicks`
- `maxOrdersPerSide`
- `takerProbability`
- `takerThresholdTicks`
- `maxPositionShares`
- `inventoryTargetShares`
- `inventorySkewStrength`
- `dynamicMarketMaker`
- `referenceArbitrageRebalancer`
- `dailyNotionalPauseMode`

Environment variables are optional overrides for the same defaults in `.env.example`.

## Local Simulation Setup

The local `Poly` script [create_sim_bot_credentials.ts](C:\Users\hecto\Desktop\projects\PolyProj\Poly\scripts\create_sim_bot_credentials.ts) now:

- creates 20 bot credentials
- sets `maxOpenOrders` to `6`
- sets sim `maxDailySubmittedNotional` to `20000.000000`
- seeds small starting inventory so makers can post asks as well as bids
- mixes `tightMarketMaker`, `inventoryAwareMaker`, and `noiseTrader`
- writes the generated bot config to [generated.bots.json](C:\Users\hecto\Desktop\projects\PolyProj\poly-bot\generated.bots.json)

When a bot is paused for `DAILY_NOTIONAL_LIMIT_EXCEEDED`, it now enters a low-traffic idle mode instead of continuing the full quote/evaluate loop. It uses `pausedPollIntervalMs` for a slow heartbeat and avoids repeated skip-log spam.

## Run

Development:

```bash
npm run dev
```

Reference arbitrage observation only:

```bash
REFERENCE_ARB_ENABLED=true \
REFERENCE_ARB_DRY_RUN=true \
REFERENCE_ARB_ONLY=true \
REFERENCE_ARB_MARKET_IDS=market-1,market-2 \
npm run bot
```

This does three things at startup:
- filters execution down to bots whose strategy is `referenceArbitrageRebalancer`
- forces that strategy into dry-run mode
- overrides the selected market list for those bots

Single-market live rollout guard:

```json
{
  "strategy": "referenceArbitrageRebalancer",
  "marketIds": ["market-1", "market-2"],
  "referenceArbitrageRebalancer": {
    "enabled": true,
    "dryRun": false,
    "allowedMarketIds": ["market-1"],
    "maxLiveMarkets": 1,
    "liveBankrollOverride": 100
  }
}
```

Live guard behavior:
- `allowedMarketIds` restricts which configured markets may place live orders
- `maxLiveMarkets` limits live trading to the first N eligible markets in bot config order
- `liveBankrollOverride` caps live bankroll below the normal `maxBankrollPerMarket` for controlled rollout

Build and run:

```bash
npm run build
npm start
```

## Reference Liquidity Runbook

Local reference-market supervision uses three terminals:

Terminal 1:
```bash
cd ../Poly
npm run dev
```

Terminal 2:
```bash
cd ../Poly
npm run reference:snapshot-watch
```

Terminal 3:
```bash
cd poly-bot
npm run liquidity:runtime
```

Operational notes:
- `npm run liquidity:runtime` is dry-run by default and does not place live orders without explicit live flags.
- To seed a market bot:
```bash
npm run liquidity:seed-market-bot -- --slug will-france-win-the-2026-fifa-world-cup-924 --capitalDollars 1000 --mintDollars 200 --dryRun true
```
- To prepare a market for dry-run or live review, use `/admin/reference-markets` in the app:
  - run readiness check
  - mark `dry_run_ready`
  - mark `live_ready`
  - pause bot
  - emergency stop
  - cancel bot quotes
- Live quote management still requires:
  - `SYSTEM_LIQUIDITY_DRY_RUN=false`
  - `LIVE_SYSTEM_LIQUIDITY_ENABLED=true`
  - market lifecycle `live_enabled`
  - explicit `--confirmLive true`

To verify no user simulation bots are running, do not start `npm run dev`, `npm run sim:all`, `npm run bots:restart-clean`, or any noise-trader/simulation workflow from this repo.

## Clean Reset

Use the reset workflow when you want to cancel all bot-owned open orders, clear bot-run monitor state, and start a fresh simulation run without touching non-bot users.

Dry run:

```bash
npm run bots:reset -- --dry-run
```

Full reset without restart:

```bash
npm run bots:reset
```

Full reset and restart:

```bash
npm run bots:restart-clean
```

What it clears:

- open orders created by the configured bot API credentials
- bot API usage logs
- bot API order request history
- bot API rate-limit buckets
- bot account canonical account-stream events used by Bot Monitor
- local `poly-bot/logs/*.log`

What it does not clear:

- non-bot users
- non-bot orders
- market data for normal users
- fills, ledger rows, or positions for unrelated accounts

Safety notes:

- bot discovery is config-scoped first, using the bot config file and bot API key IDs
- the reset only targets the matching bot API credentials and their users
- Bot Monitor current-run totals are separated by a run boundary file so old archive data does not pollute the new run
- the wrapper uses the local runner PID file to stop the existing `poly-bot` process before restart when possible

## Logging

Each bot logs structured events such as:

- `quote_seen`
- `decision_made`
- `order_submission`
- `order_submitted`
- `order_submit_skipped`
- `order_canceled`
- `fill_seen`
- `bot_paused`
- `error`

This makes it easier to distinguish normal non-action from true failure states.
