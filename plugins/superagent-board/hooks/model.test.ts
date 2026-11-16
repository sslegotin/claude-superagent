import { expect, test } from 'claude-code/testing'

import { buildSnapshot, layoutMap, lit, parseBoard, pickTickets, summary, waitsFor } from './model'
import type { TicketView } from '../types'

test('dots blink like status LEDs: working flickers out of sync, blocked blinks in step, done stays lit', async () => {
  const frames = (state: Parameters<typeof lit>[0], seat: number) => Array.from({ length: 12 }, (_, f) => lit(state, f, seat))
  const off = (xs: boolean[]) => xs.filter(x => !x).length
  expect(off(frames('working', 2))).toBe(2) // dark 1 frame in 6
  expect(frames('working', 2)).not.toEqual(frames('working', 3)) // neighbours flicker at different moments
  expect(frames('blocked', 2)).toEqual(frames('blocked', 9)) // the alarm blinks together
  expect(off(frames('blocked', 2))).toBe(6)
  expect(off(frames('watchdog', 1))).toBe(9) // a flash every 4th frame
  expect(off(frames('done', 4))).toBe(0)
})

const BOARD = `# Board

| # | Title | Status | Mode | Runs |
|---|---|---|---|---|
| 001 | Project skeleton | done | solo | alongside |
| 002 | Create tickets | ready | solo | waits for 001: needs the skeleton |
| 003 | Move tickets | ready | solo | waits for 002: shares the board UI |
| 004 | Configurable lifecycle | ready | team | waits for 001 |
| 005 | Search | draft | solo | waits for 002 |
`
const NOW = Date.parse('2026-11-13T12:00:00Z')
const min = (m: number) => new Date(NOW - m * 60_000).toISOString()
const rules = { quiet_minutes: 15, interval_minutes: 10 }

test('the board table is parsed, header and separator skipped', async () => {
  const rows = parseBoard(BOARD)
  expect(rows.length).toBe(5)
  expect(rows[1]).toEqual({ id: '002', title: 'Create tickets', status: 'ready', mode: 'solo', runs: 'waits for 001: needs the skeleton' })
  expect(waitsFor('waits for 003, 006: editor.tsx')).toEqual(['003', '006'])
  expect(waitsFor('alongside')).toEqual([])
})

test('tickets join their status files; waits resolve against done tickets', async () => {
  const s = buildSnapshot({
    now: NOW, boardText: BOARD, agents: [], rules,
    statuses: [{ file: '/p/.claude/worktrees/agent-a/.job/status.json', mtime: Date.parse(min(1)), data: { agent: 'worker-002', ticket: '002', phase: 'testing', started: min(12), updated: '2099-01-01T00:00:00Z', note: 'running E-4' } }],
  })
  const by = (id: string) => s.tickets.find(t => t.id === id)
  expect(by('001')?.state).toBe('done')
  expect(by('002')?.state).toBe('testing')
  expect(by('002')?.note).toBe('running E-4')
  expect(by('003')?.state).toBe('waiting')
  expect(by('003')?.waitsFor).toEqual(['002'])
  expect(by('004')?.state).toBe('queued') // 001 is done
  expect(by('005')?.state).toBe('draft')
  expect(s.agents).toEqual([{ name: 'worker-002', ticket: '002', label: 'testing', dot: 'working', updatedAt: Date.parse(min(1)), note: 'running E-4', quiet: false }])
})

test('a made-up start time is ignored', async () => {
  const s = buildSnapshot({ now: NOW, boardText: BOARD, agents: [], rules,
    statuses: [{ file: 'a', mtime: NOW, data: { agent: 'worker-002', ticket: '002', phase: 'building', started: '2026-11-11T00:00:00Z' } }] })
  expect(s.tickets.find(t => t.id === '002')?.startedAt).toBe(undefined)
})

test('quiet, blocked and finished agents get the right dots', async () => {
  const s = buildSnapshot({
    now: NOW, boardText: BOARD, agents: [], rules,
    statuses: [
      { file: 'a', mtime: Date.parse(min(20)), data: { agent: 'worker-002', ticket: '002', phase: 'building', updated: min(0) } }, // the file's time wins over what the agent wrote
      { file: 'b', mtime: NOW, data: { agent: 'schema', ticket: '004', phase: 'blocked', blocker: 'needs a decision' } },
      { file: 'c', mtime: Date.parse(min(1)), data: { agent: 'worker-003', ticket: '003', phase: 'done' } },
      { file: 'd', mtime: Date.parse(min(30)), data: { agent: 'worker-009', ticket: '009', phase: 'done' } },
    ],
  })
  expect(s.agents.map(a => `${a.name}:${a.dot}`)).toEqual(['worker-002:waiting', 'schema:blocked', 'worker-003:done'])
  expect(s.tickets.find(t => t.id === '003')?.state).toBe('checking')
  expect(s.tickets.find(t => t.id === '004')?.state).toBe('blocked')
})

test('live agents from the session win, matched to status files by ticket or teammate name', async () => {
  const s = buildSnapshot({
    now: NOW, boardText: BOARD, rules,
    agents: [
      { id: 'w1', type: 'watchdog', status: 'running', description: 'Start watchdog' },
      { id: 'a1', type: 'worker', status: 'running', description: 'Build ticket 002' },
      { id: 'a2', type: 'teammate', status: 'idle', description: 'Team 004: schema', teammateId: 'schema@team' },
      { id: 'a3', type: 'tester', status: 'running', description: 'Test ticket 002' },
      { id: 'a4', type: 'worker', status: 'completed', description: 'Build ticket 001' },
    ],
    statuses: [{ file: 'a', mtime: NOW, data: { agent: 'worker-002', ticket: '002', phase: 'fixing', updated: min(2) } }],
    watchdogState: { mtime: Date.parse(min(3)), keys: ['went-quiet|worker-002|002'] },
  })
  expect(s.agents.map(a => `${a.name}:${a.label}:${a.dot}`)).toEqual(['worker-002:fixing:waiting', 'schema:idle:waiting', 'tester:running:working']) // the watchdog flagged worker-002 as quiet
  expect(s.watchdog.dot).toBe('working')
  expect(s.problems).toEqual([{ kind: 'went-quiet', who: 'worker-002', ticket: '002' }])
  expect(summary(s)).toBe('▣ 1/5 done · 3 running · ⚠ 1')
})

test('a blocked team member marks the team ticket, and is counted once in alerts', async () => {
  const s = buildSnapshot({
    now: NOW, boardText: BOARD, agents: [], rules,
    statuses: [
      { file: 'a', mtime: NOW, data: { agent: 'api', ticket: '004', phase: 'building', updated: min(0) } },
      { file: 'b', mtime: NOW, data: { agent: 'ui', ticket: '004', phase: 'blocked', updated: min(1), blocker: 'needs a decision' } },
    ],
    watchdogState: { mtime: NOW, keys: ['blocked|ui|004'] },
  })
  expect(s.tickets.find(t => t.id === '004')?.state).toBe('blocked')
  expect(summary(s)).toBe('▣ 1/5 done · 1 running · ⚠ 1')
})

test('done tickets hide their workers; waiting shows what it waits for; quiet follows the watchdog', async () => {
  const statuses = [
    { file: 'a', mtime: Date.parse(min(16)), data: { agent: 'worker-001', ticket: '001', phase: 'incomplete' } }, // 001 is done
    { file: 'b', mtime: Date.parse(min(10)), data: { agent: 'worker-002', ticket: '002', phase: 'testing', waiting_on: 'tester and reviewer' } },
    { file: 'c', mtime: Date.parse(min(25)), data: { agent: 'worker-004', ticket: '004', phase: 'building' } },
  ]
  // No watchdog: the file time decides.
  const bare = buildSnapshot({ now: NOW, boardText: BOARD, agents: [], rules, statuses })
  expect(bare.agents.map(a => `${a.name}:${a.dot}:${a.quiet}:${a.waitingOn ?? '-'}`)).toEqual(['worker-002:waiting:false:tester and reviewer', 'worker-004:waiting:true:-'])
  // Watchdog running and it saw worker-004's files moving: not quiet.
  const calm = buildSnapshot({ now: NOW, boardText: BOARD, agents: [], rules, statuses, watchdogState: { mtime: NOW, keys: [] } })
  expect(calm.agents.find(a => a.name === 'worker-004')).toMatchObject({ dot: 'working', quiet: false })
  // Watchdog flagged it: quiet.
  const flagged = buildSnapshot({ now: NOW, boardText: BOARD, agents: [], rules, statuses, watchdogState: { mtime: NOW, keys: ['went-quiet|worker-004|004'] } })
  expect(flagged.agents.find(a => a.name === 'worker-004')).toMatchObject({ dot: 'waiting', quiet: true })
})

test('a watchdog whose rounds stopped turns red', async () => {
  const s = buildSnapshot({ now: NOW, boardText: BOARD, statuses: [], agents: [], rules, watchdogState: { mtime: Date.parse(min(40)), keys: [] } })
  expect(s.watchdog.dot).toBe('blocked')
})

test('a finished investigator does not turn the watchdog red while rounds keep landing', async () => {
  const s = buildSnapshot({
    now: NOW, boardText: BOARD, statuses: [], rules,
    agents: [{ id: 'w1', type: 'watchdog', status: 'completed', description: 'Investigate flagged problems' }],
    watchdogState: { mtime: Date.parse(min(14)), keys: [] }, // a timer may fire up to half a period late
  })
  expect(s.watchdog.dot).toBe('working')
  expect(s.agents).toEqual([]) // the investigator is not a worker dot
})

test('the map is 3 rows of 5, grows by columns with more agents, and folds overflow past the width into +N', async () => {
  const small = layoutMap(80, ['working', 'waiting'])
  expect(small.map(r => r.length)).toEqual([5, 5, 5])
  expect(small[0]?.slice(0, 3)).toEqual(['working', 'waiting', 'free'])
  expect(layoutMap(80, Array(15).fill('working')).map(r => r.length)).toEqual([5, 5, 5]) // exactly full
  const grown = layoutMap(80, Array(20).fill('working'))
  expect(grown.map(r => r.length)).toEqual([7, 7, 7]) // ceil(20 / 3) columns
  expect(grown.flat().filter(c => c === 'working').length).toBe(20)
  const narrow = layoutMap(11, Array(12).fill('working')) // room for 3 columns only
  expect(narrow.flat().length).toBe(9)
  expect(narrow[2]?.[2]).toEqual({ more: 4 })
})

test('the ticket list shows 10: unfinished first, topped up at the front with the latest finished ones', async () => {
  const mk = (n: number, state: string): TicketView => ({ id: String(n).padStart(3, '0'), title: `t${n}`, boardStatus: state === 'done' ? 'done' : 'ready', mode: 'solo', state, waitsFor: [] })
  const ids = (r: { shown: TicketView[] }) => r.shown.map(t => t.id)
  // 12 done, 4 unfinished, 2 drafts: the last 6 done, then the 4 unfinished
  const many = [...Array.from({ length: 12 }, (_, i) => mk(i + 1, 'done')), mk(13, 'building'), mk(14, 'queued'), mk(15, 'waiting'), mk(16, 'testing'), mk(17, 'draft'), mk(18, 'draft')]
  const a = pickTickets(many)
  expect(ids(a)).toEqual(['007', '008', '009', '010', '011', '012', '013', '014', '015', '016'])
  expect(a.earlierDone).toBe(6)
  expect(a.moreUnfinished).toBe(0)
  // 14 unfinished: the first 10, no finished ones
  const busy = pickTickets([mk(1, 'done'), ...Array.from({ length: 14 }, (_, i) => mk(i + 2, 'queued'))])
  expect(ids(busy)).toEqual(['002', '003', '004', '005', '006', '007', '008', '009', '010', '011'])
  expect(busy.moreUnfinished).toBe(4)
  expect(busy.earlierDone).toBe(1)
  // fewer than 10 overall: show them all
  expect(ids(pickTickets([mk(1, 'done'), mk(2, 'building'), mk(3, 'draft')]))).toEqual(['001', '002'])
})
