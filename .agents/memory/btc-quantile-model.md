---
name: BTC Quantile page model
description: The BTC Quantile page uses a DETERMINISTIC fixed-coefficient quantile model from a paper, not a runtime regression.
---

# BTC Quantile page is a deterministic fixed-coefficient model

The `/btc-quantile` page implements the paper "Asymmetric Tail Curvature in Bitcoin
Price Quantiles" (Table 3). Nothing is fit at runtime.

**The rule:** quantile band values come from fixed coefficients, NOT from data. Do not
reintroduce quantile regression / OLS / sub-gradient fitting on the price series. The
price data (Yahoo BTC-USD weekly + hardcoded 2010–2014 monthly) is only for the price
line, never for fitting the bands.

**Why:** an earlier version data-fitted 3 quantiles via sub-gradient regression. The
domain expert rejected it — it produced wrong band geometry (BTC ~$73K read as "0th
pct" instead of ~Q10). The paper's coefficients are authoritative.

**The exact transform (easy to get wrong):**
- anchor GENESIS = Jan 1 2009 (NOT Jan 3); `t` = days since genesis.
- `x = ln(max(1,t)) - 7.9914` — MU=7.9914 is a FIXED centering constant, NOT the data mean.
- `log10(price) = c + a*x + b*x^2` — time is natural-log, price is base-10. Convert with
  `Math.pow(10, ...)`, NOT `Math.exp(...)`. Mixed bases are intentional.
- 7 quantiles τ ∈ {1,10,25,50,75,95,99}%; per date SORT the 7 prices ascending
  (rearrangement). Required, not cosmetic: Q75/Q95 cross ~Dec 2026 without it.
- 4 dislocation lines below Q1% at offsets [-0.0735,-0.174,-0.226,-0.346]; golden zone
  is the Area between disl1 (top) and disl4 (bottom).

**Verification anchors (use these to confirm any future edit):** x=0 (≈Feb 2017) →
Q1≈$687, Q50≈$1637, Q99≈$10666; mid-2026 (x≈0.765) → Q1≈$62K, Q10≈$74K, Q50≈$111K,
Q99≈$197K. Projection runs 2 years past the last data point (price=null on projected rows).

**Recharts note:** golden zone is a ranged `<Area>` whose dataKey value is a tuple
`[disl4, disl1]`. X-axis is LINEAR calendar time in ms — NOT log-time; the `ln(t)` term
in the model is what bends the bands into the concave fan when drawn against linear time
(matches the paper's Figure 1). Price axis is `scale="log"` and lives on the RIGHT only
(user explicitly rejected a left price axis).

**Zoom interaction (user rejected both a Brush slider AND sliders generally — "they
don't drag"):** "normal chart" zoom = scroll-wheel (centered on cursor) + drag-to-select
a range + double-click to reset. Implemented with `zoom: [lo,hi]|null` state driving
`XAxis domain={[lo,hi]} allowDataOverflow`; the active window also drives the y-domain
auto-fit and adaptive x-ticks (years→quarters→months). Gotchas that bit us:
- Wheel must be a NATIVE non-passive listener (`addEventListener('wheel', fn, {passive:false})`
  on a wrapper div ref) so `preventDefault()` can stop page scroll — React's onWheel is passive.
- The wheel handler reads live state via refs (`zoomRef`, `hoverMsRef` from `activeLabel`,
  `boundsRef` for xMin/xMax) and binds ONCE (`useEffect` deps `[]`) — avoids stale closures.
- That `useEffect` MUST sit ABOVE the `if (series.length < 4) return` early-return or hook
  order breaks. Keep all hooks before any conditional return.
- Enforce `MIN_ZOOM_SPAN` (21d) by re-centering within bounds, not a naive
  `min(xMax, lo+MIN)` — the naive form yields sub-min spans near the right edge.
**Why:** these are specific, repeated user UX requests (right-side price + wheel/drag zoom,
no sliders); keep them if the chart is revisited.
