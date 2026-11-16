// The agent map's own state: a fixed seat per agent, its colour from lifecycle events (backed up by the
// agent list), and when it last did something, so a working dot can blink off once per model request or
// tool call. Pure logic, no `$`.
import type { MapState, MapTrack } from '../types'
import { DONE_FADE_MS } from './model'
import type { RawAgent } from './model'

export type MapEvent =
  | { kind: 'start'; agentId: string; at: number }
  /** A model request or a tool call; no agentId means the router (the main loop). */
  | { kind: 'activity'; agentId?: string; at: number }
  | { kind: 'end'; agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error'; at: number }

export const EMPTY_MAP: MapState = Object.freeze({ tracks: Object.freeze({}) }) as MapState

/** An agent the list doesn't show yet is kept this long after it was last heard. */
export const HEARD_GRACE_MS = 5_000
/** How long after its last activity a dot may still blink for it (two animation frames). */
const BLIP_WINDOW_MS = 1_000

function freeSeat(tracks: Record<string, MapTrack>): number {
  const taken = new Set(Object.values(tracks).map(t => t.seat))
  let seat = 0
  while (taken.has(seat)) seat++
  return seat
}

/** The track for `id`, created at the lowest free seat when there is none. */
function seated(tracks: Record<string, MapTrack>, id: string, at: number): MapTrack {
  return tracks[id] ?? { seat: freeSeat(tracks), phase: 'working', lastEvent: at }
}

export function applyEvents(state: MapState, events: MapEvent[]): MapState {
  const tracks = { ...state.tracks }
  let routerActivity = state.routerActivity
  for (const e of events) {
    if (e.kind === 'activity' && e.agentId === undefined) {
      routerActivity = Math.max(routerActivity ?? e.at, e.at)
      continue
    }
    const id = e.agentId as string
    if (e.kind === 'end') {
      const t = tracks[id]
      if (!t) continue
      tracks[id] = { ...t, phase: e.reason === 'answer' ? 'waiting' : 'blocked', lastEvent: e.at }
      continue
    }
    const t = seated(tracks, id, e.at)
    const lastActivity = e.kind === 'activity' ? Math.max(t.lastActivity ?? e.at, e.at) : t.lastActivity
    tracks[id] = { ...t, phase: 'working', endedAt: undefined, lastEvent: Math.max(t.lastEvent, e.at), lastActivity }
  }
  return { ...state, tracks, routerActivity }
}

const LIST_PHASE: Record<string, MapTrack['phase'] | undefined> = {
  running: 'working', pending: 'waiting', waiting: 'waiting', idle: 'waiting', failed: 'blocked', completed: 'done',
}

export function reconcile(state: MapState, list: RawAgent[], now: number): MapState {
  const tracks = { ...state.tracks }
  const listed = new Set<string>()
  for (const a of list) {
    listed.add(a.id)
    if (a.type === 'watchdog' || a.status === 'killed') { delete tracks[a.id]; continue }
    const t = tracks[a.id]
    if (t && t.listStatus === a.status) continue // only the list's changes count; events in between stand
    if (!t && a.status === 'completed') continue // finished before the board saw it
    const phase = LIST_PHASE[a.status]
    const base = seated(tracks, a.id, now)
    tracks[a.id] = {
      ...base,
      phase: phase ?? base.phase,
      listStatus: a.status, type: a.type, lastEvent: now,
      endedAt: phase === 'done' ? now : undefined,
    }
  }
  for (const [id, t] of Object.entries(tracks)) {
    const missing = !listed.has(id) && now - t.lastEvent > HEARD_GRACE_MS
    const faded = t.phase === 'done' && t.endedAt !== undefined && now - t.endedAt >= DONE_FADE_MS
    if (missing || faded) delete tracks[id]
  }
  return { ...state, tracks }
}

/**
 * Whether a working dot is dark on this animation frame: once for each burst of activity in the last
 * second, on the frames of its seat's parity, so a busy agent chatters at about 1 Hz out of step with
 * its neighbours and an agent that does nothing stays lit.
 */
export function blip(lastActivity: number | undefined, now: number, frame: number, seat: number): boolean {
  return lastActivity !== undefined && now - lastActivity < BLIP_WINDOW_MS && (frame + seat) % 2 === 0
}
