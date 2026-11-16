/** How a dot (and an agent row) is coloured. */
export type DotState = 'working' | 'waiting' | 'blocked' | 'done' | 'free'

/** One ticket from specs/tickets/BOARD.md, joined with its agent's status file. */
export type TicketView = {
  id: string
  title: string
  /** draft | ready | review | done, as the board says */
  boardStatus: string
  mode: string
  /** What the pane shows: a phase (setup, building, testing, reviewing, fixing),
   *  or draft, queued, waiting, checking, review, done, blocked, incomplete. */
  state: string
  waitsFor: string[]
  startedAt?: number
  updatedAt?: number
  note?: string
}

/** One running (or recently finished) agent. */
export type AgentView = {
  /** The live agent's id from the session's agent list; absent for one known only from a status file. */
  id?: string
  name: string
  ticket?: string
  label: string
  dot: DotState
  updatedAt?: number
  note?: string
  /** Past the quiet threshold with no activity. */
  quiet?: boolean
  /** What its status file says it waits for (its tester, a team member). */
  waitingOn?: string
}

export type Problem = { kind: string; who: string; ticket?: string }

/** One agent on the agent map, kept from its lifecycle events and the agent list. */
export type MapTrack = {
  /** Its worker slot, from 0; fixed while the track lives. */
  seat: number
  phase: 'working' | 'waiting' | 'blocked' | 'done'
  /** Its last model request or tool call. */
  lastActivity?: number
  /** The last event or agent-list change that touched it. */
  lastEvent: number
  /** When it went done. */
  endedAt?: number
  /** The last status the agent list gave, so only changes count. */
  listStatus?: string
  /** Its agent type, once the agent list names it. */
  type?: string
}

/** The agent map's own state: one track per agent id, plus the router's last activity. */
export type MapState = { tracks: Record<string, MapTrack>; routerActivity?: number }

export type Snapshot = {
  at: number
  hasBoard: boolean
  tickets: TicketView[]
  agents: AgentView[]
  problems: Problem[]
  watchdog: { dot: DotState; lastRound?: number }
}

declare module 'claude-code' {
  interface PluginState {
    'superagent-board': {
      snapshot: Shaped<Snapshot | null>
      routerBusy: boolean
      /** Animation frame, advanced twice a second while there is a board. */
      frame: number
      /** The agent map's seats and lifecycle state. */
      map: Shaped<MapState>
    }
  }
}
