import type { Timeframe } from "@atrp/shared-types";

/**
 * OKX bar names. 4H and 1D default to Hong Kong time on OKX, so the UTC
 * variants are used to keep candle boundaries in UTC (PRD 4.2).
 */
export const OKX_BAR: Record<Timeframe, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4Hutc",
  "1d": "1Dutc",
};

export const OKX_CANDLE_CHANNEL = (tf: Timeframe) => `candle${OKX_BAR[tf]}`;
