import { z } from 'zod';
import { insertWatchlistItemSchema, watchlistItems, tickerSchema } from './schema';

// ============================================
// SHARED ERROR SCHEMAS
// ============================================
export const errorSchemas = {
  validation: z.object({
    message: z.string(),
    field: z.string().optional(),
  }),
  notFound: z.object({
    message: z.string(),
  }),
  internal: z.object({
    message: z.string(),
  }),
};

// ============================================
// API CONTRACT
// ============================================
export const api = {
  tickers: {
    list: {
      method: 'GET' as const,
      path: '/api/tickers',
      responses: {
        200: z.array(tickerSchema),
        500: errorSchemas.internal,
      },
    },
  },
  watchlist: {
    list: {
      method: 'GET' as const,
      path: '/api/watchlist',
      responses: {
        200: z.array(z.custom<typeof watchlistItems.$inferSelect>()),
      },
    },
    create: {
      method: 'POST' as const,
      path: '/api/watchlist',
      input: insertWatchlistItemSchema,
      responses: {
        201: z.custom<typeof watchlistItems.$inferSelect>(),
        400: errorSchemas.validation,
      },
    },
    delete: {
      method: 'DELETE' as const,
      path: '/api/watchlist/:id',
      responses: {
        204: z.void(),
        404: errorSchemas.notFound,
      },
    },
  },
};

// ============================================
// REQUIRED: buildUrl helper
// ============================================
export function buildUrl(path: string, params?: Record<string, string | number>): string {
  let url = path;
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (url.includes(`:${key}`)) {
        url = url.replace(`:${key}`, String(value));
      }
    });
  }
  return url;
}

// ============================================
// TYPE HELPERS
// ============================================
export type TickerListResponse = z.infer<typeof api.tickers.list.responses[200]>;
export type WatchlistInput = z.infer<typeof api.watchlist.create.input>;
