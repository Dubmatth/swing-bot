# swing-bot

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Node.js 22.6+](https://img.shields.io/badge/Node.js-22.6+-339933?logo=nodedotjs&logoColor=white)
![Zero runtime deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

A swing-trading research platform and paper-trading bot for **Kraken** (20 EUR-quoted crypto pairs, 4h candles).

Built in TypeScript with **zero runtime dependencies**: an event-driven backtest engine, walk-forward validation, a live WebSocket data pipeline and a paper-trading runner deployed on a VPS.

> ⚠️ This is a research project, not financial advice. No strategy here has been validated for real capital.

## What's inside

| Layer | Description |
|---|---|
| **Data** | Strict OHLCVT CSV parser, Kraken "Time & Sales" → candle aggregation, single source of truth for gap handling |
| **Backtest engine** | Event-driven, bar-by-bar replay with fees & slippage, multi-pair capital allocation, ATR risk-based sizing |
| **Validation** | Walk-forward analysis: grid search on a training window, measured on the next unseen window |
| **Strategies** | MA crossover, ATR crossover, Bollinger mean-reversion (+ volume / volatility / time-stop filters), Donchian breakout, cross-sectional momentum & mean-reversion |
| **Live** | Kraken WebSocket v2 OHLC client with exponential-backoff reconnect, REST seeding, asset-pair validation |
| **Paper trading** | Reactive decision loop, atomic JSON state snapshots, append-only JSONL trade journal, restart-safe |
| **Ops** | systemd services, VPS setup script, small status dashboard |

## Guarantees enforced by tests

Correctness matters more than returns in a backtester. These invariants are each covered by a test (27 test files):

- **No look-ahead bias** — strategies only see closed bars; reading a future bar throws.
- **No phantom fills** — synthetic (gap-filled) bars are flagged and never executed on.
- **Capital is never exceeded** — position cap + per-trade budget `min(cash, equity / N)`.
- **Corrupt or delisted data fails loudly** — line-by-line OHLC validation, universe checked against Kraken's `AssetPairs`.
- **Network drops never crash the live pipeline** — WebSocket handlers never throw.
- **Walk-forward reveals overfitting instead of hiding it.**

## Research approach

The project was built in documented phases (spec → plan → implementation → review), each with explicit exit criteria. Strategy research on 3.5 years of real data (June 2022 → Dec 2025) follows strict rules: out-of-sample measurement only, minimal degrees of freedom, and honest reporting of negative or inconclusive results.

Short version of the findings:

- **Trend following, Donchian breakout, cross-sectional momentum** → clear overfitting signature (strong in-sample, negative out-of-sample). Rejected.
- **Bollinger mean-reversion with low trading frequency** → best candidate so far: ~+0.7% per ~1-month test window, 65–68% win rate, profit factor ~2–2.7, validated with **zero degrees of freedom**. Still a candidate, not a validated edge.
- **Extra filters** (volume, volatility regime, time stop, post-hoc pair selection) → no measurable improvement, and some were shown to be *structurally unmeasurable* by the harness — documented rather than hidden.

📄 Full research log (French): [`docs/RESEARCH.fr.md`](docs/RESEARCH.fr.md) · Design specs & plans: [`docs/superpowers/`](docs/superpowers/)

## Getting started

Requires **Node.js 22.6+** (native TypeScript type-stripping, no build step).

```bash
npm install
npm run typecheck
npm test
```

Historical data (not versioned) comes from Kraken's downloadable "Time & Sales" archive:

```bash
npm run convert-trades     # raw trades → 60/240/1440-min candles in data/kraken-ohlcvt/
```

Paper trading:

```bash
npm run run-paper          # live paper-trading runner
npm run status             # portfolio & open positions
npm run dashboard          # local web dashboard
```

Deployment on a VPS with systemd: see [`deploy/`](deploy/).

## Project structure

```
src/data/        Series, gap policy, CSV loader, trade aggregation
src/strategy/    Strategy contract, indicators (O(1) per bar), strategies
src/backtest/    Events, execution, portfolio, runner, metrics, walk-forward
src/live/        Kraken WebSocket/REST, live series builder, paper runner, persistence
scripts/         Entry points: paper runner, walk-forward, tuning scripts
test/            node:test suites
deploy/          systemd units & VPS setup
```

## License

[MIT](LICENSE)
