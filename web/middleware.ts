import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Optional simple passcode gate via Next.js Edge Middleware.
 * If DASHBOARD_PASSCODE is unset/empty in Vercel env vars, access is open.
 */
export function middleware(request: NextRequest) {
  const requiredPasscode = process.env.DASHBOARD_PASSCODE;
  if (!requiredPasscode || requiredPasscode.trim() === '') {
    return NextResponse.next();
  }

  const cookiePass = request.cookies.get('aegis_passcode')?.value;
  const headerPass = request.headers.get('x-aegis-passcode');
  const queryPass = request.nextUrl.searchParams.get('passcode');

  if (cookiePass === requiredPasscode || headerPass === requiredPasscode) {
    return NextResponse.next();
  }

  if (queryPass === requiredPasscode) {
    const url = request.nextUrl.clone();
    url.searchParams.delete('passcode');
    const response = NextResponse.redirect(url);
    response.cookies.set('aegis_passcode', requiredPasscode, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  }

  return new NextResponse(
    JSON.stringify({
      error: 'Passcode required. Append ?passcode=YOUR_PASSCODE or pass x-aegis-passcode header.',
    }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
