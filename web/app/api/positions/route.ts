import { NextResponse } from 'next/server';
import { getSqlClient, CACHE_HEADERS } from '../../../lib/db';

export const revalidate = 15;

export async function GET() {
  const sql = getSqlClient();
  const positions = await sql`
    SELECT position_id, trade_id, contract_symbol, underlying, right_type,
           strike, expiration_date, dte, strategy_name, regime_at_entry, qty,
           conservative_entry_price, alpaca_entry_price, current_mark_price,
           peak_mark_price, trough_mark_price, unrealized_pnl_usd,
           unrealized_pnl_pct, delta, theta, iv_rank_pct,
           stop_loss_price, take_profit_price, trailing_stop_activation_price,
           opened_at, updated_at
    FROM positions
    ORDER BY opened_at DESC
  `;
  return NextResponse.json({ positions }, { headers: CACHE_HEADERS });
}
