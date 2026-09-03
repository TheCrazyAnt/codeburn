/// First-run copy for a machine where the CLI ran fine but found no sessions. Paths are
/// shown the way the reader's own OS spells them.

import { homePath } from '../lib/platform'
import { t } from '../lib/i18n'

/// `tool` is a product name where the source has one, and a translatable phrase
/// where it needs words (`key` is the English text, translated at render time).
const SOURCES: Array<{ path: string | null; tool: string; translate?: boolean }> = [
  { path: homePath('.claude', 'projects'), tool: 'Claude Code' },
  { path: homePath('.codex', 'sessions'), tool: 'Codex CLI' },
  { path: null, tool: 'Cursor local database', translate: true },
  { path: null, tool: 'GitHub Copilot session events', translate: true },
  { path: homePath('.local', 'share', 'opencode'), tool: 'OpenCode' },
  { path: homePath('.pi'), tool: 'Pi' },
]

export function NoDataState({ onRefresh }: { onRefresh: () => void }) {
  return (
    <section className="no-data">
      <h2 className="no-data-title">{t('No session data yet')}</h2>
      <p>
        {t('CodeBurn reads local session logs written by your AI coding tools. None of the supported tools have recorded a session on this machine yet.')}
      </p>
      <p className="no-data-sub">{t('Watched locations')}</p>
      <ul>
        {SOURCES.map(s => (
          <li key={s.tool}>
            {s.path
              ? <><code>{s.path}</code> <span className="no-data-tool">{s.tool}</span></>
              : (s.translate ? t(s.tool) : s.tool)}
          </li>
        ))}
      </ul>
      <p>{t('Run one of those tools for a session, then refresh.')}</p>
      <button type="button" className="btn" onClick={onRefresh}>{t('Refresh now')}</button>
    </section>
  )
}
