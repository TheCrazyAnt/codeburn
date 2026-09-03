import type { Command } from 'commander'
import { renderTable } from '../text-table.js'
import { defaultActionsDir, readRecords, shortId } from './journal.js'
import { DriftError, undoAction } from './undo.js'
import { buildActReportJson, computeActReport, renderActReport } from './report.js'
import { t } from '../i18n.js'

function formatWhen(at: string): string {
  return at.replace('T', ' ').slice(0, 16)
}

export function registerActCommands(program: Command): void {
  const act = program
    .command('act')
    .description(t('Review and undo changes codeburn has applied'))

  act
    .command('list')
    .description(t('List applied actions, newest first'))
    .option('--json', t('Output the full records as JSON'))
    .action(async (opts: { json?: boolean }) => {
      try {
        const records = (await readRecords(defaultActionsDir())).reverse()
        if (opts.json) {
          console.log(JSON.stringify(records, null, 2))
          return
        }
        if (records.length === 0) {
          console.log(t('No actions recorded yet.'))
          return
        }
        const rows = records.map(r => [shortId(r.id), formatWhen(r.at), r.description, r.status])
        console.log(renderTable(
          [{ header: t('ID') }, { header: t('When') }, { header: t('Description') }, { header: t('Status') }],
          rows,
        ))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  act
    .command('undo [id]')
    .description(t('Undo an action by id (8-char prefix accepted), or the most recent with --last'))
    .option('--last', t('Undo the most recent action'))
    .option('--force', t('Undo even if the target files changed since they were applied'))
    .action(async (id: string | undefined, opts: { last?: boolean; force?: boolean }) => {
      if (!id && !opts.last) {
        console.error(t('Specify an action id or --last.'))
        process.exitCode = 1
        return
      }
      try {
        const record = await undoAction(opts.last ? { last: true } : { id: id! }, { force: opts.force })
        console.log(t('Undid %s: %s', shortId(record.id), record.description))
      } catch (err) {
        if (err instanceof DriftError) {
          console.error(err.message + ':')
          for (const f of err.drifted) console.error(`  ${f}`)
          console.error(t('Re-run with --force to undo anyway.'))
        } else {
          console.error(err instanceof Error ? err.message : String(err))
        }
        process.exitCode = 1
      }
    })

  act
    .command('apply-model <project>')
    .description(t('Apply the model default recommendation for a project'))
    .action(async (project: string) => {
      try {
        const { parseAllSessions, filterProjectsByName } = await import('../parser.js')
        const { recommendModelDefault, buildApplyModelDefaultPlan } = await import('./model-defaults.js')
        const { runAction } = await import('./apply.js')
        const chalk = (await import('chalk')).default

        const projects = filterProjectsByName(await parseAllSessions(), [project])
        const p = projects[0]
        if (!p) {
          console.error(t('Project "%s" not found in session history.', project))
          process.exitCode = 1
          return
        }

        const recommendation = recommendModelDefault(p)
        if (!recommendation) {
          console.error(t('No default model recommendation available for %s at this time.', project))
          process.exitCode = 1
          return
        }

        const plan = await buildApplyModelDefaultPlan(recommendation)
        const record = await runAction(plan)

        console.log(t('Applied default model %s for %s', chalk.green(recommendation.candidateModel), project))
        console.log(chalk.dim('  ' + t(
          'Evidence: %d turns, %s%% one-shot, $%s/edit',
          recommendation.candidateEditTurns,
          (recommendation.candidateOneShotRate * 100).toFixed(1),
          recommendation.candidateCostPerEdit.toFixed(3),
        )))
        console.log(chalk.dim('  ' + t('Undo anytime: codeburn act undo %s', shortId(record.id))))
        console.log(chalk.dim('  ' + t('Per-session override: --model <name>')))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })

  act
    .command('report')
    .description(t('Realized vs estimated savings for applied actions older than 3 days'))
    .option('--json', t('Output the realized report as JSON'))
    .action(async (opts: { json?: boolean }) => {
      try {
        const report = await computeActReport()
        if (opts.json) {
          console.log(JSON.stringify(buildActReportJson(report), null, 2))
          return
        }
        console.log(renderActReport(report))
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exitCode = 1
      }
    })
}
