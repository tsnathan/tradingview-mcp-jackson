# Stop-Loss & Pyramid Analysis

Analysis only — **nothing here is implemented**. Recorded so the reasoning and numbers survive, and
so a future change starts from evidence instead of re-deriving it.

Source: `trade-log/*.csv`, 1,485 closed trades (1,397 after excluding 88 margin-call artifacts),
harvested 2026-07-24 across 141 symbol/timeframe combinations. Reproduce with
`node scripts/backfill_trade_log.js` then the analysis scripts referenced below.

---

## 1. The strategy has no stop at all

`src/strategy.pine` contains zero `strategy.exit()` calls. The only exit is `strategy.close()` on a
swing-direction flip. `trail_pct: 2.0` in `rules.json` is a setting in the *scanner*, not something
the Pine strategy implements — nothing enforces it.

This is the mechanical reason losing positions run to −30%/−50%: nothing closes them until the swing
flips. Any stop discussed below would be **advisory** — surfaced in the dashboard and ntfy for
manual action — unless the Pine script itself is changed.

## 2. Why not profit factor, and why not strategy drawdown

- **Profit factor** is a unitless ratio of gross profit to gross loss. It contains no price and no
  percentage, so no stop distance can be derived from it. It measures whether a strategy is worth
  trading, not where to exit a position.
- **`maxStrategyDrawDownPercent`** is an *equity-curve* property of the whole account across its
  full history. Using it as a per-trade level conflates portfolio drawdown with how far one
  position moved against its own entry. A rule like "avg DD + 3%" mixes the two.

The correct basis is **Maximum Adverse Excursion (MAE)** — how far an individual trade went against
the entry before resolving. It is logged per trade as `mae_pct`.

## 3. MAE separates winners from losers cleanly

Percent adverse excursion before the trade resolved:

| TF | winners: med / p90 / **p95** | losers: med / p75 |
|---|---|---|
| 15m | 1.4 / 4.7 / **6.2** | 6.2 / 8.8 |
| 30m | 2.2 / 9.3 / **13.1** | 9.8 / 19.2 |
| 45m | 1.7 / 7.9 / **9.7** | 9.2 / 13.6 |
| 1H | 2.3 / 9.5 / **12.0** | 13.0 / 16.6 |
| 2H | 3.3 / 11.1 / **15.7** | 12.4 / 21.5 |
| 3H | 2.2 / 8.1 / **12.2** | 13.1 / 20.6 |
| 4H | 3.4 / 12.3 / **16.1** | 17.0 / 24.9 |
| 1D | 6.9 / 21.5 / **32.5** | 24.8 / 37.5 |

Losers dip 3–5× deeper than winners at every timeframe. The separation is real.

## 4. But every fixed stop tested REDUCES expectancy

Simulated conservatively: any trade whose MAE reaches the stop exits at exactly `-stop`.

| TF | no stop (%/trade) | best stop tested | cost |
|---|---|---|---|
| 15m | 1.98 | −20% | ±0.00 |
| 30m | 2.52 | −20% | −0.46 |
| 45m | 1.45 | −20% | −0.22 |
| 1H | 2.67 | −20% | −0.18 |
| 2H | 3.45 | −20% | −0.88 |
| 3H | 5.07 | −20% | −0.97 |
| 4H | 5.78 | −20% | −1.33 |
| 1D | 11.06 | −20% | −3.85 |

At every timeframe the best stop is the **widest one tested**, and still no better than none. A −10%
stop on 4H would have cut 39 eventual winners. With a 77–83% win rate, this system's winners
routinely dip and recover; tight stops shred them.

**A stop here is catastrophe insurance, not an edge enhancer.** Realized tail already reaches −47%
(2H), −50.6% (4H), −52.6% (1D).

Recommended level if adopted: **winners' p95 MAE per timeframe** (bold column above) — spares 95% of
historical winners while capping the tail. Refine with a symbol's own p95 when it has ≥10 winning
trades, falling back to the timeframe figure (per-symbol alone is too noisy at 5–15 trades).

## 5. Pyramid 25% at that level, then stop below

Proposal evaluated: on reaching the p95-MAE level, add 25% to the position, then place a stop below.

Mechanics per trade — entry 100, worst excursion `−m`, exit `+r`; the added tranche is bought at
`100 − L` so its return is `(r + L) / (1 − L/100)`; a stop at `S` closes both tranches.

**Trades that reach the add level do usually recover past it:**

| TF | add @ | reached | recovered | avg final return |
|---|---|---|---|---|
| 15m | −6% | 21/130 | 90% | −1.96% |
| 1H | −12% | 27/168 | 89% | −4.01% |
| 3H | −12% | 35/222 | 91% | −0.88% |
| 4H | −16% | 45/285 | 93% | −3.66% |
| 1D | −33% | 18/165 | 94% | −8.89% |

Note "recovered" means *finished better than the add level*, not *finished profitable* — average
final return is negative in every row. The exit is simply better than the deepest dip, which is
close to tautological for a strategy that exits on a flip rather than at the bottom.

**Aggregate across 1,397 trades** (perTrade in base-position units; perCap per unit of capital
committed):

| variant | perTrade | perCap | win% | worst | <−10% | <−20% |
|---|---|---|---|---|---|---|
| baseline (no add, no stop) | 4.65 | 4.65 | 80 | −52.6 | 40 | 13 |
| **add 25% at level, no stop** | **5.12** | **4.94** | 82 | −60.9 | 28 | 11 |
| add 25%, stop 1.5× level | 4.40 | 4.25 | 81 | −56.3 | **68** | **35** |
| add 25%, stop 2× level | 4.75 | 4.59 | 82 | **−78.3** | 44 | 31 |
| stop at level only | 3.11 | 3.11 | 76 | −33.0 | 168 | 18 |

Add levels: 15m −6%, 30m −13%, 45m −10%, 1H −12%, 2H −16%, 3H −12%, 4H −16%, 1D −33%.

### The combination is the worst part

Pyramiding alone improves return (+10% per trade). **Adding the stop on top makes it worse than
doing nothing** — 4.40 vs 4.65 baseline — and roughly triples the tail: 68 trades below −10% and 35
below −20%, against 40 and 13 for baseline.

The reason is mechanical: after pyramiding you hold 125% of a position. Getting stopped then
realises the stop distance on 125% instead of 100%. The stop converts the pyramid's larger position
into a larger loss, which is the martingale trap. Widening the stop to 2× pushes the worst single
trade to **−78.3%**.

### The pyramid's advantage is largely survivorship

The table above is **closed trades only**. Fifteen positions are currently open and already deeper
than their add level — exactly the trades where pyramiding does maximum damage, and exactly the
trades this dataset cannot see:

| position | open % | add @ | tranche return | drag on base |
|---|---|---|---|---|
| KORU\|3H | −52.6 | −12% | −46.1% | −11.5% |
| AGQ\|4H | −41.6 | −16% | −30.5% | −7.6% |
| SOXL\|2H | −40.8 | −16% | −29.5% | −7.4% |
| BE\|3H | −30.8 | −12% | −21.3% | −5.3% |
| BE\|2H | −33.9 | −16% | −21.3% | −5.3% |
| SOXL\|4H | −28.2 | −16% | −14.5% | −3.6% |
| JNUG\|4H | −27.2 | −16% | −13.3% | −3.3% |

Across all 15, pyramiding would carry **an extra −55.1%** of loss in base-position units, averaging
−3.7% per affected position. Because winners close and losers stay open, any analysis restricted to
closed trades systematically flatters a strategy of adding to losers.

## 5b. Time stop — the strongest separator found

Holding period discriminates winners from losers far more cleanly than MAE does.

**Bars held, winners vs losers.** "Overlap" is the share of losers that finished within the
winners' p75 bar count — low overlap means the two populations barely intersect:

| TF | W med / p75 | L med / p75 | ratio | overlap |
|---|---|---|---|---|
| 15m | 40 / 56 | 98 / 123 | 2.45× | 4% |
| 30m | 49 / 63 | 94 / 114 | 1.92× | 17% |
| 45m | 48 / 69 | 85 / 124 | 1.77× | 36% |
| 1H | 43 / 61 | 111 / 148 | 2.58× | 3% |
| **2H** | 45 / 56 | 106 / 129 | 2.36× | **0%** |
| 3H | 38 / 52 | 90 / 120 | 2.37× | 7% |
| 4H | 40 / 56 | 91 / 110 | 2.27× | 8% |
| 1D | 44 / 61 | 93 / 121 | 2.11× | 14% |

At 2H, **not one** losing trade closed within 56 bars. Compare with MAE, where winners' p95 sat
above losers' median at several timeframes — heavy overlap.

**Outcome by holding-period quartile** (each timeframe normalised to its own quartiles, pooled):

| Q | n | win% | avg ret | avg MFE | avg MAE | giveback | share of P&L |
|---|---|---|---|---|---|---|---|
| Q1 (quickest) | 360 | 99% | +8.45% | 9.3 | 1.9 | 0.9 | 47% |
| Q2 | 353 | 99% | +8.18% | 9.2 | 4.8 | 1.0 | 44% |
| Q3 | 341 | 81% | +4.12% | 6.1 | 8.3 | 2.0 | 22% |
| Q4 (longest) | 343 | **39%** | **−2.46%** | 4.7 | 13.4 | **7.2** | **−13%** |

The fastest half of trades produces 91% of all P&L at a 99% win rate. The slowest quarter is
net negative and gives back 7.2 points of favourable excursion before exiting.

**Conditional on still holding at bar N** — the question a live time stop actually faces:

P(eventual win | still open at bar N):

| TF | base | N=40 | N=50 | N=60 | N=70 | N=100 |
|---|---|---|---|---|---|---|
| 15m | 78 | 65 | 54 | 42 | 34 | 18 |
| 1H | 80 | 71 | 61 | 53 | 46 | 29 |
| 2H | 77 | 68 | 53 | 43 | 35 | 18 |
| 3H | 82 | 67 | 57 | 46 | 38 | 33 |
| 4H | 81 | 68 | 58 | 48 | 44 | 29 |
| 1D | 83 | 73 | 64 | 58 | 52 | 28 |

E[final return | still open at bar N]:

| TF | base | N=40 | N=50 | **N=60** | N=70 | N=100 |
|---|---|---|---|---|---|---|
| 15m | 2.0 | 0.6 | −0.1 | **−0.9** | −1.3 | −2.5 |
| 1H | 2.7 | 1.0 | 0.0 | **−0.7** | −1.4 | −3.1 |
| 2H | 3.5 | 1.0 | −0.9 | **−1.8** | −2.6 | −6.7 |
| 3H | 5.1 | 2.2 | 1.1 | **−0.9** | −2.3 | −4.4 |
| 4H | 5.8 | 2.9 | 1.1 | **−1.4** | −2.7 | −5.9 |
| 1D | 11.1 | 6.3 | 3.9 | **+0.7** | −0.5 | −11.4 |

**Expected value crosses zero at bar 50–60 on every timeframe.** That consistency is not a
coincidence: the strategy's `swingLen` input is **50**, so `ta.highest(50)` / `ta.lowest(50)` defines
its entire structure. A trade that has not resolved within roughly one swing-lookback window is a
setup that failed to confirm. The time stop and the signal logic are measuring the same thing.

This is not a thin tail — at N=60, 33–43% of trades are still open.

### What is and isn't established

Rigorous, because it conditions on survival rather than on price path: holding period predicts
outcome, the crossover sits at 50–60 bars, and it aligns mechanically with `swingLen`.

**Not** established: the P&L of actually exiting at bar N. The log has no bar-by-bar path, so the
position's value *at* bar N is unknown. This matters more than it first appears — Q4 trades average
13.4% MAE but only −2.46% final, meaning long trades typically recover substantially from their
worst point. A rule of "exit at bar N if underwater" could therefore fire exactly where holding is
better. The naive-looking rule may be backwards.

Resolving it needs bar-level data: for each trade, the close at `entry_bar + N`. `data_get_ohlcv`
caps at 500 bars, which covers roughly 4 months at 4H and under a month at 15m — a recent, likely
unrepresentative slice. A properly powered test needs a bar source without that ceiling, which is
what the planned move off TradingView would provide.

## 6. Verdict

- **Pyramid + stop (as proposed): do not adopt.** Worse than baseline on return *and* materially
  worse in the tail. The two components fight each other.
- **Pyramid alone:** attractive on closed trades (+10%), but the gain is concentrated in trades that
  eventually recover, and the measured set excludes the never-recovering ones. Treat the +10% as an
  upper bound that would shrink — possibly past zero — with open positions included.
- **Stop alone at p95 MAE:** costs expectancy, buys tail control. Defensible purely as risk
  management, not as an improvement.
- **Time stop: the most promising of the three, and the least proven.** Holding period separates
  winners from losers far better than MAE (§5b) — 0% overlap at 2H, versus heavy overlap for MAE —
  and expected value turns negative at bar 50–60 on every timeframe, matching `swingLen = 50`.
  What remains unproven is the exit price at bar N, and the Q4 recovery pattern (13.4% avg MAE
  → −2.46% avg final) means the obvious "exit if underwater at N" rule could be backwards. Needs
  bar-level data before implementing.
- **Cheapest next step, no new data required:** treat bars-held as a *ranking* signal rather than a
  hard exit. Surfacing "bars held / expected-value crossover" per open trade in the dashboard
  flags decaying positions without committing to an exit rule that hasn't been validated.

## 7. Limitations that apply to everything above

1. **Excursion ordering is unknown.** The log records each trade's MAE and MFE but not which came
   first. A trade that ran +9% then sagged −5% is indistinguishable from one that sagged −5% first.
   Every simulation assumes the adverse excursion triggers the rule, which is conservative for
   stops and *optimistic* for pyramids (a pyramid needs the dip to come before the recovery).
2. **Closed trades only.** Open positions are absent, and they are disproportionately losers.
   Section 5 quantifies this for the pyramid; it applies in the other direction to stops, whose
   value is understated.
3. **No intra-trade path.** Fills are assumed at exactly the trigger level, with no slippage or gap
   through the level. Real stops on leveraged ETFs gap.
4. **Position sizing changed 2026-07-24** (`default_qty_value` 100 → 95) to eliminate margin-call
   artifacts. Percentage columns are fractions of position value and unaffected; USD columns are
   not comparable across that boundary.

## 8. Reproducing

Analysis scripts live in the session scratchpad, not the repo. The inputs are all in
`trade-log/*.csv` and `status/strategy-perf.json`:

- MAE percentiles and the stop sweep — group `mae_pct` by `pnl_pct > 0`, then simulate
  `pnl_pct := -stop` for every row with `mae_pct >= stop`.
- Pyramid — add a tranche of `addFrac` at `-L`, tranche return `(pnl_pct + L) / (1 - L/100)`.
- Open-position drag — `status/strategy-perf.json` → `openPLPercent`, filtered to
  `openPLPercent * 100 < -L`.
