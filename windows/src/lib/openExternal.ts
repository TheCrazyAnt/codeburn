import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

import { IS_WINDOWS } from './platform'

/// Opens a link in the system browser and rejects with a reason when it could
/// not -- never silence, which is how "Open GitHub" came to do nothing and say
/// nothing.
///
/// On Windows only the Rust command is used. The plugin's own command runs on
/// a worker thread with no COM apartment, where ShellExecute can report success
/// and launch nothing; the Rust path calls it on the main thread and returns a
/// real verdict, and falling back to the plugin after a real failure would only
/// let that false success hide it again. Elsewhere the plugin is sound and
/// stays first, with the Rust command behind it.
export async function openExternal(url: string): Promise<void> {
  if (IS_WINDOWS) {
    await invoke('open_url', { url })
    return
  }
  try {
    await openUrl(url)
  } catch (first) {
    try {
      await invoke('open_url', { url })
    } catch (second) {
      throw new Error(`${describe(second)} (${describe(first)})`)
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
