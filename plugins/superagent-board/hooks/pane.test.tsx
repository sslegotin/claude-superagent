import { expect, test } from 'claude-code/testing'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const min = (m: number) => new Date(NOW - m * 60_000).toISOString()

// A fake project on disk: a board, one worker in a worktree, one team member, the watchdog's state.
const FILES: Record<string, string> = {
  '/proj/specs/tickets/BOARD.md': [
    '| # | Title | Status | Mode | Runs |', '|---|---|---|---|---|',
    '| 001 | Project skeleton | done | solo | alongside |',
    '| 002 | Create tickets | ready | solo | waits for 001: skeleton |',
    '| 003 | Configurable lifecycle | ready | team | waits for 001 |',
    '| 004 | Search | draft | solo | waits for 002 |',
  ].join('\n'),
  '/proj/.claude/worktrees/agent-a1/.job/status.json': JSON.stringify({ agent: 'worker-002', ticket: '002', phase: 'testing', started: min(12), updated: min(1), note: 'running E-4' }),
  '/proj/.job/status-schema.json': JSON.stringify({ agent: 'schema', ticket: '003', phase: 'blocked', blocker: 'needs a decision', updated: min(2) }),
  '/proj/.job/watchdog-state.json': JSON.stringify({ 'went-quiet|worker-002|002': NOW }),
  // git's record of the agent's worktree (how the pane finds agents), plus a person's named worktree to ignore
  '/proj/.git/worktrees/agent-a1/gitdir': '/proj/.claude/worktrees/agent-a1/.git\n',
  '/proj/.git/worktrees/phase-4-named/gitdir': '/proj/.claude/worktrees/phase-4-named/.git\n',
}
const DIRS: Record<string, { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }[]> = {
  '/proj/.git/worktrees': [
    { name: 'agent-a1', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    { name: 'phase-4-named', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
  ],
  '/proj/.job': [
    { name: 'status-schema.json', kind: 'file', size: 1, mtimeMs: NOW, isLink: false },
    { name: 'watchdog-state.json', kind: 'file', size: 1, mtimeMs: NOW - 60_000, isLink: false },
  ],
}

const pane = (surface: 'terminal' | 'desktop') => ({
  plugin: 'superagent-board', surface, component: 'Pane', requestId: 'superagent-board',
  props: { title: 'Super-agent', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
}) as const

test('the pane draws tickets, agents, watchdog alerts and the agent map', async ($, on) => {
  const statuses: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => { statuses.push((e as { text?: string }).text); return { value: undefined } })
  on('session.cwd', () => ({ value: '/proj' }))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('agent.list', () => ({ value: [] }))
  on('fs.exists', (_, e) => ({ value: (e as { path: string }).path in DIRS }))
  on('fs.list', (_, e) => ({ value: DIRS[(e as { path: string }).path] ?? [] }))
  on('fs.stat', (_, e) => ({ value: { kind: (e as { path: string }).path === '/proj/.git' ? 'dir' : 'file', size: 1, mtimeMs: NOW, isLink: false } }))
  on('fs.read', (_, e) => {
    const text = FILES[(e as { path: string }).path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  expect(statuses.at(-1)).toBe('▣ 1/4 done · 1 running · ⚠ 2')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ type: 'Text', text: /002 Create tickets/ }))?.text).toMatch(/testing/)
    expect((await ui.find({ type: 'Text', text: /running E-4/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /003 Configurable/ }))?.text).toMatch(/blocked/)
    expect((await ui.find({ type: 'Text', text: /went-quiet: worker-002/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /1 draft \(004\)/ }))?.text).toBeTruthy()
    await ui.unmount()
  }
})

test('without a board the pane says how to start', async $ => {
  const ui = await $.ui.mount(pane('terminal'))
  expect((await ui.find({ type: 'Text', text: /No tickets yet/ }))?.text).toBeTruthy()
  await ui.unmount()
})
