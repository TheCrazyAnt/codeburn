/// One leaderboard controller for the whole popover, mirroring the single
/// `LeaderboardService` the macOS app injects into both its Leaderboard tab and
/// its Settings pane. App owns it and hands the same object to both, so the
/// board the tab is looking at and the account Settings is editing can never
/// disagree.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  BOARD_LIMIT, DEFAULT_METRIC, LEADERBOARD_BOARDS, boardKey, cancelLogin, fetchBoard, listenLogin,
  readAccount, runAction, startLogin,
  type LeaderboardAccount, type LeaderboardAction, type LeaderboardBoard, type LeaderboardMetric,
  type LeaderboardPage,
} from './leaderboard'

/// What the sign-in card can be showing.
///
/// The CLI prints the device code and then polls until GitHub answers, so
/// `waiting` covers both "enter the code" and the exchange that follows it --
/// unlike macOS, which owns the state machine and can also show `exchanging`.
export type SignInPhase = 'idle' | 'starting' | 'waiting' | 'failed'

export type SignInState = {
  phase: SignInPhase
  userCode?: string
  verificationUri?: string
  message?: string
}

export type LeaderboardController = {
  /// Null until the first read of the CLI's config lands.
  account: LeaderboardAccount | null
  boards: Record<string, LeaderboardPage | undefined>
  boardErrors: Record<string, string | undefined>
  loadingBoards: Record<string, boolean | undefined>
  /// Spend ranks per period, the trio `codeburn leaderboard status` prints.
  /// `undefined` = not loaded, `null` = unranked.
  ranks: Record<LeaderboardBoard, number | null | undefined>
  signIn: SignInState
  /// The action currently running, so its button can show progress.
  busy: LeaderboardAction | null
  actionError: string | null
  loadBoard: (board: LeaderboardBoard, metric: LeaderboardMetric) => Promise<void>
  loadRanks: (force?: boolean) => Promise<void>
  beginSignIn: (options?: { thenJoin?: boolean }) => Promise<void>
  abortSignIn: () => Promise<void>
  setSharing: (on: boolean) => Promise<void>
  upload: () => Promise<void>
  signOut: () => Promise<void>
  deleteMyData: () => Promise<void>
}

const EMPTY_RANKS: Record<LeaderboardBoard, number | null | undefined> = {
  week: undefined,
  month: undefined,
  lifetime: undefined,
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useLeaderboard(): LeaderboardController {
  const [account, setAccount] = useState<LeaderboardAccount | null>(null)
  const [boards, setBoards] = useState<Record<string, LeaderboardPage | undefined>>({})
  const [boardErrors, setBoardErrors] = useState<Record<string, string | undefined>>({})
  const [loadingBoards, setLoadingBoards] = useState<Record<string, boolean | undefined>>({})
  const [ranks, setRanks] = useState(EMPTY_RANKS)
  const [signIn, setSignIn] = useState<SignInState>({ phase: 'idle' })
  const [busy, setBusy] = useState<LeaderboardAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  /// Set when sign-in was started from the join card, so finishing it also turns
  /// sharing on and uploads -- one click to join, as on macOS. Never set from
  /// the Settings sign-in row, where sharing is its own explicit toggle.
  const joinAfterSignIn = useRef(false)
  /// Guards the state updates of a flow the component outlived. Re-armed on
  /// mount, not just cleared on unmount, so StrictMode's double-mount in dev
  /// does not leave every later update silently dropped.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  /// (board, metric) pairs with a request in flight. A ref, not state, because
  /// two renders must never both decide they are the one to fetch.
  const inFlight = useRef(new Set<string>())
  /// Whether the rank trio has been fetched for the current session.
  const ranksLoaded = useRef(false)

  const refreshAccount = useCallback(async (): Promise<LeaderboardAccount | null> => {
    try {
      const next = await readAccount()
      if (alive.current) setAccount(next)
      return next
    } catch (err) {
      if (alive.current) setActionError(message(err))
      return null
    }
  }, [])

  useEffect(() => { void refreshAccount() }, [refreshAccount])

  const loadBoard = useCallback(async (board: LeaderboardBoard, metric: LeaderboardMetric) => {
    const key = boardKey(board, metric)
    if (inFlight.current.has(key)) return
    inFlight.current.add(key)
    // A cached page stays on screen while a refresh runs, so the board does not
    // flash back to the spinner on every manual reload.
    setLoadingBoards(current => ({ ...current, [key]: true }))
    try {
      const page = await fetchBoard(board, metric, BOARD_LIMIT)
      if (!alive.current) return
      setBoards(current => ({ ...current, [key]: page }))
      setBoardErrors(current => ({ ...current, [key]: undefined }))
    } catch (err) {
      if (alive.current) setBoardErrors(current => ({ ...current, [key]: message(err) }))
    } finally {
      inFlight.current.delete(key)
      if (alive.current) setLoadingBoards(current => ({ ...current, [key]: false }))
    }
  }, [])

  const resetRanks = useCallback(() => {
    ranksLoaded.current = false
    setRanks(current => (current === EMPTY_RANKS ? current : EMPTY_RANKS))
  }, [])

  /// The three spend ranks, read from each board's authenticated `me` block.
  /// `limit=1` keeps the reads cheap, exactly like `leaderboard status`.
  ///
  /// Guarded by a ref rather than by inspecting `ranks`: a board that errors
  /// leaves its rank unset, and re-deriving "should I load?" from state would
  /// then spawn a CLI process on every render.
  const loadRanks = useCallback(async (force = false) => {
    if (!account?.signedIn) {
      resetRanks()
      return
    }
    if (ranksLoaded.current && !force) return
    ranksLoaded.current = true
    const pages = await Promise.all(LEADERBOARD_BOARDS.map(async board => {
      try {
        const page = await fetchBoard(board, DEFAULT_METRIC, 1)
        return [board, page.me?.rank ?? null] as const
      } catch {
        // A board that failed stays "not loaded" rather than claiming unranked.
        return [board, undefined] as const
      }
    }))
    if (!alive.current) return
    setRanks(current => {
      const next = { ...current }
      for (const [board, rank] of pages) next[board] = rank
      return next
    })
  }, [account?.signedIn, resetRanks])

  const perform = useCallback(async (action: LeaderboardAction) => {
    setBusy(action)
    setActionError(null)
    try {
      const next = await runAction(action)
      if (alive.current) setAccount(next)
    } catch (err) {
      if (alive.current) setActionError(message(err))
      // The CLI records upload failures in config.json, so re-read either way.
      await refreshAccount()
    } finally {
      if (alive.current) setBusy(null)
    }
  }, [refreshAccount])

  // The device flow runs in a CLI child process; its progress arrives as events.
  useEffect(() => {
    const unlisten = listenLogin(event => {
      if (event.phase === 'code') {
        setSignIn({
          phase: 'waiting',
          ...(event.userCode ? { userCode: event.userCode } : {}),
          ...(event.verificationUri ? { verificationUri: event.verificationUri } : {}),
        })
        return
      }
      if (event.phase === 'done') {
        setSignIn({ phase: 'idle' })
        void refreshAccount().then(next => {
          if (!joinAfterSignIn.current) return
          joinAfterSignIn.current = false
          if (next?.signedIn) void perform('join')
        })
        return
      }
      joinAfterSignIn.current = false
      if (event.phase === 'cancelled') {
        setSignIn({ phase: 'idle' })
        return
      }
      setSignIn({ phase: 'failed', ...(event.message ? { message: event.message } : {}) })
    })
    return () => { void unlisten.then(fn => fn()) }
  }, [refreshAccount, perform])

  const beginSignIn = useCallback(async (options?: { thenJoin?: boolean }) => {
    joinAfterSignIn.current = options?.thenJoin === true
    setSignIn({ phase: 'starting' })
    try {
      await startLogin()
    } catch (err) {
      setSignIn({ phase: 'failed', message: message(err) })
    }
  }, [])

  const abortSignIn = useCallback(async () => {
    joinAfterSignIn.current = false
    setSignIn({ phase: 'idle' })
    try {
      await cancelLogin()
    } catch {
      // The flow is already gone as far as the UI is concerned.
    }
  }, [])

  return useMemo<LeaderboardController>(() => ({
    account,
    boards,
    boardErrors,
    loadingBoards,
    ranks,
    signIn,
    busy,
    actionError,
    loadBoard,
    loadRanks,
    beginSignIn,
    abortSignIn,
    // Every state change invalidates the ranks: joining, leaving, uploading and
    // deleting all move (or remove) the row they came from.
    setSharing: async (on: boolean) => {
      await perform(on ? 'join' : 'leave')
      resetRanks()
    },
    upload: async () => {
      await perform('upload')
      resetRanks()
    },
    signOut: async () => {
      await perform('logout')
      resetRanks()
    },
    deleteMyData: async () => {
      await perform('delete')
      resetRanks()
      setBoards({})
    },
  }), [
    account, boards, boardErrors, loadingBoards, ranks, signIn, busy, actionError,
    loadBoard, loadRanks, beginSignIn, abortSignIn, perform, resetRanks,
  ])
}
