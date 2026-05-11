# Polymarket World Cup Import Engine

This engine fetches Polymarket World Cup markets, normalizes them into a local reference format, and can optionally create paused local markets plus a JSON mapping file.

## What It Does

- discovers World Cup / FIFA / soccer-related markets from Polymarket Gamma
- fetches public CLOB quotes for each outcome token
- writes normalized snapshots to JSON
- optionally creates matching paused local markets
- stores local ↔ Polymarket token mappings in:
  - [reference-mappings/polymarket-worldcup.json](/C:/Users/hecto/Desktop/projects/PolyProj/poly-bot/reference-mappings/polymarket-worldcup.json)

## Public Endpoints Used

- Gamma API:
  - `https://gamma-api.polymarket.com/markets`
- CLOB API:
  - `https://clob.polymarket.com/book?token_id=...`
  - `https://clob.polymarket.com/price?token_id=...&side=BUY`
  - `https://clob.polymarket.com/price?token_id=...&side=SELL`
  - `https://clob.polymarket.com/midpoint?token_id=...`

## Dry Run

Default mode is dry run.

```powershell
cd poly-bot
cmd /c npm.cmd run import:polymarket-worldcup
```

Optional flags:

```powershell
cmd /c npm.cmd run import:polymarket-worldcup -- --limit 50 --query "world cup" --output ..\\Poly\\test-logs\\polymarket-worldcup-import.json
```

## Create Local Markets

Create mode is explicit.

Requirements:
- running local app server
- admin session cookie in `POLY_SIM_SESSION_COOKIE`

Command:

```powershell
cd poly-bot
$env:POLY_BOT_BASE_URL='http://127.0.0.1:3000'
$env:POLY_SIM_SESSION_COOKIE='next-auth.session-token=...'
cmd /c npm.cmd run import:polymarket-worldcup -- --limit 1 --dry-run false --create-local-markets true
```

Behavior:
- uses the existing admin market creation endpoint
- creates `ORDERBOOK` / `PUBLIC` local markets
- pauses them immediately after creation
- does not start bots
- does not place orders

## Mapping Model

Each mapping row records:
- local market id
- local outcome label
- Polymarket external market id
- condition id
- slug
- token id
- Polymarket outcome label

The mapping file is the first idempotency layer.

## Outcome Mapping

The importer assumes Polymarket `clobTokenIds` align to normalized outcome labels in order:
- first token → first outcome label
- second token → second outcome label

For binary markets this is usually:
- `Yes`
- `No`

## Risks

- wrong market mapping:
  - different markets can have similar wording
- different resolution rules:
  - local resolution policy may differ from Polymarket
- stale data:
  - public quotes can be empty or temporarily unavailable
- unrelated World Cup markets:
  - cricket/rugby results may still require manual review
- duplicate local markets:
  - mapping file helps, but manual approval is still recommended

## Recommended Workflow

1. run dry import
2. inspect the JSON output and sample rows
3. verify token IDs / outcomes manually for a few markets
4. run create mode with `--limit 1`
5. review the created local market and mapping file
6. only then consider larger create batches

## Intentionally Not Included

- no trading connection
- no MM integration
- no automatic seeding
- no order placement
- no bot startup
