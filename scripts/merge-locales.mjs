#!/usr/bin/env node
// Merges per-area translation fragments into src/locales/<lang>.json.
//
//   node scripts/merge-locales.mjs <fragment-dir> [--lang zh-CN] [--write]
//
// A fragment is a flat JSON object of { "English key": "translation" }. Keys
// are English source text, so a key missing from the catalog renders as
// English rather than breaking. Reports conflicts (same key, different
// translation) and identity entries (translation === key) instead of silently
// picking one.
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const args = process.argv.slice(2)
const dir = args.find(a => !a.startsWith('--'))
const write = args.includes('--write')
const langIndex = args.indexOf('--lang')
const lang = langIndex >= 0 ? args[langIndex + 1] : 'zh-CN'
if (!dir) {
  console.error('usage: merge-locales.mjs <fragment-dir> [--lang zh-CN] [--write]')
  process.exit(1)
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'locales', `${lang}.json`)
const merged = {}
const source = {}
let conflicts = 0

for (const file of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
  } catch (err) {
    console.error(`  skip ${file}: ${err.message}`)
    continue
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (key in merged && merged[key] !== value) {
      console.error(`  conflict ${JSON.stringify(key)}: keeping ${JSON.stringify(merged[key])} from ${source[key]}, ignoring ${JSON.stringify(value)} from ${file}`)
      conflicts++
      continue
    }
    merged[key] = value
    source[key] = file
  }
}

// Every argument the key takes must survive translation, or the formatter
// silently drops one at runtime. A translation may reorder with explicit
// positions (`%2$s ... %1$s`), which is the whole point of supporting them, so
// compare argument slots rather than raw text: slot N must exist in the
// translation and carry the same conversion type as the key's Nth placeholder.
function slots(text) {
  const found = new Map()
  let auto = 0
  for (const [, position, kind] of text.matchAll(/%(?:(\d+)\$)?([sdf])/g)) {
    const index = position ? Number(position) - 1 : auto++
    // A repeated slot is fine as long as it keeps the same type.
    if (found.has(index) && found.get(index) !== kind) found.set(index, 'conflict')
    else if (!found.has(index)) found.set(index, kind)
  }
  return found
}
function argumentsMatch(key, translation) {
  const a = slots(key)
  const b = slots(translation)
  if (a.size !== b.size) return false
  for (const [index, kind] of a) if (b.get(index) !== kind) return false
  return true
}
const mismatched = Object.entries(merged).filter(([k, v]) => !argumentsMatch(k, v))
const identity = Object.entries(merged).filter(([k, v]) => k === v)

console.log(`${Object.keys(merged).length} keys, ${conflicts} conflict(s), ${identity.length} untranslated (identity), ${mismatched.length} placeholder mismatch(es)`)
for (const [k, v] of mismatched) console.error(`  PLACEHOLDER ${JSON.stringify(k)} -> ${JSON.stringify(v)}`)

if (write) {
  const sorted = Object.fromEntries(Object.keys(merged).sort().map(k => [k, merged[k]]))
  writeFileSync(out, JSON.stringify(sorted, null, 2) + '\n', 'utf-8')
  console.log(`wrote ${out}`)
}
if (mismatched.length > 0) process.exitCode = 1
