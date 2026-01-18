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
- Requires COINGLASS_API_KEY secret for enhanced endpoints
- Rate limit: 80 requests/minute with token bucket algorithm
- 1-minute in-memory cache to reduce redundant API calls
- **Endpoints**:
  - `GET /api/enhanced-scan` - Top 10 altcoins with full Coinglass enrichment (liquidation maps, orderbook walls, long/short ratios, taker flow, funding rates, fear/greed index)
  - `GET /api/enhanced-market/:symbol` - Full EnhancedMarketData for a specific symbol with all metrics
  - `GET /api/market-signals/:symbol` - Interpreted trading signals (accumulation vs distribution, breakout setups, squeeze setups)
  - `GET /api/signal-analysis/:symbol` - Detailed multi-factor trading analysis with signal interpretations and setup identification
  - `GET /api/coinglass/:symbol` - Quick lookup for basic Coinglass data (OI history, liquidation map, L/S ratio, funding rates)
  - `GET /api/screen` - Top coins by volume with optional Coinglass data (OI change, L/S ratio, liquidation max pain, funding rate)
- **Data provided**: Liquidation analysis, orderbook support/resistance walls, positioning analysis, flow analysis, funding/basis analysis, accumulation/distribution scores, momentum strength classification
- **Market signals include**: Accumulation/distribution detection, long/short squeeze setups, breakout/breakdown patterns, liquidation risk alerts, funding rate signals, fear/greed contrarian signals

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

## API Limitations
- **Bitunix**: No public API for programmatic alarm/alert creation. Users must set alerts via Bitunix web/mobile UI or TradingView webhook integration.