import { Chalk } from 'chalk'

import { displayWidth } from './format.js'

export type TableColumn = { header: string; right?: boolean }

// Visible width, ignoring ANSI color codes, so padding stays aligned. Measured
// in terminal cells rather than characters, so a translated (CJK) header keeps
// its column square; identical to the character count for ASCII.
function vlen(s: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\[[0-9;]*m/g, '')
  return displayWidth(plain)
}

// Box-drawing table with roomy 2-space cell padding, right-aligned numeric
// columns, and optional bold rows (e.g. a Combined/total row). Color is
// auto-detected; pass color:false to force plain text.
export function renderTable(
  columns: TableColumn[],
  rows: string[][],
  opts: { color?: boolean; boldRows?: ReadonlySet<number> } = {},
): string {
  const c = new Chalk(opts.color === false ? { level: 0 } : {})
  const bold = opts.boldRows ?? new Set<number>()
  const widths = columns.map((col, i) => Math.max(vlen(col.header), ...rows.map((r) => vlen(r[i] ?? ''))))
  const pad = (s: string, w: number, right?: boolean): string => {
    const fill = ' '.repeat(Math.max(0, w - vlen(s)))
    return right ? fill + s : s + fill
  }
  const gap = '  '
  const sep = gap + '│' + gap
  const bar = (l: string, mid: string, r: string): string => l + widths.map((w) => '─'.repeat(w + 4)).join(mid) + r
  const line = (cells: string[], makeBold: boolean): string =>
    '│' + gap + columns.map((col, i) => {
      const padded = pad(cells[i] ?? '', widths[i]!, col.right)
      return makeBold ? c.bold(padded) : padded
    }).join(sep) + gap + '│'
  return [
    bar('┌', '┬', '┐'),
    line(columns.map((col) => col.header), false),
    bar('├', '┼', '┤'),
    ...rows.map((r, i) => line(r, bold.has(i))),
    bar('└', '┴', '┘'),
  ].join('\n')
}
