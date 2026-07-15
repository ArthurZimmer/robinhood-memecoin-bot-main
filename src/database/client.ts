import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { env } from '../config/env.js'
import { createChildLogger } from '../utils/logger.js'
import * as schema from './schema.js'

const log = createChildLogger('database')

// ── Connection pool ───────────────────────────────────────────────────────────

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 20,                // max connections in pool
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
})

pool.on('error', (err) => {
  log.error({ err }, 'PostgreSQL pool idle client error')
})

pool.on('connect', () => {
  log.debug('New PostgreSQL client connected')
})

// ── Drizzle instance ──────────────────────────────────────────────────────────

export const db = drizzle(pool, {
  schema,
  logger: {
    logQuery(query: string, params: unknown[]) {
      // Use trace level to avoid flooding debug logs — set LOG_LEVEL=trace to see SQL
      log.trace({ query, params }, 'DB query')
    },
  },
})

// ── Healthcheck ───────────────────────────────────────────────────────────────

export async function checkDatabaseConnection(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT 1')
    log.info({ host: pool.options.host ?? 'localhost' }, 'PostgreSQL connection verified')
  } finally {
    client.release()
  }
}

export async function closeDatabasePool(): Promise<void> {
  await pool.end()
  log.info('PostgreSQL pool closed')
}
