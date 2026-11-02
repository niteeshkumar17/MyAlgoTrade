/** Market-data boundary. The live engine talks to this interface; tests pass a fake. */

import {
  downloadInstrumentMaster,
  fetchHourlyCandles,
  fetchOptionQuotes,
  fetchSpotQuotes,
  getAngelStatus,
} from './angelOneSmartApi.js';
import type { AngelStatusSnapshot, Candle, LegQuote, NfoInstrument, SpotQuote } from './types.js';

export interface MarketData {
  status(): AngelStatusSnapshot;
  fetchSpots(): Promise<Record<string, SpotQuote> | null>;
  fetchCandles(symbol: string, fromIst: string, toIst: string): Promise<Candle[] | null>;
  fetchOptionQuotes(tokens: string[]): Promise<Record<string, LegQuote> | null>;
  fetchInstruments(nowMs: number, spotByUnderlying: Record<string, number>): Promise<NfoInstrument[] | null>;
}

export function angelMarketData(): MarketData {
  return {
    status: getAngelStatus,
    fetchSpots: fetchSpotQuotes,
    fetchCandles: fetchHourlyCandles,
    fetchOptionQuotes,
    fetchInstruments: downloadInstrumentMaster,
  };
}
