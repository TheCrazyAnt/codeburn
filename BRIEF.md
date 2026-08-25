Task: issue #1132 (read: gh issue view 1132). Branch: create feat/1132-reprice-preserved off main (pull first; main holds the 0.9.22 release commit).

## The problem
The daily cache preserves day-slices whose source files providers have deleted (durable history). The partial-survival guard correctly refuses to replace a preserved slice when a fresh parse has fewer calls - but that pins the slice's HISTORICAL prices. After repricing waves, source-dead days under-claim (measured: 2026-07-19 preserved $15.29/283 calls vs live-truth $28.86 for the surviving subset; ~$46 across 200 days).

## The fix
Preserved slices store per-model token counts. On the re-derive that runs after a DAILY_CACHE_VERSION bump (and ONLY then - not on ordinary launches), reprice each preserved source-dead slice through the current pricing tables from its stored tokens, per model. Never-lose rules (release-blocking):
- A model absent from current tables keeps its stored cost (never zero a priced slice).
- A slice without per-model token detail (pre-v15-era or provider without splits) keeps its stored cost untouched.
- Calls/tokens/counts never change - only the derived cost.
- Repricing must never LOWER a slice below... no: repricing follows the tables honestly in both directions (a price cut lowers it) - the never-lose rule is about data presence, not direction. State this in the changelog entry.
- The re-derive's guarded merges (#1129 completeness gates, partial-survival) are untouched for slices whose sources still exist - those already reprice via normal re-parse.

## Where
src/daily-cache.ts - the re-derive path and the merge guards from #1129/#1131. Study how slices store per-model tokens first (the v15+ per-project/per-model day stats). Bump DAILY_CACHE_VERSION per convention so the reprice runs once for everyone.

## Tests
- A preserved slice with stored tokens for a model whose price changed: cost moves to tokens x new rate; calls unchanged.
- Model missing from tables: cost untouched.
- Slice without token detail: untouched.
- Surviving-source slices: unaffected by this path.
- The #1129 guard tests all still green.

## Acceptance (reviewer runs on the real corpus)
After the version bump re-derive, the three known under-priced days move toward live-parse truth. Reviewer validates; you just make the suite green: npx vitest run (~3708+), npx tsc --noEmit. CHANGELOG entry into the "## 0.9.22 - 2026-08-25" section, house style, cite #1132, explain the honest-both-directions semantics. Commit on branch, push, STOP, no PR, don't commit BRIEF.md.
