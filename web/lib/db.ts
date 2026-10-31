import { neon } from '@neondatabase/serverless';

/**
 * Pooled serverless Postgres client using the strictly read-only `web_ro` role.
 * The `web_ro` role has SELECT on bot tables and UPDATE on `control` (id=1) ONLY.
 * It is physically impossible for this connection to place, modify, or cancel orders.
 */
export function getSqlClient() {
  const connectionString = process.env.DATABASE_URL_WEB_RO;
  if (!connectionString) {
    throw new Error('DATABASE_URL_WEB_RO environment variable is not configured.');
  }
  return neon(connectionString);
}

export const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=30',
};
