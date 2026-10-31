import { NextResponse } from 'next/server';
import { getSqlClient, CACHE_HEADERS } from '../../../lib/db';

export const revalidate = 20;

export async function GET() {
  const sql = getSqlClient();
  const [models, learningLog, configHistory] = await Promise.all([
    sql`SELECT * FROM model_versions ORDER BY trained_at DESC LIMIT 5`,
    sql`SELECT * FROM learning_log ORDER BY logged_at DESC LIMIT 50`,
    sql`SELECT * FROM config_history ORDER BY applied_at DESC LIMIT 10`,
  ]);
  return NextResponse.json({ models, learningLog, configHistory }, { headers: CACHE_HEADERS });
}
