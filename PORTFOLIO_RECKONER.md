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

Measured 2026-08-02 · rule `flip-only` · **4,081 closed trades (active watchlist members only —
26 pairs / 321 trades excluded)** · Top-20 universe by expectancy percentile · $100k capital ·
"First signal wins" contention. Add `--no-membership` to either command for the unfiltered,
full-history view.

---

## 1. How a slot is actually filled

Verified against `simulatePortfolio()` in `src/core/portfolio_sim.js`, not inferred.

**One shared pool across every selected timeframe.** Slots are *not* per-timeframe. All selected
timeframes' signals merge into a single stream sorted by entry time, and they compete for the same
N slots. Adding a timeframe therefore *steals* capacity from the ones already there:

| cap 3, Top-20 universe | signals taken |
|---|---|
| 15m alone | 78 |
| 2h alone | 81 |
| *sum if pools were independent* | *159* |
| **15m + 2h together** | **119** |

**Chronological first-come.** Signals are processed in entry-time order. Before each one is
considered, every position whose exit already occurred is closed and its slot released. So yes —
slots fill 0→N from the earliest entries across the selected timeframes, and after that a new
position can only open when one closes.

**A turned-away signal is gone, not queued.** This is the part that surprises people. The simulator
visits each signal exactly once; if every slot is busy at that instant, the signal is *skipped
permanently* and never revisited. When a slot frees, it goes to whichever signal arrives next **in
time** — not to a backlog. Proof by construction: `signalsTaken + signalsSkipped = signalsAvailable`
exactly (111 + 127 = 238 at cap 3).

**Ties** at an identical entry timestamp resolve by arrival order under "First signal wins
(realistic)"; under rank mode the higher-ranked symbol wins.

**Excluded before slotting**: margin-call rows (an artifact of over-sizing, not a decision) and
pyramid add-legs (merged into their base position — one position, one slot).

### The trap: max positions is also your position size

```
position size = current portfolio value / maxPositions
```

Max positions is **not just a concurrency cap — it is the position-size divisor.** Halving it
doubles every position. Across the whole grid this is why average CAGR falls monotonically as slots
rise (see the Slot count table below) — that is leverage, not skill:

| slots | size per position | final equity (15m+2h, Top-20, full history) | CAGR |
|---|---|---|---|
| 3 | 33% | $533,452 | 140.8% |
| 5 | 20% | $557,088 | 146.3% |
| 10 | 10% | $326,117 | 86.0% |
| 20 | 5% | $193,386 | 41.4% |

**Note the 3-vs-5 inversion in this particular pair** — fewer slots is not *always* more return.
Below a certain count the cap starts turning away so many signals that lost trades outweigh the
larger size, and cash sits idle rather than compounding. The monotonic relationship holds on the
grid **average** over all 255 subsets; it is not a guarantee for any single config, which is exactly
why the slot count is worth checking per config rather than assumed.

Cash is a second constraint (`size` is clamped to available cash), and it binds harder than the slot
cap here — at cap 5 this pair sits fully deployed only 12% of the time, averaging 38% of capital at
work, so much of the book is idle cash waiting for the next signal.

---

## 2. The reckoner — what to actually run

Averaged over three out-of-sample windows, with the symbol universe re-picked inside each in-sample
window so nothing leaks. **Sorted by out-of-sample CAGR.**

Measured over **active watchlist members only** (see "Universe" below).

| config | avg CAGR | Expected | avg DD | avg C/DD | avg rank | both-axes | worst |
|---|---|---|---|---|---|---|---|
| **15m+30m @ 3** | **205%** | **113%** | 5.4% | 45.2 | **2.3** | **3.83** | 5 |
| 15m+30m+45m @ 5 | 167% | 98% | 4.2% | 42.4 | 4.7 | 5.17 | 9 |
| 15m+2h @ 5 | 160% | 91% | 9.3% | 25.6 | 7.0 | 7.50 | 10 |
| 30m+2h @ 5 | 155% | 95% | 9.1% | 23.3 | 5.0 | 6.83 | 9 |
| 15m+30m+45m+2h @ 8 | 150% | 91% | 5.6% | 34.3 | 5.3 | 5.83 | 9 |
| fast5 (15m–2h) @ 10 | 149% | 92% | **3.7%** | 47.0 | 5.3 | 4.67 | **7** |
| 15m+30m @ 5 | 148% | 91% | **3.2%** | **55.3** | 5.3 | 4.33 | 11 |
| all-but-1d @ 15 | 133% | 86% | 3.6% | 38.9 | 6.3 | 6.00 | 7 |
| all 8 TF @ 15 | 131% | 85% | 3.7% | 36.5 | 6.7 | 6.00 | 8 |
| fast5 @ 15 | 125% | 82% | **3.1%** | 44.3 | 7.3 | 5.83 | 8 |
| all 8 TF @ 10 | 99% | 70% | 5.9% | 17.5 | 10.7 | 10.00 | 11 |

**If you want one answer, it is still `15m + 30m` at 3 slots — but hold it more loosely than the
previous revision of this document implied.** It is first on CAGR, first on Expected, first on the
both-axes rank, and first in the matched-window check below. What it no longer has is *separation*:
its both-axes rank is 3.83 against 4.33 for `15m+30m @ 5` and 4.67 for `fast5 @ 10`, and its worst
window finish is 5th. Under the old, ungated universe it won every single window at rank 1.33.

Two honest reads of that. The optimistic one: it tops four independent passes, and nothing else does.
The skeptical one: four passes over one short, heavily-overlapping stretch of one market are close to
one pass, and a 0.8-rank lead is inside the noise. **`15m+30m @ 5` is the better risk-adjusted pick
on this table** (C/DD 55.3 vs 45.2, drawdown 3.2% vs 5.4%) and loses only the return that the slot
divisor mechanically explains — pick between them on risk appetite, not on the rank column.

**The single biggest lever is swapping 2h for 30m**, and it survives gating at 3 slots but *not* at
5: `15m+2h @ 5` → `15m+30m @ 5` is 160% → 148% CAGR, i.e. now slightly negative on return, though
drawdown improves sharply (9.3% → 3.2%) and C/DD more than doubles (25.6 → 55.3). The previous
revision reported this as 121% → 276%; that gap was largely symbols no longer in the 30m watchlist.

### Timeframe contribution

Average CAGR of every combo containing a timeframe vs every combo without it (255 subsets):

| timeframe | with | without | delta |
|---|---|---|---|
| 15m | 61.3% | 52.1% | **+9.2** |
| 2h | 61.0% | 52.5% | **+8.5** |
| 30m | 60.5% | 52.9% | **+7.6** |
| 45m | 58.9% | 54.6% | +4.3 |
| 1h | 57.7% | 55.8% | +1.9 |
| 3h | 55.1% | 58.4% | −3.3 |
| 4h | 50.3% | 63.2% | −12.9 |
| **1d** | 38.9% | 74.7% | **−35.7** |

**Drop 1d.** It is the largest and cleanest effect in the entire grid.

### How many timeframes to combine

| count | avg CAGR | avg DD | avg fill |
|---|---|---|---|
| 1 | 68.1% | 7.5% | 93% |
| **2** | **71.4%** | 10.9% | 86% |
| 3 | 67.5% | 13.3% | 80% |
| 4 | 63.7% | 15.5% | 75% |
| 5 | 59.1% | 17.4% | 70% |
| 8 | 41.3% | 21.5% | 58% |

Two to three timeframes. Beyond that each addition dilutes: more signals chase the same slots, so
fill rate falls and the extra timeframes mostly crowd out the good ones.

### Matched-window check — the comparison the table above cannot make

Every number above scores each config over **its own** span. Logged history per timeframe is wildly
uneven, so `15m+30m` and `all 8 TF` were never run over the same market:

| timeframe | log starts | years |
|---|---|---|
| 1d | 2016-11-03 | 9.74 |
| 4h | 2022-09-19 | 3.86 |
| 3h | 2024-01-02 | 2.58 |
| 2h | 2024-09-03 | 1.91 |
| 15m | 2024-09-20 | 1.86 |
| 45m | 2025-05-23 | 1.19 |
| 1h | 2025-07-16 | 1.04 |
| **30m** | **2026-01-12** | **0.55** |

Fixing the calendar to the stretch where all eight coexist (**2026-01-12 → 2026-07-31**, 0.55y —
30m is the binding constraint) and re-ranking across 6 rolling start dates, with the symbol universe
picked from data strictly *before* each window opens. Ranked on **total return over the window**, not
CAGR — the shared window is short and the exponent would inflate it.

Measured over **active watchlist members only** (see "Universe" below).

| config | avg rank | worst | return | maxDD | ret/DD | fill |
|---|---|---|---|---|---|---|
| **15m+30m @ 3** | **3.50** | 9 | 69.8% | 5.2% | 16.9 | 68% |
| 15m+2h @ 5 | 3.83 | 9 | 66.1% | 5.0% | 13.3 | 76% |
| fast5 @ 10 | 4.00 | **6** | 59.8% | 2.7% | 22.3 | 70% |
| 15m+30m+45m @ 5 | 4.17 | 10 | 66.3% | 3.9% | 19.1 | 71% |
| 15m+30m+45m+2h @ 8 | 4.50 | 7 | 58.0% | 3.3% | 18.1 | 73% |
| 15m+30m @ 5 | 6.00 | 11 | 54.9% | 3.6% | 18.2 | 91% |
| all 8 TF @ 15 | 7.67 | 11 | 50.1% | 3.4% | 15.1 | 67% |
| all-but-1d @ 15 | 7.67 | 10 | 49.9% | 3.3% | 15.3 | 70% |
| 30m+2h @ 5 | 7.83 | 11 | 47.8% | 6.3% | 8.8 | 77% |
| all 8 TF @ 10 | 8.33 | 11 | 49.0% | 5.1% | 9.7 | 50% |
| fast5 @ 15 | 8.50 | 10 | 48.8% | 2.6% | 19.2 | 89% |

**`15m+30m @ 3` still ranks first — but its stability claim did not survive the membership gate.**
Measured over all logged history it averaged rank 1.17 with a *worst* finish of 2nd, which was the
single strongest piece of evidence for the headline recommendation. Restricted to symbols still in a
watchlist it averages 3.50 with a worst finish of **9th of 11**, and the top five configs now sit
inside 1.0 rank of each other — a spread this tight over six overlapping windows is not a
separation. Its lead is now a preference, not a finding.

The mechanism is specific rather than mysterious: the gate drops 7 (symbol, timeframe) pairs and
**all of them are on 15m or 30m** — the only two timeframes this config trades — so it lost more of
its universe than any config spanning slower timeframes. Read the other direction, the old ranking
was partly measuring symbols that are no longer tradable there.

Two things it still settles, both unchanged in direction:

- **3 slots beats 5 for the same pair on every axis**: rank 3.50 vs 6.00, return 69.8% vs 54.9%.
  Note ret/DD is now near-identical (16.9 vs 18.2), so this is a return argument, not a
  risk-adjusted one. Part of it is still the size divisor — read against the drawdown column and the
  ~1.8× understatement noted below.
- **The Top-20 filter only earns its keep at the lower slot count.** Fill is 68% at 3 slots against
  91% at 5, where per [CLAUDE.md](CLAUDE.md)'s "Ranking is a filter, not a priority" trimming mostly
  just removes trades. Both numbers rose under the gate (was 58%/81%) because a smaller eligible
  universe produces fewer competing signals — 3 slots is now only marginally inside the
  capacity-constrained regime where selection was measured to pay.

**The rolling windows are not independent samples.** They all end on the same date and start weeks
apart, so they share most of their trades. This is a consistency check on the *ordering*, not six
experiments — which is why the `worst` column carries as much weight here as the average.

### Slot count

| slots | avg CAGR | avg DD | avg fill |
|---|---|---|---|
| 3 | 98.2% | 16.1% | 40% |
| 5 | 83.9% | 11.6% | 58% |
| 8 | 64.8% | 10.6% | 75% |
| 10 | 56.1% | 10.0% | 82% |
| 15 | 40.9% | 7.3% | 92% |
| 20 | 31.7% | 5.5% | 97% |
| 30 | 21.5% | 3.7% | 100% |

Perfectly monotonic in **both** directions — this is the size divisor above, not an edge. Pick your
risk tolerance first, then optimize timeframes within it. Note also that per
[CLAUDE.md](CLAUDE.md)'s "Ranking is a filter, not a priority", symbol selection only pays when fill
rate is materially under ~65%; above that you are not capacity-constrained and trimming just removes
trades.

---

## 3. Read this before acting on the table

**Magnitudes are not forecasts.** Out-of-sample windows are 3–6 months with heavy compounding, so
100–200% is not an expectation. The **ordering** is the finding; the levels are not — the Expected
column is the same return without compounding and is the sober read (205% CAGR → 113% Expected on the
top row).

**Drawdowns are understated ~1.8×.** The equity curve is marked only at exits, so it cannot show
pain felt while positions were open. On `15m+30m @ 3` over full history the realized figure reads
9.9% while the MAE-based estimate — every position simultaneously at its worst logged excursion — is
17.5%. True drawdown lies between the two; scale every DD in these tables accordingly.

**Closed trades only.** Still-open positions are absent from the log and are disproportionately
losers (winners close, losers ride), so every figure here is optimistic by an amount it cannot
measure.

**Span differences are a confound in every table except the matched-window check.** Timeframe
histories range from 9.74y (1d) to 0.55y (30m), so any comparison over each config's own span is
partly a statement about which years it happened to cover. The matched-window section fixes this;
the others do not.

**Universe: active watchlist members only.** Every table in this document is measured over
(symbol, timeframe) pairs still present in a configured watchlist — 26 pairs / 321 trades excluded at
the time of writing, all of the 15m and 30m ones from the two timeframes the headline config trades.
This is deliberately survivorship-filtered: it answers "what should I run next", not "what would this
have returned". It does not flatter the numbers — the excluded trades average 3.31%/trade against
3.74% for the kept ones, and gating *lowers* the headline CAGR — but the exclusions are not random,
so treat any comparison against an older revision of this document as a comparison between two
different universes. Regenerate ungated with `node scripts/run_sweet_spot.js --no-membership`.

**In-sample CAGR barely predicts out-of-sample CAGR at all** — Spearman rho 0.602 / **−0.003** /
0.118 across the three splits, and the middle split is the honest headline: under the membership gate
one of the three windows has *no* relationship whatsoever. The third split's in-sample winner
(`15m+1h @3`, 267% in-sample) returned 83% out-of-sample. Positive, unlike per-symbol CAGR/DD which is *negative* (see CLAUDE.md,
"Ranking symbols: use expectancy, never CAGR/DD"), but far too unstable to justify picking the best
of 1,785 combos. That instability is exactly why the recommendation comes from averaging a shortlist
rather than from the grid maximum.

**Do not add a drawdown or ratio screen on top.** Tested and rejected 2026-07-25: it inverts on
expectancy and loses on both CAGR and portfolio drawdown. See CLAUDE.md, "Watchlist selection".

**The in-sample grid maximum is not a result.** For the record: the best of 1,785 in-sample was
`15m+30m @ 3` at 476% CAGR, and every in-sample winner across all three walk-forward splits landed
at 3 slots — the minimum offered (`15m+1h @ 3`, `15m+30m+45m @ 3`, `15m+1h @ 3`). That is what
maximizing CAGR does: it walks to maximum concentration every time.
