# Signal Scanner - Pre-Spike Detection Dashboard

## Overview
This project is a cryptocurrency trading signal scanner designed to detect potential pre-spike opportunities in the Bitunix futures market. It fetches real-time ticker data, applies sophisticated filtering criteria (price change, volume spike, RSI analysis), and generates actionable trading signals. Each signal includes calculated entry/exit points, stop-loss, take-profit levels, and risk-reward ratios. The application aims to provide traders with a powerful tool for identifying high-probability setups before significant price movements. The system incorporates backtesting capabilities to optimize entry and exit strategies and integrate with external market data providers for enhanced signal generation and risk management.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query for server state with 5-second auto-refresh
- **Styling**: Tailwind CSS with a custom financial terminal dark theme
- **UI Components**: shadcn/ui component library
- **Animations**: Framer Motion
- **Build Tool**: Vite

### Backend
- **Runtime**: Node.js with Express
- **Language**: TypeScript (ESM modules)
- **API Pattern**: REST endpoints under `/api/`
- **Signal Processing**: Server-side calculation of trading signals, including pre-spike scoring (PSCORE) and market phase detection.

### Data Layer
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema**: Shared between frontend and backend (`shared/schema.ts`)
- **Migrations**: Drizzle Kit
- **Type Safety**: Zod schemas generated from Drizzle tables

### API Contract Design
- **Shared Types**: `shared/routes.ts` defines API contracts with Zod for validation.
- **Key Endpoints**:
    - `GET /api/tickers`: Processed trading signals
    - `GET /api/screen`: Enhanced screener with Coinglass enrichment
    - `GET /api/watchlist`, `POST /api/watchlist`, `DELETE /api/watchlist/:id`: Watchlist management
    - Autotrade, backtest, and comment related endpoints

### Build System
- **Development**: `tsx` for TypeScript execution with hot reload.
- **Production Build**: Custom script using esbuild for server and Vite for client.

### Core Features
- **Unified Symbol Universe**: Intelligent selection of symbols based on major pairs, watchlist, top volume, and high movers.
- **Signal Type Filters**: Categorization of signals into HOT, ACTIVE, and PRE based on price and volume criteria.
- **HTF Bias**: Utilizes Supertrend and Funding Rate for determining LONG/SHORT bias and confidence levels.
- **Enhanced Screener**: Incorporates fields like priceLocation, marketPhase, preSpikeScore, fundingRate, longShortRatio, FVG/OB levels, liquidation zones, and AI-generated storytelling.
- **PSCORE Calculation**: A composite score (0-5) based on volume spike, acceleration, OI change, RSI, risk/reward, and signal strength.
- **Market Phase Detection**: 5-phase system (ACCUMULATION, BREAKOUT, DISTRIBUTION, TREND, EXHAUST) based on SMC + Order Flow analysis.
- **Entry Model Recommendations**: Actionable entry suggestions based on phase and candlestick patterns (BUY DIP, BOS ENTRY, FVG ENTRY, PULLBACK, TAKE PROFIT, etc.).
- **Signal Direction**: Determines LONG/SHORT bias using multi-factor scoring (Price Trend, RSI, Volume, OI, Market Structure).
- **Discord Notifications**: Sends formatted embed messages for key signals.
- **Real-Time Comments**: WebSocket-based live comments with persistence to PostgreSQL.
- **Autotrade System**: Integration with Bitunix Futures for automated trading with configurable risk management, trade filters, and safety features.
- **Backtest Engine**: Optimizes entry/exit strategies for Sharpe Ratio (target >= 2.5), using advanced filters and momentum-based take-profit strategies.
- **Continuous Paper Trading**: Automated paper trading bot that runs every 5 minutes, monitoring screener signals for BREAKOUT phase or PSCORE >= 1.5, opening/closing virtual trades, and tracking performance in real-time.

### Timeframe Configuration
- **BIAS**: 4H (Supertrend ATR=14, Multiplier=3.5 for trend direction)
- **PHASE**: 4H (Market phase detection using volume, RSI, price structure)
- **ENTRY**: 4H (Entry timing and candlestick analysis)
- **POC (Point of Control)**: 24H Volume Profile for key support/resistance
- **HTF (Higher Timeframe)**: 4H/1D/1W for multi-timeframe confirmation

### Backtest Entry Models
- **BREAKOUT + BOS ENTRY**: Enter long on break of structure (price > previous high), confirmed by Supertrend
- **ACCUMULATION + SCALE IN**: Enter on dip to EMA 21 support zone
- **TREND + PULLBACK**: Enter on pullback to EMA 21 with trend confirmation
- **Stop Loss**: At Supertrend level or 2% below entry (whichever is tighter)
- **Take Profit**: 1:2 Risk:Reward ratio

## External Dependencies

### Third-Party APIs
- **Bitunix Futures API**: Primary data source for real-time cryptocurrency ticker data and symbol list. All symbols shown in the screener come directly from Bitunix's futures market.
- **OKX API**: Primary enrichment source for funding rates, klines (4H/1H), and Long/Short ratios. Used for candlestick analysis and HTF bias calculation.
- **Binance Futures API**: Fallback for Open Interest data when OKX is unavailable.
- **Coinalyze API**: Used for Open Interest data (requires API key).
- **Coinglass API (v4)**: Fallback enrichment source for funding rates, accumulation/distribution scores, and momentum strength classification (requires API key).

**Note**: All symbols displayed in Classic and Enhanced views come from Bitunix Futures. If a symbol appears in the screener, it is available for trading on Bitunix.

### Database
- **PostgreSQL**: Used for persistent storage, including session data, watchlist items, autotrade configurations, trades, and comments.

### Key NPM Packages
- `axios`: HTTP client.
- `drizzle-orm` / `drizzle-kit`: ORM and migration tools.
- `zod`: Runtime schema validation.
- `@tanstack/react-query`: Server state management.
- `framer-motion`: Animation library.
- `shadcn/ui`: UI component library.