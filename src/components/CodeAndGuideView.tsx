import React, { useEffect, useState } from 'react';
import { Check, Copy, FileCode, Terminal } from 'lucide-react';

export const CodeAndGuideView: React.FC = () => {
  const [selectedFile, setSelectedFile] = useState<string>('README.md');
  const [fileList, setFileList] = useState<string[]>([
    'README.md',
    'bot/config.yaml',
    'bot/.env.example',
    'bot/requirements.txt',
    'bot/src/config.py',
    'bot/src/calendar_utils.py',
    'bot/src/interfaces.py',
    'bot/src/alpaca_client.py',
    'bot/src/regime.py',
    'bot/src/strategies.py',
    'bot/src/fills.py',
    'bot/src/exits.py',
    'bot/src/risk.py',
    'bot/src/backtester.py',
    'bot/src/journal.py',
    'bot/src/db.py',
    'bot/src/learning.py',
    'bot/src/alerts.py',
    'bot/src/main.py',
    'bot/tests/test_bot_core.py',
    'deploy/install.sh',
    'deploy/aegis-options-bot.service',
    'deploy/migrations/001_initial_schema.sql',
    'deploy/migrations/002_roles_and_permissions.sql',
    'web/.env.example',
    'web/package.json',
    'web/middleware.ts',
    'web/lib/db.ts',
    'web/app/api/overview/route.ts',
    'web/app/api/positions/route.ts',
    'web/app/api/trades/route.ts',
    'web/app/api/performance/route.ts',
    'web/app/api/learning/route.ts',
    'web/app/api/health/route.ts',
    'web/app/api/control/route.ts',
  ]);
  const [fileContent, setFileContent] = useState<string>('Loading file...');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/files?path=${encodeURIComponent(selectedFile)}`)
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (data.content) setFileContent(data.content);
        if (Array.isArray(data.files)) setFileList(data.files);
      })
      .catch(() => {
        if (active) setFileContent('Failed to load file content.');
      });
    return () => {
      active = false;
    };
  }, [selectedFile]);

  const handleCopy = () => {
    navigator.clipboard?.writeText(fileContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="space-y-8">
      {/* Plain-English Explanations & Go/No-Go Checklist */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-2">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            1. How to Read This Website (Plain English)
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <strong>Why there are two equity curves:</strong> Standard paper-trading sandboxes fill NSE option orders optimistically at the mid-price. In live Indian F&amp;O trading, market makers capture part of the bid-ask spread and you pay brokerage + STT + NSE exchange turnover + SEBI + GST charges. Our headline <strong>Conservative Simulation</strong> deducts <code className="font-mono">35% of the spread</code> on entry, <code className="font-mono">35%</code> on exit, and <code className="font-mono">₹35/lot</code> per leg. Always judge the bot by the blue Conservative Simulation curve.
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <strong>Read-Only Security Boundary:</strong> This Vercel dashboard connects using the <code className="font-mono">web_ro</code> Postgres role. It cannot place, modify, or cancel orders. Its only write permission is toggling <code className="font-mono">control.new_entries_enabled</code>.
          </p>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-2">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            2. How the Bot Learns Without Overfitting
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <strong>Counterfactual + Post-Mortem Loop:</strong> Every closed NSE trade gets an automatic diagnosis (<code className="font-mono">theta_or_iv_crush</code>, <code className="font-mono">stopped_out_then_reversed</code>, etc.), and skipped signals are simulated for 5 days so the learner sees what it missed.
          </p>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <strong>4 Deterministic Learners:</strong> (1) L2 Logistic Regression Quality Gate trained on time-ordered walk-forward splits (upgrades to Gradient Boosting only after &gt;= 300 trades), (2) Thompson Sampling Bandit with a 5% minimum floor, (3) Saturday 10:00 IST <code className="font-mono">±10%</code> bounded parameter tuning gated by a 90% bootstrap CI, and (4) Shadow Challenger requiring &gt;= 50 shadow trades before promotion.
          </p>
        </section>

        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 space-y-2">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            3. Known Limitations &amp; SEBI Honesty Checklist
          </h2>
          <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
            <strong>SEBI studies show ~90% of individual F&amp;O traders lose money.</strong> Paper results almost always overstate live results. Key limitations: (a) Free NSE option chain feeds are delayed/indicative rather than tick-by-tick colocation feeds, (b) backtest prices use Black-Scholes IV approximations, and (c) Oracle Free Tier VMs in Mumbai/Hyderabad can be reclaimed after 7 days of low CPU unless upgraded to Pay-As-You-Go (₹0 inside Always Free limits).
          </p>
          <p className="text-xs font-mono text-amber-600 dark:text-amber-400">
            Go/No-Go Gate: &gt;=200 trades · &gt;=8-12 wks · Cons PF &gt; 1.3 · DD &lt; 10% · &gt;=2 regimes.
          </p>
        </section>
      </div>

      {/* Interactive Monorepo Source Explorer */}
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-blue-500" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Complete Monorepo File Explorer (/bot, /deploy, /web, README.md)
            </h2>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-500" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            {copied ? 'Copied to Clipboard' : `Copy ${selectedFile}`}
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 min-h-[540px]">
          <div className="border-r border-slate-200 dark:border-slate-800 p-3 space-y-1 max-h-[540px] overflow-y-auto bg-slate-50/50 dark:bg-slate-950/40">
            {fileList.map((filePath) => (
              <button
                key={filePath}
                type="button"
                onClick={() => setSelectedFile(filePath)}
                className={`w-full text-left px-3 py-1.5 rounded text-xs font-mono truncate transition-colors ${
                  selectedFile === filePath
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-slate-800/60'
                }`}
              >
                {filePath}
              </button>
            ))}
          </div>

          <div className="lg:col-span-3 p-4 bg-slate-950 text-slate-100 overflow-auto max-h-[540px]">
            <div className="flex items-center gap-2 text-xs font-mono text-slate-400 pb-3 mb-3 border-b border-slate-800">
              <Terminal className="w-3.5 h-3.5" />
              <span>/{selectedFile}</span>
            </div>
            <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
              {fileContent}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );
};
