import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;
let dbAvailable = false;
let connectionError: string | null = null;

function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    connectionError = "DATABASE_URL not set";
    console.warn("[DB] DATABASE_URL not set - running without database");
    return;
  }

  try {
    pool = new Pool({ 
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      max: 10,
    });

    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
      dbAvailable = false;
      connectionError = err.message;
    });

    db = drizzle(pool, { schema });
    
    pool.query('SELECT 1')
      .then(() => {
        dbAvailable = true;
        connectionError = null;
        console.log('[DB] Database connection established');
      })
      .catch((err) => {
        dbAvailable = false;
        connectionError = err.message;
        console.warn('[DB] Database connection failed:', err.message);
      });

  } catch (err: any) {
    connectionError = err.message;
    console.warn('[DB] Database initialization failed:', err.message);
  }
}

initializeDatabase();

export function isDatabaseAvailable(): boolean {
  return dbAvailable && db !== null;
}

export function getConnectionError(): string | null {
  return connectionError;
}

export async function checkDatabaseConnection(): Promise<boolean> {
  if (!pool) return false;
  
  try {
    await pool.query('SELECT 1');
    dbAvailable = true;
    connectionError = null;
    return true;
  } catch (err: any) {
    dbAvailable = false;
    connectionError = err.message;
    return false;
  }
}

export { pool, db };
