// Pure logic: turn the files the super-agent setup writes into what the pane shows.
// No `$` here, so it is easy to test.
import type { AgentView, DotState, Problem, Snapshot, TicketView } from '../types'

export type RawStatus = { file: string; mtime: number; data: Record<string, unknown> }
export type RawAgent = { id: string; type: string; status: string; description: string; teammateId?: string }
export type Inputs = {
  now: number
  boardText?: string
  statuses: RawStatus[]
  agents: RawAgent[]
  watchdogState?: { mtime: number; keys: string[] }
  rules: { quiet_minutes: number; interval_minutes: number }
}

const ACTIVE_PHASES = ['setup', 'building', 'testing', 'reviewing', 'fixing']
const PROGRESS: Record<string, number> = { setup: 0.1, building: 0.35, testing: 0.6, reviewing: 0.75, fixing: 0.85, checking: 0.95, done: 1 }
export const DONE_FADE_MS = 2 * 60_000
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const time = (v: unknown, fallback?: number): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : fallback
}

/** Rows of the board table: `| # | Title | Status | Mode | Runs |`. */
export function parseBoard(text: string): { id: string; title: string; status: string; mode: string; runs: string }[] {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
    const id = cells[0] ?? ''
    if (cells.length < 3 || !/^\d{1,4}$/.test(id)) continue // header, separator, junk
    rows.push({ id, title: cells[1] ?? '', status: (cells[2] ?? '').toLowerCase(), mode: (cells[3] ?? '').toLowerCase(), runs: cells[4] ?? '' })
  }
  return rows
}

export function waitsFor(runs: string): string[] {
  const m = runs.match(/waits for ([^:]*)/i)
  return [...(m?.[1] ?? '').matchAll(/\d{3}/g)].map(x => x[0])
}

type Status = {
  agent: string; ticket?: string; phase: string; started?: number; updated?: number
  waitingOn?: string; blocker?: string; note?: string
}

function readStatus(s: RawStatus): Status {
  const d = s.data
  const fallbackName = s.file.replace(/^.*status-?/, '').replace(/\.json$/, '') || 'agent'
  // An agent doesn't know the clock, so the times it writes can be made up. The file's own modification time is
  // the real "last update"; a written start time is kept only if it's plausible (within a day before that).
  const written = time(d.started)
  const started = written !== undefined && written <= s.mtime && s.mtime - written < 24 * 60 * 60_000 ? written : undefined
  return {
    agent: str(d.agent) ?? fallbackName,
    ticket: str(d.ticket),
    phase: (str(d.phase) ?? 'unknown').toLowerCase(),
    started,
    updated: s.mtime,
    waitingOn: str(d.waiting_on),
    blocker: str(d.blocker),
    note: str(d.note) ?? str(d.blocker),
  }
}

const isQuiet = (s: Status, now: number, quietMs: number) =>
  !['done', 'reported', 'blocked', 'incomplete'].includes(s.phase) && !!s.updated && now - s.updated > quietMs

function statusDot(s: Status, now: number, quietMs: number): DotState | null {
  if (s.phase === 'blocked' || s.phase === 'incomplete') return 'blocked'
  if (s.phase === 'done' || s.phase === 'reported') return s.updated && now - s.updated < DONE_FADE_MS ? 'done' : null
  if (s.waitingOn) return 'waiting'
  if (s.updated && now - s.updated > quietMs) return 'waiting'
  return 'working'
}

function agentDot(a: RawAgent): DotState | null {
  switch (a.status) {
    case 'running': return 'working'
    case 'pending': case 'waiting': case 'idle': return 'waiting'
    case 'failed': return 'blocked'
    default: return null // completed, killed
  }
}

/** A live agent and a status file are the same worker when the ticket or the teammate name matches. */
function matches(a: RawAgent, s: Status): boolean {
  const name = a.teammateId?.split('@')[0]
  if (name && name === s.agent) return true
  return !!s.ticket && new RegExp(`\\b${s.ticket}\\b`).test(a.description)
}

export function buildSnapshot(input: Inputs): Snapshot {
  const { now } = input
  const quietMs = input.rules.quiet_minutes * 60_000
  const board = input.boardText ? parseBoard(input.boardText) : []
  const doneIds = new Set(board.filter(r => r.status === 'done').map(r => r.id))
  // A worker whose ticket the board already marks done is finished, whatever its status file still says.
  const statuses = input.statuses.map(readStatus).filter(s => !(s.ticket && doneIds.has(s.ticket)))

  // Agents: the session's live agents first (router session), then status files nobody claimed (demo, restarts).
  const agents: AgentView[] = []
  const claimed = new Set<Status>()
  let watchdogAgent: RawAgent | undefined
  for (const a of input.agents) {
    if (a.type === 'watchdog') { watchdogAgent = a; continue }
    let dot = agentDot(a)
    if (!dot) continue
    const s = statuses.find(x => !claimed.has(x) && matches(a, x))
    if (s) {
      claimed.add(s)
      const fromFile = statusDot(s, now, quietMs)
      if (fromFile === 'blocked' || (fromFile === 'waiting' && dot === 'working')) dot = fromFile
    }
    agents.push({
      id: a.id,
      name: a.teammateId?.split('@')[0] ?? s?.agent ?? a.type,
      ticket: s?.ticket ?? a.description.match(/\b\d{3}\b/)?.[0],
      label: s?.phase && s.phase !== 'unknown' ? s.phase : a.status,
      dot, updatedAt: s?.updated, note: s?.note ?? a.description,
      quiet: s ? isQuiet(s, now, quietMs) : false, waitingOn: s?.waitingOn,
    })
  }
  for (const s of statuses) {
    if (claimed.has(s)) continue
    const dot = statusDot(s, now, quietMs)
    if (!dot) continue
    // A finished agent's file still speaks for it; its id lets the map draw it in the agent's seat, not twice.
    const ended = input.agents.find(a => a.type !== 'watchdog' && agentDot(a) === null && matches(a, s))
    agents.push({ id: ended?.id, name: s.agent, ticket: s.ticket, label: s.phase, dot, updatedAt: s.updated, note: s.note, quiet: isQuiet(s, now, quietMs), waitingOn: s.waitingOn })
  }

  // Tickets: the board, joined with the newest status file for each ticket.
  const tickets: TicketView[] = board.map(r => {
    // A team ticket has several status files: a blocked member marks the whole ticket, else the newest one speaks.
    const mine = statuses.filter(x => x.ticket === r.id).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
    const s = mine.find(x => x.phase === 'blocked' || x.phase === 'incomplete') ?? mine.find(x => ACTIVE_PHASES.includes(x.phase)) ?? mine[0]
    const waits = waitsFor(r.runs)
    let state: string
    if (r.status === 'done') state = 'done'
    else if (s && (s.phase === 'blocked' || s.phase === 'incomplete')) state = s.phase
    else if (s && ACTIVE_PHASES.includes(s.phase)) state = s.phase
    else if (s && (s.phase === 'done' || s.phase === 'reported')) state = 'checking'
    else if (r.status === 'review') state = 'review'
    else if (r.status === 'ready') state = waits.some(w => !doneIds.has(w)) ? 'waiting' : 'queued'
    else state = 'draft'
    return { id: r.id, title: r.title, boardStatus: r.status, mode: r.mode, state, waitsFor: waits.filter(w => !doneIds.has(w)), startedAt: s?.started, updatedAt: s?.updated, note: s?.note }
  })

  // Watchdog: the router runs a round on a timer, and each round rewrites the state file. So it's alive while
  // rounds keep landing (a timer may fire up to half a period late). An investigator agent running now counts too.
  const ws = input.watchdogState
  const roundMs = input.rules.interval_minutes * 60_000
  const fresh = !!ws && now - ws.mtime < roundMs * 2 + 60_000
  const investigating = !!watchdogAgent && agentDot(watchdogAgent) !== null && agentDot(watchdogAgent) !== 'blocked'
  let wdot: DotState = 'free'
  if (investigating) wdot = 'working'
  else if (ws) wdot = fresh ? 'working' : 'blocked'
  const problems: Problem[] = (ws?.keys ?? []).map(k => {
    const [kind = 'problem', who = '?', ticket] = k.split('|')
    return { kind, who, ticket: ticket && ticket !== 'null' ? ticket : undefined }
  })

  // When watchdog rounds are running, they see more than the status file (the worktree's files and commits),
  // so "quiet" is whatever the watchdog flagged; without a watchdog the file time is all we have.
  if (ws) {
    for (const a of agents) {
      const flagged = problems.some(p => p.kind === 'went-quiet' && p.who === a.name)
      if (a.quiet && !flagged && a.dot === 'waiting' && !a.waitingOn) a.dot = 'working'
      a.quiet = flagged
      if (flagged && a.dot === 'working') a.dot = 'waiting'
    }
  }

  return { at: now, hasBoard: board.length > 0, tickets, agents, problems, watchdog: { dot: wdot, lastRound: ws?.mtime } }
}

// ---- drawing helpers ----

export function progress(state: string): number | undefined {
  if (state === 'blocked' || state === 'incomplete') return 0.5
  return PROGRESS[state]
}

export function bar(fraction: number, width = 10): string {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return '█'.repeat(full) + '░'.repeat(width - full)
}

export function ago(ms: number | undefined, now: number): string {
  if (ms === undefined) return ''
  const m = Math.max(0, Math.round((now - ms) / 60_000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function fit(text: string, width: number): string {
  if (width <= 1) return ''
  return text.length <= width ? text.padEnd(width) : text.slice(0, width - 1) + '…'
}

export type Cell = DotState | { more: number }
export const MAP_ROWS = 3
export const MAP_INDENT = 5 // "● ●  " router + watchdog, then the workers

export const MAP_MIN_COLUMNS = 5

/**
 * Worker slots in MAP_ROWS rows of MAP_MIN_COLUMNS (3×5) by default. More agents add columns, as many as
 * the pane's width allows; past that, the extra agents fold into "+N" in the last slot.
 */
export function layoutMap(columns: number, workers: DotState[]): Cell[][] {
  const fits = Math.max(1, Math.floor((columns - MAP_INDENT) / 2))
  const perRow = Math.min(fits, Math.max(MAP_MIN_COLUMNS, Math.ceil(workers.length / MAP_ROWS)))
  const slots = perRow * MAP_ROWS
  const cells: Cell[] = workers.slice(0, slots)
  if (workers.length > slots) cells[slots - 1] = { more: workers.length - slots + 1 }
  while (cells.length < slots) cells.push('free')
  const rows: Cell[][] = []
  for (let r = 0; r < MAP_ROWS; r++) rows.push(cells.slice(r * perRow, (r + 1) * perRow))
  return rows
}

/**
 * Whether a dot is lit on this animation frame (two frames a second), like server status LEDs.
 * `seat` is the dot's place in the map, so neighbours don't blink in sync.
 */
export function lit(state: DotState | 'router-busy' | 'router-idle' | 'watchdog', frame: number, seat: number): boolean {
  const scatter = (seat * 7 + 3) % 11 // a fixed, irregular offset per seat
  switch (state) {
    case 'working': case 'router-busy': return (frame + scatter) % 6 !== 0 // brief flicker, each dot at its own moment
    case 'waiting': return Math.floor((frame + scatter) / 2) % 2 === 0 // slow pulse
    case 'blocked': return frame % 2 === 0 // alarm blink, all in step
    case 'watchdog': return frame % 4 === 0 // heartbeat flash every 2 s
    default: return true // done, free, idle router: steady
  }
}

export const TICKET_LIMIT = 10

/**
 * Which tickets the pane lists: the first TICKET_LIMIT unfinished ones (drafts aside, they have their own line),
 * topped up at the front with the most recently finished ones when fewer are unfinished. Board order is kept.
 */
export function pickTickets(tickets: TicketView[], limit = TICKET_LIMIT): { shown: TicketView[]; moreUnfinished: number; earlierDone: number } {
  const listed = tickets.filter(t => t.state !== 'draft')
  const unfinished = listed.filter(t => t.state !== 'done')
  const done = listed.filter(t => t.state === 'done')
  const open = unfinished.slice(0, limit)
  const topUp = done.slice(Math.max(0, done.length - (limit - open.length)))
  return { shown: [...topUp, ...open], moreUnfinished: unfinished.length - open.length, earlierDone: done.length - topUp.length }
}

export function summary(s: Snapshot): string {
  const total = s.tickets.length
  const done = s.tickets.filter(t => t.state === 'done').length
  const running = s.agents.filter(a => a.dot === 'working' || a.dot === 'waiting').length
  const parts = [`▣ ${done}/${total} done`, `${running} running`]
  const flagged = new Set(s.problems.map(p => p.who))
  const alerts = s.problems.length + s.agents.filter(a => a.dot === 'blocked' && !flagged.has(a.name)).length
  if (alerts) parts.push(`⚠ ${alerts}`)
  return parts.join(' · ')
}
