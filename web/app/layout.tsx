import React from 'react';

export const metadata = {
  title: 'AegisQuant — Self-Learning Options Paper-Trading Dashboard',
  description:
    'Read-only monitoring dashboard for the Oracle Cloud VM self-learning options paper-trading bot.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
