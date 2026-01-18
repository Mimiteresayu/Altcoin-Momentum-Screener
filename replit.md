# Signal Scanner - Pre-Spike Detection Dashboard

## Overview

This is a cryptocurrency trading signal scanner that detects potential pre-spike opportunities from Bitunix futures market data. The application fetches real-time ticker data, applies filtering criteria (price change between -5% to +15%, volume spike detection, RSI analysis), and presents actionable trading signals with entry/exit points, stop-loss, take-profit levels, and risk-reward ratios.

The stack follows a monorepo structure with a React frontend, Express backend, and PostgreSQL database using Drizzle ORM.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter (lightweight alternative to React Router)
- **State Management**: TanStack React Query for server state with 5-second auto-refresh for real-time feel
- **Styling**: Tailwind CSS with custom financial terminal dark theme
- **UI Components**: shadcn/ui component library (Radix primitives with custom styling)
- **Animations**: Framer Motion for smooth table transitions
- **Build Tool**: Vite with path aliases (`@/` for client source, `@shared/` for shared types)

### Backend Architecture
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **API Pattern**: REST endpoints under `/api/` prefix
- **External Data**: Fetches from Bitunix futures API (`https://fapi.bitunix.com/api/v1/futures/market/tickers`)
- **Signal Processing**: Server-side calculation of trading signals with filtering criteria applied

### Data Layer
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema Location**: `shared/schema.ts` (shared between frontend and backend)
- **Migrations**: Drizzle Kit with migrations output to `./migrations`
- **Type Safety**: Zod schemas generated from Drizzle tables using `drizzle-zod`

### API Contract Design
- **Shared Types**: `shared/routes.ts` defines API contracts with Zod schemas for request/response validation
- **Endpoints**:
  - `GET /api/tickers` - Returns processed trading signals
  - `GET /api/watchlist` - Returns user's watchlist items
  - `POST /api/watchlist` - Adds symbol to watchlist
  - `DELETE /api/watchlist/:id` - Removes from watchlist

### Build System
- **Development**: `tsx` for TypeScript execution with hot reload
- **Production Build**: Custom script (`script/build.ts`) using esbuild for server and Vite for client
- **Output**: Server bundled to `dist/index.cjs`, client to `dist/public`

## External Dependencies

### Third-Party APIs
- **Bitunix Futures API**: Primary data source for cryptocurrency ticker data (no authentication required for public endpoints)

### Database
- **PostgreSQL**: Required via `DATABASE_URL` environment variable
- **Session Storage**: `connect-pg-simple` available for session persistence

### Key NPM Packages
- `axios` - HTTP client for Bitunix API calls
- `drizzle-orm` / `drizzle-kit` - Database ORM and migration tooling
- `zod` - Runtime schema validation for API contracts
- `@tanstack/react-query` - Server state management with caching
- `framer-motion` - Animation library for UI transitions
- Full shadcn/ui component set via Radix primitives

## Backtest System

### Entry Filters (Optimized for Sharpe ≥2.5)
- **Volume Spike**: ≥8x required for entry
- **Volume Acceleration**: ≥3x required (skip if data unavailable)
- **Open Interest Change**: ≥15% required (if available from Coinalyze API)
- **RSI Range**: 45-70 (neutral-bullish momentum)
- **Risk/Reward**: ≥2:1 minimum
- **Signal Strength**: ≥4/5

### Stop Loss Strategy
- **Primary**: 5-minute swing low with 0.5% buffer below
- **Fallback**: 5% below entry if swing low unavailable
- **Breakeven**: Moves to entry price after 0.5R profit
- **Trailing**: 1.5% trailing distance when in profit

### Take Profit Strategy (Momentum Trailing)
- Replaces fixed TP1/TP2/TP3 with momentum-based exits
- **Exit triggers**:
  - Volume drops below 2x (momentum fading)
  - Price drops 3% from peak (momentum reversal)
- Closes entire remaining position when momentum fades

### Coinalyze Integration
- Open Interest data from Coinalyze API (requires COINALYZE_API_KEY secret)
- Rate limit: 40 requests/minute with automatic backoff and retry
- Fetches OI for up to 40 symbols per update cycle (prioritizes signal candidates)
- Symbols without Coinalyze coverage show "N/A" in UI (common for newer/smaller tokens)

### Coinglass Integration (Enhanced Market Data)
- **API Version**: v4 (https://open-api-v4.coinglass.com)
- **Authentication**: CG-API-KEY header with COINGLASS_API_KEY secret
- Rate limit: 80 requests/minute with token bucket algorithm
- 1-minute in-memory cache to reduce redundant API calls
- **Endpoints**:
  - `GET /api/enhanced-scan` - Top 10 altcoins with Coinglass enrichment
  - `GET /api/enhanced-market/:symbol` - Full EnhancedMarketData for a specific symbol
  - `GET /api/market-signals/:symbol` - Interpreted trading signals
  - `GET /api/signal-analysis/:symbol` - Detailed multi-factor trading analysis
  - `GET /api/coinglass/:symbol` - Quick lookup for Coinglass data
  - `GET /api/screen` - Top coins by volume with optional Coinglass data
- **Working with current plan (Hobbyist)**:
  - Funding Rate (exchange-list): Returns comprehensive funding rates across all exchanges
  - Fear & Greed Index: Available but may require data format adjustments
- **Requires Professional Plan**:
  - Liquidation Map (aggregated-map)
  - Orderbook Walls (large-limit-order)
  - Long/Short Ratio (global-long-short-account-ratio/history)
  - Taker Buy/Sell Volume (taker-buy-sell-volume/history)
  - Futures Basis (basis/history)
- **Data provided**: Funding rate analysis, accumulation/distribution scores, momentum strength classification
- **Market signals include**: Funding rate signals, accumulation/distribution detection based on available data

## Signal Direction (LONG/SHORT)
Each signal displays a SIDE indicator (LONG or SHORT) based on multi-factor scoring:
- **Price Trend** (weight 3): Primary direction indicator
- **RSI Momentum** (weight 2): Confirms trend, not contra-trades
- **Volume** (weight 2): High volume confirms price direction
- **Open Interest** (weight 2): Rising OI + price direction = position building
- **Market Structure** (weight 1 each): FVG and Order Block types
Decision: SHORT when bearish score > bullish score, otherwise LONG

## Discord Notifications
- Sends formatted embed messages for HOT/MAJOR/ACTIVE signals
- Requires DISCORD_WEBHOOK_URL secret configuration
- Rate limiting: 1 second between messages
- Deduplication: 30-minute cooldown per symbol (in-memory, resets on restart)

## Real-Time Comments (WebSocket)
- WebSocket server at `/ws` path for live updates
- Comments persisted to PostgreSQL database
- XSS protection: All input sanitized (HTML entities escaped)
- REST API fallback: `GET/POST /api/comments`
- Fields: author (50 chars), content (500 chars), optional symbol

## Autotrade System (Bitunix Futures)
- **Exchange**: Bitunix Futures (USDM Perpetual)
- **Authentication**: Requires BITUNIX_API_KEY and BITUNIX_SECRET_KEY secrets
- **API Documentation**: https://openapidoc.bitunix.com/
- **Files**: `server/bitunix-trade.ts` (API service), `server/autotrade.ts` (trade engine)
- **Database Tables**: `autotrade_settings`, `autotrade_trades`
- **Signature**: Double SHA-256 (nonce + timestamp + apiKey + body → SHA256 → + secretKey → SHA256)

### Autotrade API Endpoints
- `GET /api/autotrade/status` - Full status (config, stats, positions)
- `GET /api/autotrade/config` - Current configuration
- `POST /api/autotrade/config` - Update configuration
- `POST /api/autotrade/enable` - Enable autotrade
- `POST /api/autotrade/disable` - Disable autotrade
- `GET /api/autotrade/trades` - Trade history
- `GET /api/autotrade/positions` - Open positions from Bitunix
- `POST /api/autotrade/close/:symbol` - Close specific position
- `POST /api/autotrade/emergency-close` - Close ALL positions and disable
- `GET /api/autotrade/account` - Bitunix account info

### Risk Management
- **Max Positions**: Configurable (default: 3)
- **Risk per Trade**: % of account (default: 1%)
- **Leverage**: Configurable (default: 5x)
- **Margin Type**: Isolated (for position safety)
- **Stop-Loss**: Configurable % (default: 2%)
- **Take-Profit**: Configurable % (default: 6%)
- **Trailing Stop**: Configurable % (default: 1.5%)

### Trade Filters
- **Signal Strength**: Minimum required (default: 4/5)
- **Only HOT Signals**: Optional filter (default: true)
- **Blocked Symbols**: BTC/ETH excluded by default
- **Allowed Symbols**: Optional whitelist

### Safety Features
- Emergency close all positions button
- Autotrade disabled on emergency close
- Position sync with Bitunix
- Trade history logging
- Quantity precision normalized to 3 decimal places for Bitunix step size compliance

### Known Limitations
- **Protective Orders**: Stop-loss and take-profit are tracked in database but not placed as conditional orders on Bitunix (requires manual monitoring or future implementation of Bitunix conditional order endpoints)
- Users should monitor positions and set alerts via Bitunix web/mobile UI for additional protection

## Backtest Engine (Sharpe Ratio Optimization)
- **Target**: Sharpe Ratio >= 2.5
- **File**: `server/backtest-engine.ts`
- **Initial Capital**: $10,000 default

### Backtest Entry Filters (Optimized)
- **Signal Strength**: >= 4/5 (configurable)
- **Volume Spike**: >= 8x required
- **Volume Acceleration**: >= 3x required
- **Open Interest Change**: >= 15% (if available)
- **RSI Range**: 45-70 (neutral-bullish)
- **Risk/Reward**: >= 2:1 minimum

### Backtest Exit Strategy
- **TP1**: 3% (close 30% position)
- **TP2**: 6% (close 30% position)
- **TP3**: 10% (close remaining 40%)
- **Stop Loss**: 5% below entry (configurable)
- **Breakeven**: Moves SL to entry after 0.5R profit
- **Trailing Stop**: 1.5% trailing distance when in profit

### Backtest API Endpoints
- `GET /api/backtest-engine/config` - Current configuration
- `POST /api/backtest-engine/config` - Update configuration
- `POST /api/backtest-engine/reset` - Reset backtest state
- `POST /api/backtest-engine/signal` - Process a signal
- `POST /api/backtest-engine/update-trade` - Update trade with new price
- `GET /api/backtest-engine/metrics` - Performance metrics
- `GET /api/backtest-engine/trades` - All trades (active/closed)
- `GET /api/backtest-engine/equity-curve` - Equity curve data
- `GET /api/backtest-engine/report` - Full performance report
- `POST /api/backtest-engine/save` - Save results to database

### Performance Metrics Calculated
- Sharpe Ratio (annualized, target >= 2.5)
- Sortino Ratio (downside deviation only)
- Calmar Ratio (return / max drawdown)
- Win Rate, Profit Factor, Expectancy
- Max Drawdown ($ and %)
- Average R-Multiple per trade

## API Limitations
- **Bitunix**: No public API for programmatic alarm/alert creation. Users must set alerts via Bitunix web/mobile UI or TradingView webhook integration.