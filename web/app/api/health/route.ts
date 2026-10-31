import { NextResponse } from 'next/server';
import { getSqlClient, CACHE_HEADERS } from '../../../lib/db';

export const revalidate = 10;

export async function GET() {
  const sql = getSqlClient();
  const [healthRows, controlRows] = await Promise.all([
    sql`SELECT * FROM bot_health ORDER BY heartbeat_at DESC LIMIT 1`,
    sql`SELECT * FROM control WHERE id = 1`,
  ]);

  const health = healthRows[0] ?? null;
  let isOffline = true;
  let heartbeatAgeMinutes = 999;

  if (health?.heartbeat_at) {
    const hbMs = new Date(health.heartbeat_at).getTime();
    heartbeatAgeMinutes = Math.round(((Date.now() - hbMs) / 60000) * 10) / 10;
    // Offline rule: if heartbeat is older than 10 minutes during market hours, show red BOT OFFLINE banner
    isOffline = Boolean(health.market_open && heartbeatAgeMinutes > 10);
  }

  return NextResponse.json(
    {
      health,
      control: controlRows[0] ?? null,
      heartbeatAgeMinutes,
      isOffline,
    },
    { headers: CACHE_HEADERS }
  );
}
