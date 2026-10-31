import { NextResponse } from 'next/server';
import { getSqlClient, CACHE_HEADERS } from '../../../lib/db';

export const revalidate = 20;

export async function GET() {
  const sql = getSqlClient();
  const [byStrategy, byUnderlying, byRegime, byDte] = await Promise.all([
    sql`
      SELECT strategy_name AS key,
             COUNT(*)::int AS trade_count,
             AVG(CASE WHEN conservative_pnl_usd > 0 THEN 1.0 ELSE 0.0 END)::float AS win_rate,
             AVG(conservative_pnl_usd)::float AS expectancy_usd,
             SUM(conservative_pnl_usd)::float AS net_pnl_usd
      FROM trades
      WHERE is_shadow_challenger = FALSE
      GROUP BY strategy_name
    `,
    sql`
      SELECT underlying AS key,
             COUNT(*)::int AS trade_count,
             AVG(CASE WHEN conservative_pnl_usd > 0 THEN 1.0 ELSE 0.0 END)::float AS win_rate,
             SUM(conservative_pnl_usd)::float AS net_pnl_usd
      FROM trades
      WHERE is_shadow_challenger = FALSE
      GROUP BY underlying
      ORDER BY net_pnl_usd DESC
    `,
    sql`
      SELECT regime_at_entry AS key,
             COUNT(*)::int AS trade_count,
             AVG(CASE WHEN conservative_pnl_usd > 0 THEN 1.0 ELSE 0.0 END)::float AS win_rate,
             SUM(conservative_pnl_usd)::float AS net_pnl_usd
      FROM trades
      WHERE is_shadow_challenger = FALSE
      GROUP BY regime_at_entry
    `,
    sql`
      SELECT CASE
               WHEN dte_at_entry < 21 THEN '14-20 DTE'
               WHEN dte_at_entry <= 32 THEN '21-32 DTE'
               ELSE '33-45 DTE'
             END AS key,
             COUNT(*)::int AS trade_count,
             AVG(CASE WHEN conservative_pnl_usd > 0 THEN 1.0 ELSE 0.0 END)::float AS win_rate,
             SUM(conservative_pnl_usd)::float AS net_pnl_usd
      FROM trades
      WHERE is_shadow_challenger = FALSE
      GROUP BY 1
    `,
  ]);

  return NextResponse.json(
    { byStrategy, byUnderlying, byRegime, byDte },
    { headers: CACHE_HEADERS }
  );
}
