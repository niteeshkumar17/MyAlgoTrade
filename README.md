# NSE debit-spread paper training

This repository paper-trades defined-risk debit spreads on NIFTY, BANKNIFTY, FINNIFTY, RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK and SBIN.

It does not send orders. Fills are the live Angel One bid and ask. A missing bid or ask is left missing. The paper ledger starts at ₹50,000.

The one-year research report prices options with Black-Scholes because historical option order books are not in the cache. That report is a prior for the model. Only the live paper ledger counts toward the real-money checklist.

## Real-money checklist

All of these have to be true on the live paper ledger before a live-order system is even worth designing:

- 200 closed paper trades
- 8 weeks of running
- the 90% confidence interval of expectancy per trade is above zero
- profit factor above 1.30
- maximum drawdown under 10%
- positive average result in at least two market regimes with 20 trades each

A live retail algo also needs the broker to register the strategy and a static IP approved with the exchange. This Vercel deployment has no static IP, so that later step would run on a VM. Set `ADMIN_SECRET` in Vercel before using the dashboard controls.

## Run locally

```bash
npm install
npm test
npm run dev
```

`/api/tick` runs a cycle when one is due. `/api/state` is the dashboard payload.
