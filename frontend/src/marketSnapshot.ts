/**
 * Dated market observations the product pages quote. Source: Hyperliquid API
 * (`fundingHistory` over 90 days, `borrowLendReserveState`), read 2026-10-12.
 * Not a forecast: funding changes every hour.
 */
export const SNAPSHOT = {
  date: "2026-10-12",
  hype: {
    funding90d: 0.1005,
    funding30d: 0.0961,
    worst7d: 0.0433,
    negativeHours: 0.089,
    minHourly: -0.398,
  },
  btc: {
    funding90d: 0.0845,
    funding30d: 0.0862,
    worst7d: 0.0401,
    negativeHours: 0.085,
  },
  usdc: { borrowApr: 0.05, supplyApr: 0.0349, utilization: 0.775 },
  ltv: { hype: 0.65, btc: 0.5 },
} as const;
