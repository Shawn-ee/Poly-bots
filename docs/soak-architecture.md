# Soak Architecture

This document describes the current soak harness structure after the realism-separation cleanup. It is a harness/documentation change only. Matching logic, private-pool logic, canonical APIs, frontend behavior, runtime SSE behavior, and market-maker pricing were intentionally left unchanged.

## Purpose

The soak harness in `Poly/scripts/soak_orderbook_bots.ts` serves two different purposes:

1. Exercise the real bot runtime against the real app APIs.
2. Add synthetic market shaping so matching, lifecycle, and invariants can be observed under load.

Those purposes are now separated more explicitly so market-maker quality can be measured apart from scaffold activity.

## Actor Categories

### Real Runtime Bots
- `dynamicMarketMaker`
  - system liquidity bot
  - runs through `poly-bot/src/runner/botRunner.ts`
- `noiseTrader`
  - user-simulation bot
  - also runs through `BotRunner`

These use the canonical trading APIs:
- `POST /api/orders`
- `DELETE /api/orders/:id`
- `GET /api/orders`

### Soak-Only Synthetic Actors
- reference inventory seeders
- reference book reshapers
- warmup actors
- manual pressure actors
- synthetic fair-value controller

These are harness-only. They are not production strategies.

## Soak Modes

### `full_synthetic`
- current heavy scaffold mode
- reference shaping enabled
- warmup enabled
- manual pressure enabled
- noise bots enabled

This preserves the legacy/default soak behavior.

### `light_reference`
- reduced reference-book crowding
- warmup disabled
- manual pressure enabled
- noise bots enabled

Use this to evaluate the market maker with lighter touch competition from scaffold actors.

### `user_flow`
- no reference shaping
- no warmup
- manual pressure enabled
- noise bots enabled

Use this to observe mostly user-like interaction with minimal scaffold shaping.

### `isolated_mm`
- market maker only
- no reference shaping
- no warmup
- no manual pressure
- no noise bots

Use this to test runtime safety and inventory behavior in relative isolation. It is not realistic as a market.

## Realism Metrics

The soak summary now separates scaffold interaction from MM interaction:

- `fills_against_reference_actors`
- `fills_against_noise_traders`
- `fills_against_manual_actors`
- `fills_against_real_mm`
- `touch_time_without_reference`
- `reference_book_crowding_ratio`
- `mm_queue_priority_estimate`

These metrics help answer different questions:

- Is the MM interacting with real flow or mostly scaffold flow?
- Is the reference book crowding the touch?
- Is the MM usually at or behind queue priority?

## Runtime Ownership

The harness still uses `BotRunner` directly, but it now calls a public single-cycle entrypoint instead of reaching into a private method. This reduces coupling without redesigning the runtime.

Current ownership:
- `BotRunner` owns bot runtime state, SSE freshness, polling fallback, and trading decisions.
- `soak_orderbook_bots.ts` owns synthetic market shaping, fairness path control, mode selection, and run summarization.

## Production-Relevant vs Soak-Only Config

Production-relevant bot runtime concepts:
- runtime SSE freshness
- polling reconciliation
- canonical API usage
- bot strategy config

Soak-only config:
- soak mode
- reference shaping mode
- synthetic fair-value path
- warmup enablement
- manual pressure cadence
- actor counts for synthetic load generation

## Known Limitations

- The soak harness still lives in one large script.
- Positions are still refreshed by polling, not account SSE.
- Reference actors can still distort realism in `full_synthetic` mode by design.
- `isolated_mm` is useful for runtime validation, not market realism.

## Recommended Evaluation Modes

- Matching/lifecycle smoke: `full_synthetic`
- MM quality with reduced crowding: `light_reference`
- User-flow realism: `user_flow`
- Runtime isolation and safety: `isolated_mm`

## Intentionally Not Changed

- matching engine logic
- private-pool logic
- market-maker pricing/tuning
- canonical order APIs
- runtime SSE contract
- frontend behavior
