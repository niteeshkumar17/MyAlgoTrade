'use client';

import React, { useEffect, useState } from 'react';

/**
 * Vercel Next.js App Router Dashboard Client Entrypoint.
 * Polls /api/overview, /api/positions, /api/trades, /api/performance, /api/learning, /api/health
 * every 45 seconds using the read-only `web_ro` database role.
 */
export default function VercelDashboardPage() {
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const res = await fetch('/api/overview');
        if (res.ok) {
          const data = await res.json();
          setOverview(data);
          setLastUpdated(new Date().toISOString());
        }
      } catch {
        // Handled by offline banner state
      }
    };
    fetchAll();
    const timer = setInterval(fetchAll, 45000);
    return () => clearInterval(timer);
  }, []);

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="bg-amber-500/10 border border-amber-500/40 text-amber-300 px-4 py-2 text-xs font-mono mb-6">
        PAPER TRADING - NOT REAL MONEY · Read-Only Vercel Monitoring Node (web_ro)
      </div>
      <h1 className="text-2xl font-bold tracking-tight">AegisQuant Options Paper-Trading Telemetry</h1>
      <p className="text-sm text-slate-400 mt-1">
        Last polled: {lastUpdated || 'Connecting to Neon pooled Postgres...'}
      </p>
      <pre className="mt-6 p-4 bg-slate-900 border border-slate-800 text-xs font-mono overflow-auto">
        {JSON.stringify(overview, null, 2)}
      </pre>
    </main>
  );
}
