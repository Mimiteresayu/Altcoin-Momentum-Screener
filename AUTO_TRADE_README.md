# Fire Dog × Yuth Confluence Auto-Trade

Branch: `feat/fire-dog-yuth-confluence-bitunix-pionex`

## What this branch adds

| Module | Purpose |
|---|---|
| `server/scrapers/firedog.ts` | Login + cookie session + 15-min HTML scrape of Fire Dog screener |
| `server/exchanges/pionex.ts` | Pionex REST adapter (HMAC-SHA256), paper-mode aware |
| `server/exchanges/binance-spot.ts` | Binance Spot for RUNNER hold (VPN-required) |
| `server/qimen/sidecar.py` + `sidecar.ts` | Qimen scoring service, neutral fallback if offline |
| `server/confluence/score.ts` | 5-signal confluence: Fire Dog (gate) + FUEL + Daily + SMC + Qimen |
| `server/risk/planner.ts` | 4-child RR ladder (1.5/2/4/8), 1% parent risk |
| `server/risk/kill-switch.ts` | -3% daily DD, max concurrent, manual clear |
| `server/execution/spread-check.ts` | Reject illiquid: spread > 30bps or depth < $20k |
| `server/execution/maker-first.ts` | Limit-first, IOC market fallback (saves 0.04%/leg) |
| `server/confluence/orchestrator.ts` | Top-level pipeline runner |
| `client/src/components/trading-cards/*` | Dashboard cards (confluence, kill-state, child trades) |

## Architecture flow

```
Fire Dog snapshot (15min)
  └─ short_score >= 80 ──→ universe filter
       └─ FUEL + Daily + SMC + Qimen scores
            └─ Confluence total (0..100)
                 ├─ < 60 → reject
                 └─ ≥ 60 → spread/depth gate
                       └─ entry/stop/RR build
                            └─ Maker-first execute
                                 ├─ Bitunix (live primary, paper default)
                                 ├─ Pionex (mirror to demo for validation)
                                 └─ Binance Spot (RUNNER hold post-TP)
```

## How to run locally

```bash
# 1. Install deps (already in package.json)
npm install

# 2. Copy env
cp .env.example .env
#   Edit .env — set BITUNIX_*, PIONEX_*, FIREDOG_*, leave TRADING_ENABLED=false

# 3. Run Qimen sidecar in separate terminal
python server/qimen/sidecar.py

# 4. Run app
npm run dev
```

## How to deploy on Railway

1. **Enable Static Outbound IP** (Pro plan) — Settings → Networking → Toggle Static IPs
2. Copy the assigned IPv4
3. Pionex → API Management → recreate key with that IP whitelisted (no withdrawal)
4. Bitunix → API Management → recreate key with that IP whitelisted (no withdrawal)
5. Railway → Service → Variables — paste all keys from `.env.example`
6. Leave `TRADING_ENABLED=false`, `*_PAPER_MODE=true` for first month
7. Deploy. Watch the dashboard cards — `/api/confluence/latest` should populate within 15 min.

## Going live (after 1 month paper validation)

After paper P&L stabilizes and you trust the signals:

```bash
# Set in Railway:
TRADING_ENABLED=true
BITUNIX_PAPER_MODE=false   # only Bitunix; keep Pionex paper
KILL_SWITCH=false
```

## Default risk profile

| Param | Default | Notes |
|---|---|---|
| Parent risk | 1% equity | Yuth's standard |
| Children | 4 (1.5/2/4/8 RR) | SCALPER bumped from 1.2 to cover fees |
| Risk split | 30/30/25/15 % | |
| Leverage cap | 10x | Yuth used 20x; we halve for v1 |
| Daily DD kill | 3% | Auto-set, manual clear |
| Max concurrent | 10 | |
| Spread max | 30 bps | |
| Depth min | $20k | top-5 levels |
| Maker-first timeout | 8s | |

## Known caveats

- **Pionex Oct 10 2025**: app freeze during BTC crash, mark-price diverged from global. Keep Pionex demo only for 1+ month.
- **Bitunix small-cap depth**: less liquid than Binance on 妖币. Spread gate handles this.
- **Qimen has no academic backing**: weighted only 15%, never a veto.
- **Fire Dog scraper**: parser uses tolerant regex; if scoring breaks, dashboard will show stale flag for 30 min before alert.

## Files NOT changed

This branch leaves intact: `binance.ts`, `okx.ts`, `bitunix-trade.ts`, `autotrade.ts`,
`coil-signal.ts`, `coinglass*.ts`, `ml/`, backtest engines. New code lives in
`server/{exchanges,scrapers,qimen,confluence,risk,execution}/`.

## To wire into existing autotrade.ts

The orchestrator expects these bridges (`OrchestratorContext`):

```ts
import { runOrchestrator } from "./confluence/orchestrator";
import { getFuelScoreFromExistingScreener } from "./screener-enrichment";
// ...

setInterval(async () => {
  await runOrchestrator({
    getFuelScore: getFuelScoreFromExistingScreener,
    getDailyScore: getDailyScoreFromExistingLogic,
    getSmcScore: getSmcScoreFromExistingSmc,
    getEquityUsd: () => getBitunixEquity(),
    buildEntryStop: buildEntryStopFromCandles,
    executeTrade: async ({ plan, confluence, liquidity }) => {
      // route children: SCALPER+SNIPER+SWING -> Bitunix perp
      //                 RUNNER -> Bitunix perp; on TP -> Binance Spot hold
      // mirror entire plan to Pionex paper
    },
  });
}, 15 * 60 * 1000);
```
