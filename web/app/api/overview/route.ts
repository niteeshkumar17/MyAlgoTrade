import { NextResponse } from 'next/server';
import { getSqlClient, CACHE_HEADERS } from '../../../lib/db';

export const revalidate = 15;

export async function GET() {
  const sql = getSqlClient();
  const [equitySeries, healthRows, controlRows] = await Promise.all([
    sql`
      SELECT snapshot_id, recorded_at, conservative_equity_usd, alpaca_equity_usd,
             spy_benchmark_equity_usd, realized_pnl_usd, unrealized_pnl_usd,
             drawdown_pct, open_positions_count
      FROM equity_snapshots
      ORDER BY recorded_at ASC
      LIMIT 300
    `,
    sql`SELECT * FROM bot_health ORDER BY heartbeat_at DESC LIMIT 1`,
    sql`SELECT * FROM control WHERE id = 1`,
  ]);

  return NextResponse.json(
    {
      equitySeries,
      health: healthRows[0] ?? null,
      control: controlRows[0] ?? null,
    },
    { headers: CACHE_HEADERS }
  );
}
