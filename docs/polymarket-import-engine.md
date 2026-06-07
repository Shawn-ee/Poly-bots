# Polymarket Import Engine

This engine fetches Polymarket World Cup markets, normalizes them into a local reference format, and can optionally create paused local markets plus a JSON mapping file.

## Market Discovery Agent

The Market Discovery Agent is a separate, safer discovery/import path for NBA and FIFA World Cup markets only. It fetches popular active Polymarket markets, rejects unrelated topics, scores candidates, deduplicates against known imports, and writes a review report. It is disabled and dry-run by default.

Allowed verticals:
- `nba`
- `world_cup`

Rejected by policy:
- politics, elections, crypto, celebrity, weather
- unrelated sports
- generic soccer unless the market is clearly FIFA World Cup related
- resolved, closed, archived, tokenless, unsupported multi-outcome, low-quality, or duplicate markets

Draft import defaults:
- `desiredStatus=draft`
- `listed=false`
- `tradable=false`
- `mmEnabled=false`
- `importStatus=pending_review`
- `referenceOnly=true`
- `autoPublish=false`
- `autoResolve=false`

The importer does not list markets, enable trading, enable market making, place orders, start bots, or resolve markets. Admin review is required before listing, trading, market-maker enablement, or resolution proposals.

### Discovery Commands

`package.json` script aliases are intentionally not changed by this agent because they are outside the allowed file scope. Use the direct `tsx` commands below, or add these aliases during a reviewed Backend/Deployment task:

- `market-discovery:dry-run` -> `tsx scripts/marketDiscovery.ts dry-run`
- `market-discovery:once` -> `tsx scripts/marketDiscovery.ts once`
- `market-discovery:watch` -> `tsx scripts/marketDiscovery.ts watch`

Dry-run report:

```bash
cd poly-bot
npx tsx scripts/marketDiscovery.ts dry-run
```

Explicit once mode, still dry-run unless env/flags say otherwise:

```bash
cd poly-bot
npx tsx scripts/marketDiscovery.ts once --dry-run true --top-n 10
```

Watch mode:

```bash
cd poly-bot
POLYMARKET_DISCOVERY_ENABLED=false \
POLYMARKET_DISCOVERY_DRY_RUN=true \
npx tsx scripts/marketDiscovery.ts watch
```

Draft creation is gated by all of the following:
- `POLYMARKET_DISCOVERY_ENABLED=true`
- `POLYMARKET_DISCOVERY_DRY_RUN=false`
- `--create-drafts true`
- valid admin session cookie for the local admin import API
- max imported market cap has remaining capacity

During testing, keep `MAX_NEW_IMPORTS_PER_RUN=1` if exercising explicit draft creation.

### Discovery Environment Defaults

```bash
POLYMARKET_DISCOVERY_ENABLED=false
POLYMARKET_DISCOVERY_DRY_RUN=true
POLYMARKET_DISCOVERY_INTERVAL_MS=1800000
POLYMARKET_DISCOVERY_TOP_N=10
MAX_IMPORTED_MARKETS=300
MAX_NEW_IMPORTS_PER_RUN=10
AUTO_PUBLISH_IMPORTED_MARKETS=false
AUTO_RESOLVE_IMPORTED_MARKETS=false
DISCOVERY_ALLOWED_VERTICALS=nba,world_cup
MIN_REFERENCE_LIQUIDITY=
MIN_REFERENCE_VOLUME=
MAX_REFERENCE_SPREAD=0.10
```

Do not put secrets, cookies, database URLs, or private keys in command output or committed files.

### Discovery Review Report

The JSON report includes:
- candidate source/category/vertical
- score and score breakdown
- accepted/rejected reason
- external Polymarket URL
- draft creation status
- current imported count
- max imported market cap

Default report path:

```text
poly-bot/test-logs/market-discovery.json
```

### Deferred Admin UI/API Work

Frontend and backend admin review surfaces are outside this agent’s allowed edit scope. The review package should add:
- candidate list API backed by the discovery report or a future `MarketCandidate` table
- approve/reject actions with reviewer notes
- imported count/cap display
- source URL, score, category, quality, and draft status columns
- refresh-snapshot action for approved imports only
- resolution proposal creation only; no auto-resolution

### Reference Snapshot Refresh

Approved imported markets can be refreshed through the existing admin reference snapshot flow. Snapshot quality should be interpreted as:
- `high_quality`
- `stale`
- `wide_spread`
- `missing_book`

Market maker eligibility still requires explicit approval and `mmEnabled=true`; discovery never sets that.

### Safety Notes

- Keep the worker disabled by default.
- Keep dry-run enabled by default.
- Keep `AUTO_PUBLISH_IMPORTED_MARKETS=false`.
- Keep `AUTO_RESOLVE_IMPORTED_MARKETS=false`.
- Do not run deposit monitors or live trading workers as part of discovery.
- Do not delete or archive imported markets with open orders, user positions, or unresolved exposure.

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
$env:POLY_BOT_BASE_URL='http://127.0.0.1:3001'
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
