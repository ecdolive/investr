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

- **Import**: `parseFidelityActivityCSV` expects a Fidelity **activity/order history** export (not the Full View budgeting export `budgetr` reads). It locates the header row by scanning for one containing both "Run Date" and "Action" (handles a possible title line before it), then maps columns by substring match so column order/renames don't break it. Only Run Date, Action, and Amount are required; Symbol/Quantity/Price/etc. degrade gracefully if absent. Rows whose date column doesn't parse are silently skipped — this is what drops the disclaimer/footer text Fidelity appends after the data, so don't "fix" it into a hard stop.
  **This parser hasn't been validated against a real Fidelity export yet** — only against a hand-built fixture matching the documented column set. If the real file's headers or date format differ, fix `parseFidelityActivityCSV`/`parseActivityDate` rather than reshaping the CSV by hand.
- **Running tab**: imported rows merge into `ACTIVITY` with dedup on `(date, account, action, symbol, amount, quantity, description)`, so re-importing an overlapping export is safe.
- **Save/Load**: `saveJSON()` downloads `{ version, savedAt, activity }`; `loadJSONFile()` reads that shape back in (replacing `ACTIVITY`, not merging) and re-runs `recompute()`. This is the "keep a running tab you can reload later" mechanism — there's no auto-save.
- **Derived state**: `aggregate(activity)` produces `DERIVED`: `holdings` (one row per symbol — quantity and a cash-flow-based cost basis, summed from buy/sell rows only), `netInvestedSeries` (cumulative `-amount` over time, sorted by date), and `byBucket` (totals grouped by action type via `ACTION_BUCKETS`). Recomputed via `recompute()` any time `ACTIVITY` changes.

### Known simplification — no live pricing

`costBasis` is **cash invested**, not current market value: there's no price feed, so "value over time" charts track money in/out, not portfolio worth. Lot-level cost basis (FIFO/specific-lot) isn't tracked either — sells just net against the running cost basis. Wiring in a price API (or manual price entry) to get real market-value and P/L charts is the obvious next step; don't assume `costBasis` means "what it's worth today" when extending the charts.

## Rendering architecture

Same pattern as `budgetr`: no virtual DOM, direct DOM manipulation from global mutable state.

- `renderAll()` → `renderNav()`, `renderMid()`, `renderRight()`, `renderStatus()`, in that order, called after every state-changing action (import, load, nav click, row select, clear).
- `renderMid()` routes on `nav` (`'holdings' | 'activity' | 'charts'`) to `renderHoldings()` / `renderActivity()` / `renderCharts()`, each rebuilding its section's DOM from scratch.
- `renderRight()` shows transaction detail for `selectedSymbol` (set by clicking a Holdings or Activity row) and auto-expands the right panel when a symbol is selected, collapsing again when cleared.
- Charts are **plain inline SVG built by hand** (`buildLineChart`, `buildBarChart`) — no charting library, consistent with the no-build philosophy. If a chart need outgrows what a `<polyline>`/`<rect>` loop can reasonably do, revisit that decision rather than fighting it further.

## Design tokens

`css/tokens.css` and `design-tokens/color-tokens.json` are copied verbatim from `budgetr` so the two apps look like a matched pair. Don't hand-edit the primitives here — if the palette needs to change, change it in `budgetr` first and re-sync, the same "regenerate from Figma" rule budgetr's own CLAUDE.md documents.

## Status so far

This is a first-pass scaffold: CSV import, JSON save/load, a Holdings table, an Activity log, and two basic charts (net invested over time, net invested by holding). Not yet done: real validation against a live Fidelity export, lot-level cost basis, any price feed, search/sort/filter on the Activity table, and nav icons (budgetr's left-nav items use `<img>` icons; investr's currently don't).
