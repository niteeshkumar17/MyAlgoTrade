import { NextResponse } from 'next/server';
import { getSqlClient, CACHE_HEADERS } from '../../../lib/db';

export const revalidate = 15;

export async function GET() {
  const sql = getSqlClient();
  const [trades, skippedSignals] = await Promise.all([
    sql`
      SELECT t.*, pm.diagnosis_notes, pm.underlying_return_pct, pm.iv_change_pct
      FROM trades t
      LEFT JOIN post_mortems pm ON pm.trade_id = t.trade_id
      ORDER BY t.closed_at DESC
      LIMIT 250
    `,
    sql`
      SELECT signal_id, generated_at, underlying, strategy_name, direction,
             regime, confidence, quality_gate_prob, action_taken, skip_reason,
             reason_summary, counterfactual_contract, counterfactual_entry_price,
             counterfactual_exit_price, counterfactual_pnl_pct
      FROM signals
      WHERE action_taken = 'SKIPPED'
      ORDER BY generated_at DESC
      LIMIT 100
    `,
  ]);
  return NextResponse.json({ trades, skippedSignals }, { headers: CACHE_HEADERS });
}
