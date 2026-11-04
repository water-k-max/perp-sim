# QuantGrip — reverse-engineered functional spec for perp-sim

Source: quantgrip.com (landing page, FAQ structure, pricing, and the client bundle that ships
the landing page's embedded demo analysis — chunk `3q-undi5gl_o4.js` — plus its network
surface). Everything below is a functional description in our own words, reconstructed by
driving the site and reading the bundle's code paths, field names and UI strings. No assets,
copy or code were copied from the site. This spec describes *what to build*, not what they
wrote; our implementation runs on perp-sim's own engine and dreamDEX data.

QuantGrip answers one question: a backtest is a single path through a trade sequence — what
does the *distribution* over paths look like if the same trades had happened in other
plausible orders? It takes a strategy's trade-by-trade result list, reshuffles it thousands
of times, and reports the spread of equity outcomes, drawdowns, streaks and ruin odds, plus
an audit of where the backtest's own assumptions flatter the result.

---

## 1. Product surface (observed)

Stack, from the network trace: Next.js app (Turbopack chunks), Clerk auth (`clerk.quantgrip.com`,
JWT `Authorization` on API calls), PostHog analytics, Plotly-style client charts (trace
strings `tozeroy`/`tonexty`, `spline`, mode-bar buttons in the bundle), analyses persisted
per user with a stored seed and a client-side per-strategy cache.

Plans (observed copy, summarized): free tier = 3 analyses / 30 days, one strategy, 1,000
resample paths; Starter $12.99 = 50 analyses/mo, up to five strategies per run, sizing and
out-of-sample modules; Pro $34.99 = 5,000 paths, forward testing, prop-evaluation simulator,
portfolio view. We are a local, free tool: no gating, but keep path counts configurable.

App flow: export a strategy's trade list from TradingView → upload (drag) → analysis
renders → every analysis is saved with its seed so it can be re-opened and compared after
strategy tweaks. A landing-page demo embeds the app's own components against a canned
result and links to a "full view" with the raw result JSON at the bottom.

---

## 2. Input object model

**Trade record** (one row of the strategy's trade list). Fields the engine relies on:

| field | meaning |
| --- | --- |
| `entryTs`, `exitTs` | open/close times (they bin these into chart bars) |
| `pnl` | realized PnL of the closed trade, in account currency |
| `direction` | long / short |
| `barsHeld` | bars between entry and exit; 0 ⇒ "same-bar" trade |
| `mae`, `mfe` | max adverse / favourable excursion of the position (their export carries an adverse-excursion figure; rows missing it are counted separately) |

**Same-bar detection** is the audit's foundation: a trade whose entry and exit fall inside
one chart bar was priced by the bar's OHLC *path assumption*, not by observed data. Their
detector flags `barsHeld === 0` (plus "went against the position" for the re-pricing variant,
decided from pnl sign vs. excursion figures).

TradingView's "List of trades" CSV is their canonical import; our equivalent input is
perp-sim's own closed-trade list, which is *better* data: we hold the tape slices and hourly
candles, so we compute `mae`/`mfe` ourselves instead of trusting an exporter.

---

## 3. Resampling engine (the core)

Two user-selectable modes, both seeded, stored with the analysis:

- `shuffle_without_replacement` — permutation of the trade sequence. Preserves the exact
  multiset of trades; answers "was the *order* lucky?"
- `bootstrap_with_replacement` — i.i.d. draws from the trade list. Answers "what if the
  realized trades are a sample from a wider behaviour distribution?"

The UI exposes both, and the analysis computes **both** and shows them side by side
(their component takes `shuffleResult` and `bootstrapResult`).

For each of `N` paths (1,000 free / 5,000 pro; ours: configurable, default 1,000):
1. draw an order of the trade list per the selected mode, using the path's PRNG stream;
2. walk the sequence at the chosen **sizing** mode:
   - `static` — fixed size per trade (their "fixed size per contract"; ours: fixed base
     units, floored to the market lot);
   - `compound` — equity compounds (size re-derived from running equity, capped);
3. accumulate equity; track per path: final equity, max drawdown (depth, % of capital at
   start; their table measures "losing" from the account's start at the worst point along
   the path, not from a later high), max losing streak (consecutive pnl < 0), whether the
   path ever goes to/below zero (`bankruptcy`), and the running path curve.

`horizon` (path length in trades) is a parameter independent of the trade count — paths can
be longer or shorter than the history.

**Determinism contract:** the seed produces the whole run; same seed ⇒ identical output.
This matches perp-sim's existing `runId`/`configHash` discipline — the seed joins the hash.

---

## 4. Distribution outputs (their field names, observed in the bundle)

Per mode (`shuffle` / `bootstrap`), over all paths' finals:

```
final_equities[]              // one number per path — raw material for everything below
median_final_equity
percentile_5_final_equity     // labelled VaR in the UI
percentile_10/25/50/75/90/95_… // band ladder for the fan chart
bankruptcy_rate               // share of paths that hit zero
median_max_drawdown           // and percentile_95_max_drawdown, % of starting capital
median_max_losing_streak      // and percentile_95_max_losing_streak, in trades
```

Client-side derived stats they compute from `final_equities`: **CVaR** = mean of the worst
5% of finals; 95% CI = p5…p95. The summary header shows median, p5 (VaR), CVaR.

**Charts (observed):**
- *Fan chart*: quantile bands p10–p90 (outer), p25–p75 (inner), median line, per trade step;
  `tonexty` fills between bands; the **original backtest path** drawn on top ("then the real
  one") — the single path versus its distribution is the product's whole point.
- *Drawdown density*: distribution of per-path max drawdown.
- *Streak histogram*: distribution of per-path max losing streak.
- *Finals histogram* with a marker at the actual backtest's final.

---

## 5. Backtest-optimism audit ("where your backtest is kinder than live")

Header figure: **same-bar trade share** — trades decided inside one bar, `same_bar / total`.
Shown beside two sourced reference points, and an honest bound note: a longer trade whose
*final* bar holds both stop and target is the same problem and is **undetectable from the
export** (no stop level ships with it) — the count is what can be counted, not a bound.

- `dismissal_share`: above a threshold share they label the strategy *not reliably
  backtestable* (a hard verdict line, configurable).
- `without_excursion`: same-bar rows missing an excursion figure — cannot be re-priced;
  counted and disclosed.
- **"Gone the other way" re-run**: move every same-bar trade that went against the position
  to the *worst price the position saw* (from its excursion figure), leave everything else
  untouched, and re-run the whole distribution. Both curves render side by side. This is a
  bounded worst-case, not a claim about what happened.

**Assumptions checklist** ("What this assumes"): the exporter settings that quietly flatter
results — recalculate-on-every-tick, no bar-magnifier on short timeframes, no commission,
no slippage — each rendered as one line explaining its live-fill consequence. Rendered from
the analysis, never silently applied.

*perp-sim mapping:* our analogs are explicit run-config facts: `fillModel=tape` profile
(optimistic flatters), `latency=0`, `gas=0`, and `model=settlement-mark` itself (fills priced
at a mark nobody traded at). Same-bar analog: entry and exit fill windows inside one
settlement interval. We can go one further than they can: we have the tape, so the "worst
price the position saw" re-pricing can use *observed* extremes, not exporter figures.

---

## 6. Sizing module — "how many contracts, for the loss you'd accept"

Input: the maximum loss the user will accept. For each candidate size (their unit:
contracts; ours: base units on the lot grid, plus a leverage sanity note), simulate the
first `horizon` trades (they use the first hundred) of every resampled path at fixed size
and report:

```
contracts            // the size row
loss_probability     // P( path's worst point from start is deeper than the accepted loss )
median_pnl, p5_pnl   // outcome summary at that size
```

Rows past even-money odds are dropped (their table note). The sizing stays the user's call;
the odds sit beside it. A "Drawdown threshold" input and a "Profit factor" readout appear
in the same panel (observed strings), alongside the sizing mode selector
(static / compound / capped).

---

## 7. Out-of-sample module ("on your own backtest")

1. Hold back the **tail** of the trade list (fraction parameter).
2. Resample the **fit** trades (with replacement, fixed size) and draw a boundary: the 95th
   percentile of the fit-half path finals — "one healthy strategy in twenty crosses a 5%
   boundary by chance" is their stated calibration.
3. Replay the **held-back** trades as if they were the first live ones, cumulative
   (`held_curve[]`, final minus `start` reported).
4. Verdict framing (theirs, and worth keeping verbatim in spirit): staying inside is *not*
   proof of an edge; crossing is a reason to investigate what changed, before money is at
   risk. Both halves come from the same export, so both inherit its biases.

---

## 8. Forward-test module (their Pro; perp-sim variant is different)

Theirs: a private per-user webhook address; TradingView alerts POST each real-time fill;
each lands against the stored backtest band, so bar-assumption errors show up in a few
dozen trades.

Ours has no TradingView, but a better native source: **replay live fills** — poll a public
testnet account's `PerpPositionChange` rows (the `replay-account` path already exists) and
plot each realized fill against the stored resample band from the same strategy config.
Read-only, no alerts, no webhook, no keys. Mark this phase optional/stretch; it needs a
persistent account to watch and a stored band to compare against.

---

## 9. Prop-evaluation simulator (their Pro)

Inputs (a rules form): drawdown mode (`static` / `trailing_eod` / `trailing_intraday`,
plus whether drawdown **locks** at a high-water mark), daily loss limit, phases with profit
targets and consistency caps, payout cadence (`monthly` / `one_time`) and fees.

Engine inputs: per-day aggregated trade PnL plus per-trade MAE/MFE (`trade_days`,
`trade_pnls`, `trade_mae`, `trade_mfe`) so intraday breach odds can be estimated, not just
EOD. Each resampled path is a simulated evaluation: outcomes are funded / breach (with the
breaching rule) / lockout / idle; outputs: share of runs funded, trades-to-fund distribution,
expected resets, average month and bad-month payouts after fees.

They are careful to say it replays the strategy's *own* trading days against typed-in rules,
predicts nothing about any firm's challenge. Keep that framing.

---

## 10. Multi-strategy compare + persistence

- Up to five analyses side by side; per-mode comparison table (observed metrics table:
  median return, 5th-pct return, bankruptcy rate, median & p95 max drawdown, median & p95
  max losing streak — `bestIs: max/min` per row drives highlighting).
- Portfolio view (combine strategies' paths into one account; their Pro).
- Analyses persist with `strategyId`, `seed`, and a **named** cache; rename collisions
  raise an explicit overwrite dialog (observed: Save / Overwrite / Cancel). Ambiguous or
  stale cached results are flagged (`ambiguity` in the bundle).

---

## 11. Reconstructed result JSON (the shape our implementation should target)

```jsonc
{
  "meta": { "seed": 0, "paths": 1000, "horizonTrades": 100, "mode": "both",
            "sizing": "static", "source": "run <runId> / trade list", "createdAt": "…" },
  "input": { "tradeCount": 0, "sameBarCount": 0, "withoutExcursionCount": 0,
             "dismissalShare": 0.0, "window": { "from": 0, "to": 0 }, "market": "BTC" },
  "assumptions": ["…"],                       // one line each, rendered verbatim in UI
  "shuffle": { /* Distribution block */ },
  "bootstrap": { /* Distribution block */ },
  "Distribution block": {
    "finalEquities": ["…"], "medianFinalEquity": "…", "p05FinalEquity": "…",
    "p10FinalEquity": "…", "p25FinalEquity": "…", "p50FinalEquity": "…",
    "p75FinalEquity": "…", "p90FinalEquity": "…", "p95FinalEquity": "…",
    "cvar95": "…", "bankruptcyRate": "0.000",
    "medianMaxDrawdownBps": 0, "p95MaxDrawdownBps": 0,
    "medianMaxLosingStreak": 0, "p95MaxLosingStreak": 0,
    "fan": [{ "step": 0, "p10": "…", "p25": "…", "p50": "…", "p75": "…", "p90": "…" }]
  },
  "audit": { "sameBarShareBps": 0, "repricedFinalEquities": ["…"],
             "repricedMedianDeltaBps": 0, "notes": ["…"] },
  "sizing": [{ "sizeBase": "…", "lossProbability": "0.000",
               "medianPnl": "…", "p05Pnl": "…", "acceptedLoss": "…" }],
  "oos": { "holdbackFraction": 0.3, "boundary": "…", "heldCurve": ["…"],
           "heldFinalMinusStart": "…", "crossed": false },
  "warnings": ["…"], "invariants": { /* same shape as the engine's */ }
}
```

Money fields: exact bigint internally, decimal strings at the edge — same rule as the rest
of perp-sim. Probabilities: fixed-point decimal strings (`0.000`) to keep the JSON
deterministic for hashing.

---

## 12. What we deliberately do differently

1. **Source data.** They ingest an exporter's CSV; we generate the trade list from our own
   replay (closed trades with observed MAE/MFE from hourly candles and tape slices). Their
   undetectable case (stop+target inside one final bar) remains undetectable for
   settlement bars, but our audit can *bound* it with tape extremes — disclose that too.
2. **No accounts, no gating, no uploads.** Single local app; the "upload" step becomes
   "configure and run" against the existing engine; analyses persist in the existing run
   store keyed by `seed + configHash`.
3. **Exact money.** Their bundle works in floats; perp-sim's rule is exact bigint with a
   zero-residual attribution identity — resampling inherits it (paths are integer-unit
   accumulations of exact trade PnLs; percentile interpolation is the only float step,
   done at the API edge on decimals).
4. **Charts.** No Plotly (heavyweight, violates the lean esbuild bundle); quantile bands
   render in the existing hand-rolled SVG chart component (it already handles axis gutter,
   resize observer, a11y titles).
5. **Additive oos fields (implementation deviation, Phase 6).** The §11 `oos` block also
   carries `fitSeqs` and `heldSeqs` (trade seqs per half). The spec's shape cannot be
   checked for no-lookahead from the artifact alone; exposing the seqs lets the
   `oos-no-lookahead` invariant verify disjointness and ordering from the stored document.
   Nothing else in the shape changes.
6. **Additive prop block (Phase 8).** The §11 document gains an optional `prop` block when
   (and only when) the request carries a prop rules form. It replays aggregated trading
   days (UTC-day PnL plus an observed-excursion intraday low) against typed-in rules;
   intraday breach odds are estimated from observed excursions, never worse, and idle is
   not estimable from trading days alone so its share stays zero and says so. A
   `prop-bounds` invariant checks outcome shares sum to one and payouts exist exactly
   when some path funds.
