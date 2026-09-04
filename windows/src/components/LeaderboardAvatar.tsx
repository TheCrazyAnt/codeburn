import { useState } from 'react'
import { PersonIcon } from './Icons'

/// Round GitHub avatar with a neutral placeholder while loading or offline,
/// mirroring the macOS `LeaderboardAvatar`. The URL always comes from the
/// board response (`avatars.githubusercontent.com`), which is the only remote
/// image host the app's CSP allows; anything else simply fails to load and
/// falls back to the placeholder.

type Props = {
  url?: string | null
  size: number
}

export function LeaderboardAvatar({ url, size }: Props) {
  const [failed, setFailed] = useState(false)
  const style = { width: size, height: size }

  if (!url || failed) {
    return (
      <span className="lb-avatar lb-avatar-placeholder" style={style} aria-hidden="true">
        <PersonIcon size={Math.round(size * 0.62)} />
      </span>
    )
  }
  return (
    <img
      className="lb-avatar"
      style={style}
      src={url}
      alt=""
      aria-hidden="true"
      onError={() => setFailed(true)}
    />
  )
}
