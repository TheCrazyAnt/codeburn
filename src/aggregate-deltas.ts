import { createHash } from 'crypto'
import type { CachedCall, CachedFile, CachedTurn } from './session-cache.js'
import type { ClassifiedTurn, ParsedTurn, TaskCategory } from './types.js'

/// Delta-tracked aggregation.
///
/// Every rollup this parser serves is derived from cached turns at query time:
/// `cachedTurnToClassified` re-runs `classifyTurn` over EVERY turn of EVERY
/// cached file on every run, so the aggregation cost scales with total history
/// rather than with what changed. On a 300-file corpus that is ~400ms per run
/// spent re-deciding facts about turns that have not moved since the last one.
///
/// The derivation is a pure function of a turn's own calls and user message
/// (see classifier.ts: category, retries, hasEdits and the skill sub-category
/// read `assistantCalls` and `userMessage`, nothing else — no date range, no
/// git branch, no neighbouring turn). So it is cached beside the turn it
/// describes and reused verbatim while that turn is unchanged:
///
///   - `unchanged` file  -> every turn keeps its derivation, nothing re-derives
///   - `appended` file   -> the cached prefix keeps its derivations; only the
///                          new turns (and the boundary turn the append merged
///                          into, via `withCalls`) derive again
///   - `modified`/`new`  -> the file re-parses, producing turns with no
///                          derivation, so the whole file derives again
///
/// The invariant that keeps this honest: a cached turn's derivation is dropped
/// the moment its call set changes. Rebuild such a turn through `withCalls`
/// and it cannot be forgotten.
export type TurnDerivation = {
  /// Single-letter keys: this lands once per cached turn in a shard that is
  /// already the largest thing this program writes.
  c: TaskCategory
  /// Skill sub-category. Absent when the turn used no skill.
  s?: string
  /// Retry count. Absent at 0 (the common case).
  r?: number
  /// Whether the turn edited anything. Absent when false.
  e?: true
}

const CATEGORIES: ReadonlySet<string> = new Set<TaskCategory>([
  'coding', 'debugging', 'feature', 'refactoring', 'testing', 'exploration',
  'planning', 'delegation', 'git', 'build/deploy', 'conversation',
  'brainstorming', 'general',
])

export function isTurnDerivation(v: unknown): v is TurnDerivation {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['c'] === 'string' && CATEGORIES.has(o['c'])
    && (o['s'] === undefined || typeof o['s'] === 'string')
    && (o['r'] === undefined || typeof o['r'] === 'number')
    && (o['e'] === undefined || o['e'] === true)
}

/** What a freshly classified turn contributes, in the form the cache stores. */
export function derivationOf(turn: ClassifiedTurn): TurnDerivation {
  return {
    c: turn.category,
    ...(turn.subCategory ? { s: turn.subCategory } : {}),
    ...(turn.retries ? { r: turn.retries } : {}),
    ...(turn.hasEdits ? { e: true as const } : {}),
  }
}

/** The classified turn a stored derivation stands for — the same object
 *  `classifyTurn` would have returned for this turn, without re-deciding it. */
export function applyDerivation(parsed: ParsedTurn, d: TurnDerivation): ClassifiedTurn {
  return {
    ...parsed,
    category: d.c,
    retries: d.r ?? 0,
    hasEdits: d.e === true,
    ...(d.s ? { subCategory: d.s } : {}),
  }
}

/** Rebuild a cached turn around a different call set. The derivation describes
 *  the calls, so it never survives the rebuild — every call-set change in the
 *  parser goes through here so that cannot be forgotten. */
export function withCalls(turn: CachedTurn, calls: CachedCall[]): CachedTurn {
  const { derived: _dropped, ...rest } = turn
  return { ...rest, calls }
}

/// The checksum stored beside a file's cached derivations, over exactly the
/// values a rollup reads from them (plus each turn's call count, so a turn
/// gaining or losing calls without re-deriving cannot check out). Truncated to
/// 128 bits: this guards against drift, not against an adversary.
export function derivedDigest(turns: readonly CachedTurn[], derivations: readonly (TurnDerivation | undefined)[]): string {
  const h = createHash('sha256')
  for (const [i, turn] of turns.entries()) {
    const d = derivations[i]
    h.update(d ? `${d.c}\u0000${d.s ?? ''}\u0000${d.r ?? 0}\u0000${d.e ? 1 : 0}` : '\u0000')
    h.update(`\u0000${turn.calls.length}\u0001`)
  }
  return h.digest('hex').slice(0, 32)
}

/** The digest of what a file currently carries. `null` when any turn is
 *  underived — a partial derivation (a date-ranged run only derives the turns
 *  it reports on) is not something later runs can check against. */
export function digestOfCachedFile(file: CachedFile): string | null {
  const derivations = file.turns.map(t => t.derived)
  if (derivations.some(d => d === undefined)) return null
  return derivedDigest(file.turns, derivations)
}

export type ParityFailure = { path: string; stored: string; rederived: string }

/// Parity gate. Re-derives one cached file from its raw turns and checks the
/// result against the digest stored when those derivations were written. It is
/// the only thing standing between a stale derivation (a classifier change, a
/// half-written shard, a delta applied to the wrong turn) and a wrong number
/// nobody would ever notice, so a mismatch is fatal to the whole reuse: the
/// caller re-derives everything this run and re-parses the offending file.
///
/// Cost is one file per run (~1-3ms on a 800-turn file), which is why it can
/// run on every warm parse rather than on a sampling schedule.
export function auditDerivedParity(
  candidates: readonly { path: string; file: CachedFile }[],
  rederive: (turn: CachedTurn) => TurnDerivation,
  pick: (n: number) => number = n => Math.floor(Math.random() * n),
): ParityFailure | null {
  const auditable = candidates.filter(c => c.file.derivedDigest !== undefined && c.file.turns.length > 0)
  if (auditable.length === 0) return null
  const chosen = auditable[Math.min(auditable.length - 1, Math.max(0, pick(auditable.length)))]!
  const stored = chosen.file.derivedDigest!
  // Two ways the reuse can be wrong, and both have to be closed: the
  // derivations no longer hash to the digest written with them (a tampered or
  // half-written entry), or they are intact but no longer what deriving
  // produces (the classifier moved under a cache nobody invalidated).
  const carried = digestOfCachedFile(chosen.file)
  if (carried !== null && carried !== stored) return { path: chosen.path, stored, rederived: carried }
  const rederived = derivedDigest(chosen.file.turns, chosen.file.turns.map(rederive))
  if (rederived === stored) return null
  return { path: chosen.path, stored, rederived }
}
