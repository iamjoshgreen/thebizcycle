---
name: lightweight-charts mixed-cadence spacing
description: Why a time-series chart looks "elbowed" on lightweight-charts when source data has irregular cadence, and the fix.
---

lightweight-charts (TradingView) lays out data points by **index/ordinal**, giving
every bar equal horizontal width. It does NOT have a true linear-calendar-time
x-axis mode. `timeToCoordinate` still interpolates for arbitrary timestamps (so
markers/recession-bar primitives at off-grid times work fine), but the *plotted
series* are spaced purely by point index.

**Symptom:** a series whose cadence changes over time (e.g. monthly early, weekly
recent) renders with the sparse early region crammed into a thin strip on the left
— a sharp "elbow" — while a recharts/linear-time version of the same data spreads
those early years across their real calendar width (smooth curve).

**Where this bit us:** `/btc-quantile` (BtcQuantilePage). Source series is monthly
2010-07→~2014 (~50 pts) then weekly (~714 pts). On recharts (linear time) the fan
was a smooth concave; the lightweight-charts rebuild crammed 2010–2014 into ~6% of
the width and the early power-law values plunged, also blowing out the autoscaled
log y-axis.

**Fix:** resample everything onto a uniform time grid (weekly here) before
`setData`. Quantile/dislocation lines are smooth analytic curves, so linear
interpolation between source points is faithful. The price polyline is sampled
along itself and left null beyond the last real print (no fabricated future data).
See `resampleWeekly` in BtcQuantilePage.tsx.

**Why:** index spacing == calendar spacing only when the data is uniformly spaced
in time. Any cadence change distorts the x-shape. Resampling to a single uniform
grid is the robust way to recover a linear-time look on lightweight-charts.

**How to apply:** any time you port a linear-time chart to lightweight-charts, or
feed it series with irregular/mixed cadence, resample to a uniform grid first.
