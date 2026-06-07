# Live Internal Bot Services

This server can run Poly bots against the internal platform orderbook and ledger. These services do not perform withdrawals, external fund movement, on-chain transfers, or automatic resolution.

Agent workers are review-only around these services. DeepSeek worker agents may summarize logs and draft reports, but they must not start, stop, restart, or deploy production services. Planner Agent or human review is required before any high-risk operational change.

## Safety Flags

Live internal bot order placement requires all of these non-secret flags:

- `POLY_BOTS_ENABLED=true`
- `POLY_BOTS_LIVE_TRADING=true`
- `POLY_BOTS_GLOBAL_KILL_SWITCH=false`
- `POLY_BOTS_MODE=liveInternal`
- `LIVE_SYSTEM_LIQUIDITY_ENABLED=true`
- `SYSTEM_LIQUIDITY_DRY_RUN=false`

The kill switch is the fastest config-level stop:

```bash
POLY_BOTS_GLOBAL_KILL_SWITCH=true
```

The bot runner also enforces order-size and liquidity caps from config:

- `MAX_BOT_ORDER_SIZE`
- `MAX_BOT_DAILY_NOTIONAL`
- `MAX_SYSTEM_LIQUIDITY_PER_MARKET`

## User Services

The server uses user-level systemd services:

- `poly-agent-supervisor.service`: review-only agent monitoring loop.
- `poly-market-maker.service`: live internal tight market maker.
- `poly-liquidity-seeder.service`: one-shot dry-run seeding check.
- `poly-reference-arb.service`: reference liquidity runtime, created but should be started only after reference mapping readiness is confirmed.

Check status:

```bash
systemctl --user status poly-agent-supervisor.service --no-pager
systemctl --user status poly-market-maker.service --no-pager
systemctl --user status poly-liquidity-seeder.service --no-pager
systemctl --user status poly-reference-arb.service --no-pager
```

Check logs:

```bash
journalctl --user -u poly-agent-supervisor.service -n 100 --no-pager
journalctl --user -u poly-market-maker.service -n 100 --no-pager
journalctl --user -u poly-liquidity-seeder.service -n 100 --no-pager
journalctl --user -u poly-reference-arb.service -n 100 --no-pager
```

Emergency stop:

```bash
npm run bots:stop-all
```

or:

```bash
systemctl --user stop poly-market-maker.service
systemctl --user stop poly-reference-arb.service
systemctl --user stop poly-liquidity-seeder.service
systemctl --user stop poly-agent-supervisor.service
```

## Reference Arbitrage

Do not run the reference arbitrage service on the same market as the active market maker until reference mapping and quoting ownership are confirmed. This avoids two services managing the same orderbook.
