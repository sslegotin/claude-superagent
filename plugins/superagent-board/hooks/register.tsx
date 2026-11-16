import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DotState, Snapshot, TicketView } from '../types'
import { applyEvents, blip, EMPTY_MAP, mapDots, reconcile } from './map'
import type { MapEvent } from './map'
import { ago, bar, buildSnapshot, fit, layoutMap, lit, MAP_INDENT, pickTickets, progress, summary } from './model'
import type { RawAgent, RawStatus } from './model'

const PANE = 'superagent-board'
const TITLE = 'Super-agent'
const REFRESH_MS = 2000

// Change the shape tag when Snapshot's fields change: a reload then ignores what the old code stored.
const snapshot = atom({ plugin: 'superagent-board', key: 'snapshot' } as const, null, { shape: 'snapshot-3' })
const routerBusy = atom({ plugin: 'superagent-board', key: 'routerBusy' } as const, false)
const frame = atom({ plugin: 'superagent-board', key: 'frame' } as const, 0)
const FRAME_MS = 500
const mapState = atom({ plugin: 'superagent-board', key: 'map' } as const, EMPTY_MAP, { shape: 'map-2' })

// Lifecycle events for the agent map, gathered by the hooks and drained into `mapState` on each animation
// frame. A hook only notes the event here and passes it on: it never waits, so it can't slow an agent.
let pending: MapEvent[] = []
type Noted = { kind: 'start'; agentId: string } | { kind: 'activity'; agentId?: string } | { kind: 'end'; agentId: string; reason: 'answer' | 'aborted' | 'refusal' | 'error' }
function record($: EngineInterface, ev: Noted): void {
  void $.clock.now().then(at => { pending.push({ ...ev, at } as MapEvent) }).catch(() => {})
}

const DOT_COLOR: Record<DotState, string | undefined> = {
  working: 'success', waiting: 'warning', blocked: 'error', done: 'suggestion', free: undefined,
}

type TicketLook = { icon: string; color?: string; dim?: boolean; label: string }
function look(t: TicketView): TicketLook {
  switch (t.state) {
    case 'done': return { icon: '✓', color: 'suggestion', label: 'done' }
    case 'blocked': return { icon: '✖', color: 'error', label: 'blocked' }
    case 'incomplete': return { icon: '✖', color: 'error', label: 'incomplete' }
    case 'checking': return { icon: '●', color: 'suggestion', label: 'checking' }
    case 'review': return { icon: '◐', color: 'merged', label: 'in review' }
    case 'waiting': return { icon: '◷', color: 'warning', dim: true, label: `waits ${t.waitsFor.join(',')}` }
    case 'queued': return { icon: '◌', label: 'queued' }
    case 'draft': return { icon: '○', dim: true, label: 'draft' }
    default: return { icon: '●', color: 'success', label: t.state }
  }
}

function draftRange(drafts: TicketView[]): string {
  const first = drafts[0]?.id ?? ''
  const last = drafts[drafts.length - 1]?.id ?? ''
  return first === last ? first : `${first}–${last}`
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try { return await $.fs.read(path) } catch { return undefined }
}
async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText($, path)
  if (!text) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * The agents' worktrees (folders named agent-*), found through git's own records so it works wherever they are:
 * under this checkout's .claude/worktrees/, or under the repository root's when the router runs in a dedicated
 * worktree. `.git` is a folder in the main checkout and a "gitdir: <common>/worktrees/<name>" file in a worktree;
 * <common>/worktrees/<name>/gitdir holds the path of each worktree's .git file.
 */
async function agentWorktrees($: EngineInterface, cwd: string): Promise<string[]> {
  let common = `${cwd}/.git`
  try {
    if ((await $.fs.stat(common)).kind === 'file') {
      const pointer = (await readText($, common))?.match(/gitdir:\s*(.+)/)?.[1]?.trim()
      if (!pointer) return []
      common = pointer.replace(/\/worktrees\/[^/]+\/?$/, '')
    }
  } catch { return [] }
  const found: string[] = []
  if (!(await $.fs.exists(`${common}/worktrees`))) return found
  for (const e of await $.fs.list(`${common}/worktrees`)) {
    const gitFile = (await readText($, `${common}/worktrees/${e.name}/gitdir`))?.trim()
    if (!gitFile) continue
    const dir = gitFile.replace(/\/\.git$/, '')
    if (/(^|\/)agent-[^/]+$/.test(dir)) found.push(dir)
  }
  return found
}

async function gather($: EngineInterface): Promise<{ snap: Snapshot; agents: RawAgent[] }> {
  const cwd = await $.session.cwd()
  const at = (rel: string) => `${cwd}/${rel}`
  const now = await $.clock.now()

  const rulesFile = await readJson($, at('.claude/watchdog/rules.json'))
  const rules = {
    quiet_minutes: Number(rulesFile?.quiet_minutes) || 15,
    interval_minutes: Number(rulesFile?.interval_minutes) || 10,
  }

  const statuses: RawStatus[] = []
  const addStatus = async (path: string) => {
    const data = await readJson($, path)
    if (!data) return
    let mtime = now
    try { mtime = (await $.fs.stat(path)).mtimeMs } catch {}
    statuses.push({ file: path, mtime, data })
  }
  for (const dir of await agentWorktrees($, cwd)) await addStatus(`${dir}/.job/status.json`)
  let watchdogState: { mtime: number; keys: string[] } | undefined
  if (await $.fs.exists(at('.job'))) {
    for (const e of await $.fs.list(at('.job'))) {
      if (/^status-.+\.json$/.test(e.name)) await addStatus(at(`.job/${e.name}`))
      if (e.name === 'watchdog-state.json') {
        const data = await readJson($, at('.job/watchdog-state.json'))
        watchdogState = { mtime: e.mtimeMs, keys: Object.keys(data ?? {}) }
      }
    }
  }

  let agents: RawAgent[] = []
  try {
    agents = (await $.agent.list()).map(a => ({ id: a.id, type: a.type, status: a.status, description: a.description, teammateId: a.teammateId }))
  } catch {}

  return { snap: buildSnapshot({ now, boardText: await readText($, at('specs/tickets/BOARD.md')), statuses, agents, watchdogState, rules }), agents }
}

let lastKey = ''
async function refresh($: EngineInterface): Promise<void> {
  const { snap, agents } = await gather($)
  // Redraw when something changed, or every 30 s so the "Xm ago" times move.
  const key = JSON.stringify({ ...snap, at: Math.floor(snap.at / 30_000) })
  if (key !== lastKey) {
    lastKey = key
    await update($, snapshot, () => snap)
  }
  await update($, mapState, s => reconcile(s, agents, snap.at))
  $.ui.status(snap.hasBoard ? summary(snap) : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'board', description: 'Show or hide the super-agent board (tickets, agents, watchdog, agent map)' })
    await refresh($).catch(() => {})
    $.clock.every(REFRESH_MS, () => { void refresh($).catch(() => {}) })
    // Animation: only while a pane is open on a board, so an idle session redraws nothing.
    $.clock.every(FRAME_MS, () => {
      void (async () => {
        if (pending.length) {
          const drained = pending
          pending = []
          await update($, mapState, s => applyEvents(s, drained))
        }
        if (!lastKey.includes('"hasBoard":true')) return
        if (!(await $.ui.panes()).some(p => p.id === PANE)) return
        await update($, frame, n => (n + 1) % 1_000_000)
      })().catch(() => {})
    })
    const snap = await read($, snapshot)
    if (snap?.hasBoard) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open) {
      await $.ui.close({ id: PANE })
      return { text: 'Super-agent board closed.' }
    }
    await refresh($).catch(() => {})
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Super-agent board opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) record($, { kind: 'start', agentId: e.agentId })
    else await update($, routerBusy, () => true)
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) record($, { kind: 'end', agentId: e.agentId, reason: e.reason })
    else await update($, routerBusy, () => false)
    return next(e)
  })
  // A model request and a tool call each blink the agent's dot. Tool calls are heard at `tool.check`, which
  // decides on a call without running it: a hook on `tool.call` would wrap the router's Agent call, and the
  // engine keeps an agent's own events from the hooks its spawn ran inside.
  on('turn.step', async function* ($, e, next) {
    record($, { kind: 'activity', agentId: e.agentId })
    return yield* next(e)
  })
  on('tool.check', async ($, e, next) => {
    if (e.tool_use_id) record($, { kind: 'activity', agentId: e.agentId }) // without an id it's a query, not a call
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const busy = await read($, routerBusy)
    const cols = Math.max(30, e.props.bodyColumns)

    if (!snap || !snap.hasBoard) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No tickets yet (specs/tickets/BOARD.md is missing or empty).</Text>
          <Text dimColor>Write tickets with /write-tickets, then start the router.</Text>
        </Box>
      )
    }

    const now = snap.at
    const { shown, moreUnfinished, earlierDone } = pickTickets(snap.tickets)
    const drafts = snap.tickets.filter(t => t.state === 'draft')
    const done = snap.tickets.filter(t => t.state === 'done').length
    const running = snap.agents.filter(a => a.dot === 'working' || a.dot === 'waiting').length

    // Ticket row: "● 001 title…      ████░░░░░░ testing      12m"
    const labelW = 12
    const timeW = 5
    const titleW = Math.max(6, cols - (2 + 4 + 11 + labelW + timeW))
    const ticketRows = shown.map(t => {
      const l = look(t)
      const p = progress(t.state)
      const active = p !== undefined && t.state !== 'done'
      return (
        <Box flexDirection="column">
          <Text>
            <Text color={l.color} dimColor={l.dim}>{l.icon} </Text>
            <Text bold>{t.id} </Text>
            <Text dimColor={l.dim}>{fit(t.title, titleW)}</Text>
            <Text color={l.color} dimColor={!active}>{active ? bar(p) : '          '} </Text>
            <Text color={l.color} dimColor={l.dim}>{fit(l.label, labelW)}</Text>
            <Text dimColor>{active ? ago(t.startedAt, now).padStart(timeW) : ''}</Text>
          </Text>
          {active && t.note ? <Text dimColor italic>{'    '}{fit(`"${t.note}"`, cols - 4)}</Text> : null}
        </Box>
      )
    })

    const agentRows = snap.agents.map(a => (
      <Text>
        <Text color={DOT_COLOR[a.dot]}>● </Text>
        <Text>{fit(a.name, 14)} </Text>
        <Text dimColor>{fit(`${a.ticket ? a.ticket + ' · ' : ''}${a.label}`, 20)} </Text>
        <Text dimColor={!a.quiet} color={a.quiet ? 'warning' : undefined}>
          {a.updatedAt ? `updated ${ago(a.updatedAt, now)} ago` : ''}{a.quiet ? '  ⚠ quiet?' : a.waitingOn ? `  waiting on ${a.waitingOn}` : ''}
        </Text>
      </Text>
    ))

    const wd = snap.watchdog
    const watchdogLines = snap.problems.length
      ? snap.problems.slice(0, 4).map(p => (
          <Text color="warning">⚠ {p.kind}: {p.who}{p.ticket ? ` (${p.ticket})` : ''}</Text>
        ))
      : [
          <Text color={wd.dot === 'blocked' ? 'error' : wd.dot === 'free' ? undefined : 'success'} dimColor={wd.dot === 'free'}>
            {wd.dot === 'free' ? 'not running' : wd.dot === 'blocked' ? '✖ no rounds lately' : '✓ all quiet'}
            {wd.lastRound ? <Text dimColor> · last round {ago(wd.lastRound, now)} ago</Text> : null}
          </Text>,
        ]

    // Dot map: router and watchdog first, then every worker, filling the pane's width in MAP_ROWS rows.
    const f = await read($, frame)
    const m = await read($, mapState)
    const clockNow = await $.clock.now()
    const { dots, activity, seated } = mapDots(m, snap.agents)
    const rows = layoutMap(cols, dots)
    const dot = (state: DotState, isLit: boolean) => (
      <Text color={DOT_COLOR[state]} dimColor={state === 'free' || !isLit}>{state === 'free' ? '·' : '●'} </Text>
    )
    // A seated working dot stays lit and blinks off once for each request or tool call (steady = silent).
    const cellLit = (c: DotState, k: number) =>
      c === 'working' && k < seated ? !blip(activity[k], clockNow, f, 2 + k) : lit(c, f, 2 + k)
    const routerDot = dot('working', busy && !blip(m.routerActivity, clockNow, f, 0))
    const watchdogDot = dot(wd.dot, wd.dot === 'working' ? lit('watchdog', f, 1) : lit(wd.dot, f, 1))
    const perRow = rows[0]?.length ?? 0
    const mapRows = rows.map((row, i) => (
      <Text>
        {i === 0 ? <Text>{routerDot}{watchdogDot} </Text> : <Text>{' '.repeat(MAP_INDENT)}</Text>}
        {row.map((c, j) => (typeof c === 'string' ? dot(c, cellLit(c, i * perRow + j)) : <Text color="warning">+{c.more}</Text>))}
      </Text>
    ))

    const section = (name: string) => <Text dimColor bold>{name}</Text>

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="claude">{TITLE}</Text>
          <Text dimColor>{done}/{snap.tickets.length} done · {running} running</Text>
        </Box>
        <Text> </Text>
        {section('TICKETS')}
        {earlierDone ? <Text dimColor>✓ {earlierDone} earlier ticket{earlierDone > 1 ? 's' : ''} done</Text> : null}
        {ticketRows}
        {moreUnfinished ? <Text dimColor>… {moreUnfinished} more waiting</Text> : null}
        {drafts.length ? <Text dimColor>○ {drafts.length} draft{drafts.length > 1 ? 's' : ''} ({draftRange(drafts)})</Text> : null}
        <Text> </Text>
        {section('AGENTS')}
        {agentRows.length ? agentRows : [<Text dimColor>none running</Text>]}
        <Text> </Text>
        <Text>{section('WATCHDOG')}</Text>
        {watchdogLines}
        <Text> </Text>
        {mapRows}
        <Text dimColor>
          <Text color="success">●</Text> working  <Text color="warning">●</Text> waiting  <Text color="error">●</Text> blocked  <Text color="suggestion">●</Text> done  · free
        </Text>
      </Box>
    )
  })
}
