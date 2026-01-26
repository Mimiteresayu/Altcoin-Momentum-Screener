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
- **Market Phase Detection**: Identifies ACCUMULATION, DISTRIBUTION, BREAKOUT, and EXHAUST phases.
- **Signal Direction**: Determines LONG/SHORT bias using multi-factor scoring (Price Trend, RSI, Volume, OI, Market Structure).
- **Discord Notifications**: Sends formatted embed messages for key signals.
- **Real-Time Comments**: WebSocket-based live comments with persistence to PostgreSQL.
- **Autotrade System**: Integration with Bitunix Futures for automated trading with configurable risk management, trade filters, and safety features.
- **Backtest Engine**: Optimizes entry/exit strategies for Sharpe Ratio (target >= 2.5), using advanced filters and momentum-based take-profit strategies.

## External Dependencies

### Third-Party APIs
- **Bitunix Futures API**: Primary data source for real-time cryptocurrency ticker data.
- **OKX API**: Provides market enrichment data such as funding rates, klines, and L/S ratios.
- **Coinalyze API**: Used for Open Interest data (requires API key).
- **Coinglass API (v4)**: Provides extensive enhanced market data, including funding rates, accumulation/distribution scores, and momentum strength classification (requires API key).

### Database
- **PostgreSQL**: Used for persistent storage, including session data, watchlist items, autotrade configurations, trades, and comments.

### Key NPM Packages
- `axios`: HTTP client.
- `drizzle-orm` / `drizzle-kit`: ORM and migration tools.
- `zod`: Runtime schema validation.
- `@tanstack/react-query`: Server state management.
- `framer-motion`: Animation library.
- `shadcn/ui`: UI component library.