# Portfolio Configuration — Ready Reckoner

Quick reference for the two Portfolio Sim knobs that matter most: **which timeframes** to trade
together, and **how many positions** to run. Every number here is measured, not assumed.

Regenerate after the trade log grows materially — these are empirical, so they can move:

```
node scripts/sweep_portfolio_grid.mjs            # grid + walk-forward + shortlist (~3 min)
node scripts/sweep_portfolio_grid.mjs --quick    # shortlist only (~1 s)
```

Or open the dashboard's **Sweet Spot** tab and press Run — same numbers, live, with charts and a
staleness check against the current trade count. Both paths call `runSweetSpotAnalysis()` in
[src/core/sweet_spot.js](src/core/sweet_spot.js); the script above is only a formatter over it, so
the tab and this document cannot report different answers. The tab additionally computes a
**both-axes rank** (mean of each config's CAGR rank and CAGR/DD rank per window) — the table below
ranks on CAGR alone, and the "best all-round" call in it was made by eye.

Measured 2026-07-31 · rule `flip-only` · 4,664 closed trades · Top-20 universe by expectancy
percentile · $100k capital · "First signal wins" contention.

---

## 1. How a slot is actually filled

Verified against `simulatePortfolio()` in `src/core/portfolio_sim.js`, not inferred.

**One shared pool across every selected timeframe.** Slots are *not* per-timeframe. All selected
timeframes' signals merge into a single stream sorted by entry time, and they compete for the same
N slots. Adding a timeframe therefore *steals* capacity from the ones already there:

| cap 3, full universe | signals taken |
|---|---|
| 15m alone | 121 |
| 2h alone | 122 |
| *sum if pools were independent* | *243* |
| **15m + 2h together** | **164** |

**Chronological first-come.** Signals are processed in entry-time order. Before each one is
considered, every position whose exit already occurred is closed and its slot released. So yes —
slots fill 0→N from the earliest entries across the selected timeframes, and after that a new
position can only open when one closes.

**A turned-away signal is gone, not queued.** This is the part that surprises people. The simulator
visits each signal exactly once; if every slot is busy at that instant, the signal is *skipped
permanently* and never revisited. When a slot frees, it goes to whichever signal arrives next **in
time** — not to a backlog. Proof by construction: `signalsTaken + signalsSkipped = signalsAvailable`
exactly (164 + 917 = 1,081 at cap 3).

**Ties** at an identical entry timestamp resolve by arrival order under "First signal wins
(realistic)"; under rank mode the higher-ranked symbol wins.

**Excluded before slotting**: margin-call rows (an artifact of over-sizing, not a decision) and
pyramid add-legs (merged into their base position — one position, one slot).

### The trap: max positions is also your position size

```
position size = current portfolio value / maxPositions
```

Max positions is **not just a concurrency cap — it is the position-size divisor.** Halving it
doubles every position. This is why CAGR rises so sharply as slots fall, and it is leverage, not
skill:

| slots | size per position | final equity (15m+2h, same trades) | CAGR |
|---|---|---|---|
| 3 | 33% | $335,867 | 260.4% |
| 5 | 20% | $243,231 | 156.1% |
| 10 | 10% | $157,183 | 61.4% |
| 20 | 5% | $125,630 | 27.3% |

Cash is a second constraint (`size` is clamped to available cash), but the slot cap binds first in
practice — at cap 5 the book sits fully deployed 55% of the time, averaging 82% of capital at work.

---

## 2. The reckoner — what to actually run

Averaged over three out-of-sample windows, with the symbol universe re-picked inside each in-sample
window so nothing leaks. **Sorted by out-of-sample CAGR.**

| config | avg CAGR | avg DD | avg C/DD | avg rank | read |
|---|---|---|---|---|---|
| **15m+30m @ 3** | 396% | 9.3% | 43.1 | **1.0** | max return, bought with concentration |
| **15m+30m+45m @ 5** | 333% | 6.3% | **52.1** | **2.3** | **best all-round — top 3 on both axes** |
| 15m+30m @ 5 | 262% | 6.5% | 39.7 | 5.7 | |
| 15m+30m+45m+2h @ 8 | 192% | 4.9% | 43.7 | 4.0 | calmer, still strong |
| all 8 TF @ 10 | 173% | **4.4%** | 41.8 | 4.3 | most diversified sensible option |
| fast5 (15m–2h) @ 10 | 164% | 5.2% | 31.5 | 5.3 | |
| all-but-1d @ 15 | 151% | 5.3% | 29.6 | 7.7 | |
| 30m+2h @ 5 | 147% | 8.9% | 18.4 | 7.7 | |
| all 8 TF @ 15 | 143% | 5.3% | 28.1 | 8.7 | |
| fast5 @ 15 | 140% | 3.8% | 42.8 | 9.3 | |
| **15m+2h @ 5** | **124%** | 8.2% | 18.6 | **10.0** | **last of eleven** |

**If you want one answer: `15m + 30m + 45m` at 5 slots.** It is the only config in the top three on
*both* raw and risk-adjusted return, in every window.

**The single biggest lever is swapping 2h for 30m.** Same 5 slots, `15m+2h` → `15m+30m`:
124% → 262% CAGR *with lower* drawdown (8.2% → 6.5%).

### Timeframe contribution

Average CAGR of every combo containing a timeframe vs every combo without it (255 subsets):

| timeframe | with | without | delta |
|---|---|---|---|
| 2h | 80.8% | 64.6% | **+16.2** |
| 30m | 80.2% | 65.3% | **+14.9** |
| 15m | 77.5% | 68.1% | +9.4 |
| 45m | 75.8% | 69.7% | +6.0 |
| 1h | 70.6% | 75.0% | −4.4 |
| 3h | 69.5% | 76.1% | −6.7 |
| 4h | 66.6% | 79.0% | −12.4 |
| **1d** | 39.6% | 106.3% | **−66.7** |

**Drop 1d.** It is the largest and cleanest effect in the entire grid.

### How many timeframes to combine

| count | avg CAGR | avg DD | avg fill |
|---|---|---|---|
| 1 | 76.6% | 6.9% | 94% |
| **2** | **84.5%** | 9.8% | 87% |
| 3 | 80.4% | 11.9% | 82% |
| 4 | 73.9% | 13.7% | 77% |
| 5 | 66.9% | 15.2% | 72% |
| 8 | 47.8% | 18.4% | 61% |

Two to three timeframes. Beyond that each addition dilutes: more signals chase the same slots, so
fill rate falls and the extra timeframes mostly crowd out the good ones.

### Slot count

| slots | avg CAGR | avg DD | avg fill |
|---|---|---|---|
| 3 | 118.2% | 24.9% | 40% |
| 5 | 106.7% | 20.2% | 58% |
| 8 | 87.2% | 15.0% | 74% |
| 10 | 74.4% | 13.3% | 81% |
| 15 | 53.4% | 9.1% | 91% |
| 20 | 41.3% | 6.9% | 96% |
| 30 | 28.2% | 4.7% | 99% |

Perfectly monotonic in **both** directions — this is the size divisor above, not an edge. Pick your
risk tolerance first, then optimize timeframes within it. Note also that per
[CLAUDE.md](CLAUDE.md)'s "Ranking is a filter, not a priority", symbol selection only pays when fill
rate is materially under ~65%; above that you are not capacity-constrained and trimming just removes
trades.

---

## 3. Read this before acting on the table

**Magnitudes are not forecasts.** Out-of-sample windows are 3–6 months with 39–155 trades and heavy
compounding, so 300–600% is not an expectation. The **ordering** is the finding; the levels are not.

**Drawdowns are understated ~3.5×.** The equity curve is marked only at exits, so it cannot show
pain felt while positions were open. The dashboard's own MAE-based estimate puts true drawdown at
~30.6% where the realized figure reads 8.4%. Scale every DD in these tables accordingly.

**Closed trades only.** Still-open positions are absent from the log and are disproportionately
losers (winners close, losers ride), so every figure here is optimistic by an amount it cannot
measure.

**In-sample CAGR only weakly predicts out-of-sample CAGR** — Spearman rho 0.522 / 0.185 / 0.284
across the three splits. Positive, unlike per-symbol CAGR/DD which is *negative* (see CLAUDE.md,
"Ranking symbols: use expectancy, never CAGR/DD"), but far too unstable to justify picking the best
of 1,785 combos. That instability is exactly why the recommendation comes from averaging a shortlist
rather than from the grid maximum.

**Do not add a drawdown or ratio screen on top.** Tested and rejected 2026-07-25: it inverts on
expectancy and loses on both CAGR and portfolio drawdown. See CLAUDE.md, "Watchlist selection".

**The in-sample grid maximum is not a result.** For the record: the best of 1,785 in-sample was
`15m+30m @ 3` at 581% CAGR, and every in-sample winner across all three walk-forward splits landed
at 3 slots — the minimum offered. That is what maximizing CAGR does: it walks to maximum
concentration every time.
