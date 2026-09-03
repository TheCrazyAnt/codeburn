import type { Command } from 'commander'
import { readdir, stat, readFile } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'

import { t, tn } from '../i18n.js'

type Scope = { global?: boolean; project?: string }

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    const stdin = process.stdin
    if (stdin.isTTY) { resolve(''); return }
    let data = ''
    stdin.setEncoding('utf-8')
    stdin.on('data', c => { data += c })
    stdin.on('end', () => resolve(data))
    stdin.on('error', () => resolve(''))
  })
}

function usd(n: number | null): string {
  return n === null ? t('off') : `$${n}`
}

async function refreshFlags(): Promise<number> {
  const { parseAllSessions } = await import('../parser.js')
  const { buildFlags, writeFlags } = await import('./flags.js')
  const projects = await parseAllSessions()
  const flags = await buildFlags(projects)
  await writeFlags(flags)
  return flags.projects.length
}

async function doInstall(scope: Scope, statusline: boolean): Promise<void> {
  const { settingsPathFor, buildInstall } = await import('./settings.js')
  const { runAction } = await import('../act/apply.js')
  const { shortId } = await import('../act/journal.js')
  const { readGuardConfig, writeGuardConfig, guardConfigPath, DEFAULT_GUARD_CONFIG } = await import('./store.js')

  const path = settingsPathFor({ ...scope, cwd: process.cwd() })
  const built = buildInstall(path, { statusline })
  for (const note of built.notes) console.log(chalk.yellow(`  ! ${note}`))
  if (built.plan) {
    // Capture a trailing-14-day yield baseline so `act report` can correlate
    // the guard install against later yield. Best effort; a failure just
    // leaves the guard row "not measurable".
    try {
      const { captureGuardBaseline } = await import('../act/report.js')
      const baseline = await captureGuardBaseline({ cwd: process.cwd() })
      if (baseline) built.plan.baseline = baseline
    } catch { /* baseline is optional */ }
    const record = await runAction(built.plan)
    console.log('  ' + t('Installed %s  %s', chalk.bold(shortId(record.id)), built.plan.description))
    console.log(chalk.dim('    ' + t('Undo anytime: codeburn act undo %s', shortId(record.id))))
  } else {
    console.log(chalk.dim('  ' + t('%s: nothing to change.', path)))
  }

  if (!existsSync(guardConfigPath())) {
    await writeGuardConfig({ ...DEFAULT_GUARD_CONFIG, updatedAt: new Date().toISOString() })
    const c = await readGuardConfig()
    console.log(chalk.dim('  ' + t('Wrote guard.json (soft %s, hard %s, checkpoint %s).', usd(c.softUSD), usd(c.hardUSD), usd(c.checkpointUSD))))
  }

  try {
    const flagged = await refreshFlags()
    console.log(chalk.dim('  ' + tn('Flagged %d project for session openers.', 'Flagged %d projects for session openers.', flagged)))
  } catch (e) {
    console.log(chalk.yellow('  ! ' + t('could not compute session-opener flags: %s', e instanceof Error ? e.message : String(e))))
  }
}

async function doUninstall(scope: Scope): Promise<void> {
  const { settingsPathFor, buildUninstall } = await import('./settings.js')
  const { runAction } = await import('../act/apply.js')
  const { shortId } = await import('../act/journal.js')

  const path = settingsPathFor({ ...scope, cwd: process.cwd() })
  const built = buildUninstall(path)
  for (const note of built.notes) console.log(chalk.dim(`  ${note}`))
  if (built.plan) {
    const record = await runAction(built.plan)
    console.log('  ' + t('Uninstalled %s  %s', chalk.bold(shortId(record.id)), built.plan.description))
    console.log(chalk.dim('    ' + t('Undo anytime: codeburn act undo %s', shortId(record.id))))
  }
}

async function doStatus(): Promise<void> {
  const { readGuardConfig } = await import('./store.js')
  const { inspectInstall, settingsPathFor } = await import('./settings.js')
  const { readFlags, flagsAgeMs } = await import('./flags.js')

  const config = await readGuardConfig()
  console.log(chalk.bold('\n  codeburn guard'))
  console.log('    ' + t('soft cap:   %s', usd(config.softUSD)))
  console.log('    ' + t('hard cap:   %s', usd(config.hardUSD)))
  console.log('    ' + t('checkpoint: %s', usd(config.checkpointUSD)))
  console.log('    ' + t('openers:    %s', config.openerEnabled ? t('on') : t('off')))

  const locations = [
    { label: t('global'), path: settingsPathFor({ global: true }) },
    { label: t('project'), path: settingsPathFor({ cwd: process.cwd() }) },
  ]
  const found = locations
    .map(l => ({ ...l, info: inspectInstall(l.path) }))
    .filter(l => l.info.hooks.length > 0 || l.info.statusline)
  if (found.length === 0) {
    console.log('    ' + t('installed:  nowhere (run: codeburn guard install)'))
  } else {
    for (const l of found) {
      const bits = [...new Set(l.info.hooks)].join(', ')
      console.log('    ' + t('installed:  %s %s [%s]', l.label, l.path, `${bits}${l.info.statusline ? ', statusline' : ''}`))
    }
  }

  const flags = await readFlags()
  if (!flags) {
    console.log('    ' + t('flags:      none (run: codeburn guard refresh)'))
  } else {
    const ageDays = flagsAgeMs(flags) / 86_400_000
    console.log('    ' + tn(
      'flags:      %d project, %sd old',
      'flags:      %d projects, %sd old',
      flags.projects.length,
      flags.projects.length,
      ageDays.toFixed(1),
    ))
  }
  console.log()
}

async function doAllow(sessionId: string | undefined): Promise<void> {
  const { sessionsDir } = await import('./store.js')
  const { writeAllow } = await import('./usage.js')
  let id = sessionId
  if (!id) {
    const dir = sessionsDir()
    const names = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.json'))
    let newest = { at: -1, id: '' }
    for (const name of names) {
      const st = await stat(join(dir, name)).catch(() => null)
      if (!st) continue
      if (st.mtimeMs > newest.at) {
        try {
          const cache = JSON.parse(await readFile(join(dir, name), 'utf-8')) as { sessionId?: string }
          if (cache.sessionId) newest = { at: st.mtimeMs, id: cache.sessionId }
        } catch { /* skip unreadable cache */ }
      }
    }
    id = newest.id
  }
  if (!id) {
    console.error('  ' + t('No active guard session found. Pass the session id: codeburn guard allow <session-id>.'))
    process.exitCode = 1
    return
  }
  await writeAllow(id)
  console.log('  ' + t('Lifted the guard hard cap for session %s (this session only).', id))
}

export function registerGuardCommands(program: Command): void {
  const guard = program
    .command('guard')
    .description(t('Opt-in, removable session-time hooks for Claude Code (budget caps, openers, yield checkpoint)'))

  guard
    .command('install')
    .description(t('Install the guard hooks into Claude Code settings (default: this project)'))
    .option('--global', t('Install into ~/.claude/settings.json instead of the project'))
    .option('--project <path>', t('Install into <path>/.claude/settings.json'))
    .option('--statusline', t('Also configure the guard statusline (skipped if one already exists)'))
    .action(async (opts: { global?: boolean; project?: string; statusline?: boolean }) => {
      try {
        await doInstall({ global: opts.global, project: opts.project }, !!opts.statusline)
      } catch (e) {
        console.error(`  ${e instanceof Error ? e.message : String(e)}`)
        process.exitCode = 1
      }
    })

  guard
    .command('uninstall')
    .description(t('Remove the guard hooks, leaving any user hooks untouched'))
    .option('--global', t('Uninstall from ~/.claude/settings.json'))
    .option('--project <path>', t('Uninstall from <path>/.claude/settings.json'))
    .action(async (opts: { global?: boolean; project?: string }) => {
      try {
        await doUninstall({ global: opts.global, project: opts.project })
      } catch (e) {
        console.error(`  ${e instanceof Error ? e.message : String(e)}`)
        process.exitCode = 1
      }
    })

  guard
    .command('status')
    .description(t('Show resolved guard config, install locations, and the flag list'))
    .action(async () => { await doStatus() })

  guard
    .command('refresh')
    .description(t('Recompute the per-project session-opener flag list from optimize signals'))
    .action(async () => {
      try {
        const n = await refreshFlags()
        console.log('  ' + tn('Flagged %d project for session openers.', 'Flagged %d projects for session openers.', n))
      } catch (e) {
        console.error(`  ${e instanceof Error ? e.message : String(e)}`)
        process.exitCode = 1
      }
    })

  guard
    .command('allow [sessionId]')
    .description(t('Lift the hard budget cap for the current (or given) session'))
    .action(async (sessionId: string | undefined) => { await doAllow(sessionId) })

  guard
    .command('hook <event>')
    .description(t('Internal: Claude Code invokes this with the hook payload on stdin'))
    .action(async (event: string) => {
      const { runGuardHook } = await import('./hooks.js')
      const out = await runGuardHook(event, await readStdin())
      if (out) process.stdout.write(out)
    })

  guard
    .command('statusline')
    .description(t('Internal: Claude Code statusline command; prints one line'))
    .action(async () => {
      const { runGuardStatusline } = await import('./hooks.js')
      const out = await runGuardStatusline(await readStdin())
      if (out) process.stdout.write(out + '\n')
    })
}
