# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Investr is a personal, single-user investment-tracking app — a sibling project to `budgetr`, same philosophy: **no build step, no package manager, no backend**. Plain HTML/CSS/JS:

- `index.html` — the whole DOM shell (three-panel layout + status bar)
- `js/app.js` — the entire application, vanilla JS, no framework
- `css/styles.css` — component styles (semantic variables)
- `css/tokens.css` — color primitives, shared verbatim with `budgetr` (`design-tokens/color-tokens.json`, a Figma export)
- `icons/` — SVG icons referenced via `<img>`, copied from `budgetr`'s generic set (chevrons, close, collapse, search, plus, delete, placeholder) — no investr-specific nav icons yet

There is nothing to install and nothing to compile.

## Running it

Open `index.html` directly in a browser, or serve the directory statically:

```bash
python3 -m http.server
```

No test suite, linter, or build/watch command, no CI.

## Data model and persistence

No server, no `localStorage`/IndexedDB — all state lives in memory (`ACTIVITY`, a flat deduped array of transaction rows) and is lost on reload unless explicitly saved.

- **Import**: `parseFidelityActivityCSV` expects a Fidelity **`History_for_Account_*.csv`** export (not the Full View budgeting export `budgetr` reads) — verified against a real single-account export. Header: `Run Date, Action, Symbol, Description, Type, Price ($), Quantity, Commission ($), Fees ($), Accrued Interest ($), Amount ($), Cash Balance ($), Settlement Date`, preceded by two blank lines. There's no Account column on a single-account export — the account number is recovered from the filename instead (`History_for_Account_Z12345678.csv`). The parser locates the header row by scanning for one containing both "Run Date" and "Action", then maps columns by substring match so order/renames don't break it. Only Run Date, Action, and Amount are required; everything else degrades gracefully if absent. Rows whose date column doesn't parse are silently skipped — this is what drops the disclaimer/footer boilerplate Fidelity appends after the data, so don't "fix" it into a hard stop.
  The Action column is a full sentence (`"YOU BOUGHT SPACE EXPL TECHNOLOGIES CORP CL A (SPCX) (Cash)"`), not a short code — `actionLabel()` pulls out just the leading verb phrase (against a known-phrase list, falling back to truncating at the first `"("`) for display in the Activity table and right panel, since the full sentence duplicates the Symbol/Description columns already shown alongside it.
  Still unverified: a **multi-account** export (would have an actual Account column — untested) and whatever Fidelity's full-year (not YTD) export looks like at the boundary where it switches months/years.
- **Running tab**: imported rows merge into `ACTIVITY` with dedup on `(date, account, action, symbol, amount, quantity, description)`, so re-importing an overlapping export is safe.
- **Save/Load**: `saveJSON()` downloads `{ version, savedAt, activity }`; `loadJSONFile()` reads that shape back in (replacing `ACTIVITY`, not merging) and re-runs `recompute()`. This is the "keep a running tab you can reload later" mechanism — there's no auto-save.
- **Derived state**: `aggregate(activity)` produces `DERIVED`: `holdings` (one row per symbol — quantity and a cash-flow-based cost basis, summed from buy/sell rows only — note dividend reinvestment rows classify as `buy` since they add shares), `netInvestedSeries` (cumulative `-amount` over time, derived/approximate), `cashBalanceSeries` (Fidelity's own reported running cash balance per row — more trustworthy than `netInvestedSeries` since it's not something we computed, but it's settled cash only, not position value), and `byBucket` (totals grouped by action type via `ACTION_BUCKETS`: buy, sell, dividend, capital_gain, interest, fee, transfer, other). Recomputed via `recompute()` any time `ACTIVITY` changes.

### Known simplification — no live pricing

`costBasis` is **cash invested**, not current market value: there's no price feed, so "value over time" charts track money in/out, not portfolio worth. Lot-level cost basis (FIFO/specific-lot) isn't tracked either — sells just net against the running cost basis. Wiring in a price API (or manual price entry) to get real market-value and P/L charts is the obvious next step; don't assume `costBasis` means "what it's worth today" when extending the charts.

A YTD (or any date-bounded) export can contain a **sell with no matching buy** — the position was opened before the export's window. That shows up as a holding with negative quantity/cost basis (confirmed against a real YTD export: a handful of YieldMax ETFs sold in March had only dividend rows before that, no buys — the buys happened in a prior year not in this export). That's not a bug; it's a read on a partial window. Don't "fix" it by clamping to zero — the right fix, when it matters, is importing a full-history export so every symbol's buys are present.

## Rendering architecture

Same pattern as `budgetr`: no virtual DOM, direct DOM manipulation from global mutable state.

- `renderAll()` → `renderNav()`, `renderMid()`, `renderRight()`, `renderStatus()`, in that order, called after every state-changing action (import, load, nav click, row select, clear).
- `renderMid()` routes on `nav` (`'holdings' | 'activity' | 'charts'`) to `renderHoldings()` / `renderActivity()` / `renderCharts()`, each rebuilding its section's DOM from scratch.
- `renderRight()` shows transaction detail for `selectedSymbol` (set by clicking a Holdings or Activity row) and auto-expands the right panel when a symbol is selected, collapsing again when cleared.
- Charts are **plain inline SVG built by hand** (`buildLineChart`, `buildBarChart`) — no charting library, consistent with the no-build philosophy. If a chart need outgrows what a `<polyline>`/`<rect>` loop can reasonably do, revisit that decision rather than fighting it further.

## Design tokens

`css/tokens.css` and `design-tokens/color-tokens.json` are copied verbatim from `budgetr` so the two apps look like a matched pair. Don't hand-edit the primitives here — if the palette needs to change, change it in `budgetr` first and re-sync, the same "regenerate from Figma" rule budgetr's own CLAUDE.md documents.

## Status so far

This is a first-pass scaffold: CSV import (validated against a real Fidelity `History_for_Account_*.csv` export), JSON save/load, a Holdings table, an Activity log, and three basic charts (net invested over time, cash balance over time, net invested by holding). Not yet done: lot-level cost basis, any price feed for market value / real P&L, search/sort/filter on the Activity table, multi-account exports, and nav icons (budgetr's left-nav items use `<img>` icons; investr's currently don't).

**A real downloaded export should never be committed** — `.gitignore` excludes `*.csv` and `*.json` (except `design-tokens/*.json`) for exactly this reason. Use a small hand-built fixture (see the import test performed when this was scaffolded) for any future manual testing, and delete real exports from the repo directory after testing against them rather than relying solely on `.gitignore`.
