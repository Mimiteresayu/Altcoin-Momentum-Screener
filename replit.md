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