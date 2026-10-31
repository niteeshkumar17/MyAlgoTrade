import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSqlClient } from '../../../lib/db';

/**
 * HARD ARCHITECTURAL CONSTRAINT:
 * The website CANNOT place, modify, or cancel orders.
 * The ONLY write action permitted to the `web_ro` database role is toggling
 * `control.new_entries_enabled` on row id=1, gated by CONTROL_PAUSE_SECRET.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const expectedSecret = process.env.CONTROL_PAUSE_SECRET;

  if (expectedSecret && body.passcode !== expectedSecret) {
    return NextResponse.json(
      { error: 'Invalid control passcode. Unauthorized to toggle new_entries_enabled.' },
      { status: 403 }
    );
  }

  const nextEnabled = Boolean(body.new_entries_enabled);
  const sql = getSqlClient();
  const updated = await sql`
    UPDATE control
    SET new_entries_enabled = ${nextEnabled},
        updated_at = NOW(),
        updated_by = 'vercel_web_switch'
    WHERE id = 1
    RETURNING *
  `;

  return NextResponse.json({ control: updated[0] });
}
