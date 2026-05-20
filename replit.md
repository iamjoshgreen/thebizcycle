# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Artifacts

- `artifacts/api-server` — Express API serving all chart/indicator data (port 8080).
  Routes registered in `src/routes/index.ts`. Each indicator has its own
  `src/lib/<name>Fetcher.ts` (FRED-backed) and `src/routes/<name>.ts`
  (`/api/<name>` GET + `/api/<name>/refresh` POST). Requires `FRED_API_KEY`.
- `artifacts/business-cycle-chart` — Vite React app. Pages are full-bleed,
  inline-styled, dark-themed (`hsl(230 14% 8%)` bg). Each page has its own
  route in `src/App.tsx` and a tab in `src/components/TopBar.tsx`. Tabs:
  Business Cycle Chart, Fractal Overlay, Channel, Housing, Recession, Cyclical GDP,
  Global Liquidity.
- `lib/api-spec/openapi.yaml` — single source of truth for API schemas.
  After editing run `pnpm --filter @workspace/api-spec run codegen` to
  regenerate React Query hooks and types in `@workspace/api-client-react`.

## Indicator: Cyclical GDP (`/cyclical`)

Implements the EPB Research framework: cyclical GDP = Durable Goods
Consumption (`PCDGCC96`) + Residential Investment (`PRFIC1`) + Business
Equipment Investment (`Y033RX1Q020SBEA`). Together ~20% of GDP, but drives
the cycle.

Data strategy in `cyclicalFetcher.ts`:
- For long history (1947+) it pulls BEA percent-change-at-annual-rate series
  (`DDURRL1Q225SBEA`, `A011RL1Q225SBEA`, `Y033RL1Q225SBEA`, `A191RL1Q225SBEA`)
  and weight-averages the three component growth rates with fixed weights
  derived from the latest dollar shares.
- For quarters where chained-dollar level series are available (post-2007 once
  all three exist), it sums levels and recomputes QoQ-annualized growth from
  the summed series (matches EPB's exact recent-quarter prints).
- Contraction-frequency stats (since 1956) are computed on YoY composites,
  not single-quarter QoQ — quarterly QoQ counts overstate "contractions".

## Indicator: Global Liquidity Index (`/gli`)

Constructed composite (not a single FRED series, not Global M2):

  GLI = (WALCL − WTREGEN − RRPONTSYD) + ECBASSETSW·(USD/EUR) + JPNASSETS·(USD/JPY)

All components are converted to USD billions on a weekly Friday grid (forward-
filled from each upstream cadence) and summed. Headline number is reported in
trillions of USD.

Data sources in `gliFetcher.ts`:
- Fed net: WALCL (millions USD, weekly) − WTREGEN (billions USD, weekly) −
  RRPONTSYD (billions USD, daily).
- ECB: ECBASSETSW (millions EUR, weekly) × DEXUSEU (USD per EUR).
- BoJ: JPNASSETS (millions JPY, monthly) × 1/DEXJPUS (USD per JPY).
- DXY context strip: DTWEXBGS (broad nominal USD index, daily).
- BTC + S&P 500 overlay: Yahoo Finance `BTC-USD` and `^GSPC` weekly close.

v1 scope: BoE and PBoC have no reliable free weekly series on FRED, so they
appear in the components table as "excluded" with a clear note. Adding them
later means dropping a new entry into `COMPONENTS` in `gliFetcher.ts`.

Lag overlay: GLI is shifted forward when overlaid on BTC/SPX. Presets are
56 / 60 / 75 days; default is 75 days. A slider allows free choice 0–180.
The page describes the framework — it does not predict catch-up size or peak
timing.
