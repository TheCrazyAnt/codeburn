import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'

/// Opens a link in the system browser. The plugin call is the normal path, but
/// it goes through the capability layer and rejects rather than opens when that
/// refuses -- invisible if the promise is discarded, which is how "Open GitHub"
/// came to do nothing and say nothing. The Rust command is the same opener
/// without the gate. Either way the caller gets a rejection to show, not silence.
export async function openExternal(url: string): Promise<void> {
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
