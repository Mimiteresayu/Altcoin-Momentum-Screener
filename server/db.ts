import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

const { Pool } = pg;

let pool: pg.Pool | null = null;
let db: NodePgDatabase<typeof schema> | null = null;
let dbAvailable = false;
let connectionError: string | null = null;
let initializationComplete = false;

async function initializeDatabase(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    connectionError = "DATABASE_URL not set";
    console.warn("[DB] DATABASE_URL not set - running without database");
    initializationComplete = true;
    return;
  }

  try {
    pool = new Pool({ 
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      max: 10,
    });

    pool.on('error', (err) => {
      console.error('[DB] Pool error:', err.message);
      dbAvailable = false;
      connectionError = err.message;
    });

    db = drizzle(pool, { schema });
    
    // Test connection with timeout
    const connectionPromise = pool.query('SELECT 1');
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Connection timeout - database may be frozen or unavailable')), 5000)
    );
    
    await Promise.race([connectionPromise, timeoutPromise]);
    dbAvailable = true;
    connectionError = null;
    console.log('[DB] Database connection established');

  } catch (err: any) {
    dbAvailable = false;
    connectionError = err.message;
    console.warn('[DB] Database connection failed:', err.message);
    console.warn('[DB] App will continue with memory storage fallback');
    
    // Clean up failed pool
    if (pool) {
      try {
        await pool.end();
      } catch (e) {
        // Ignore cleanup errors
      }
      pool = null;
      db = null;
    }
  } finally {
    initializationComplete = true;
  }
}

// Start initialization but don't block module loading
initializeDatabase().catch(err => {
  console.error('[DB] Unexpected initialization error:', err);
  initializationComplete = true;
});

export function isDatabaseAvailable(): boolean {
  return dbAvailable && db !== null && pool !== null;
}

export function isInitializationComplete(): boolean {
  return initializationComplete;
}

export async function waitForInitialization(timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (!initializationComplete && (Date.now() - start) < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return initializationComplete;
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
