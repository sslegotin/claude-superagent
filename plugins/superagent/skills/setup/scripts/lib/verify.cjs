// Checks an installed setup: every project block filled, and the helper scripts behave as the
// agents rely on (a crashing hook would let everything through).
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { unfilledIds } = require('./blocks.cjs')

function runNode(project, args, input) {
  return spawnSync('node', args, { cwd: project, input, encoding: 'utf8', timeout: 30_000 })
}

function selftests(project) {
  const guard = '.claude/hooks/router-guard.cjs'
  const tests = [
    ['router-guard denies the router a write', () => {
      const r = runNode(project, [guard], '{"tool_name":"Write","tool_input":{}}')
      return [r.status === 0 && r.stdout.includes('"permissionDecision":"deny"'), r.stdout.trim() || r.stderr.trim()]
    }],
    ['router-guard lets subagents and teammates write', () => {
      const r = runNode(project, [guard], '{"tool_name":"Write","agent_id":"x","tool_input":{}}')
      return [r.status === 0 && r.stdout.trim() === '', r.stdout.trim() || r.stderr.trim()]
    }],
    ['watchdog check runs', () => {
      const r = runNode(project, ['.claude/watchdog/check.cjs'])
      return [r.status === 0, `exit ${r.status} ${r.stderr.trim()}`.trim()]
    }],
    ['verify-results reports a missing ticket as incomplete', () => {
      const r = runNode(project, ['.claude/hooks/verify-results.cjs', 'specs/tickets/none'])
      return [r.status === 1 && r.stdout.includes('INCOMPLETE'), `exit ${r.status} ${r.stdout.trim().slice(0, 200)}`]
    }],
  ]
  return tests.map(([name, fn]) => {
    try {
      const [ok, detail] = fn()
      return { name, ok, detail }
    } catch (err) {
      return { name, ok: false, detail: err.message }
    }
  })
}

function verify(project) {
  const unfilled = {}
  const agents = path.join(project, '.claude', 'agents')
  for (const f of fs.existsSync(agents) ? fs.readdirSync(agents).filter(f => f.endsWith('.md')).sort() : []) {
    const rel = `.claude/agents/${f}`
    const ids = unfilledIds(fs.readFileSync(path.join(project, rel), 'utf8'), rel)
    if (ids.length) unfilled[rel] = ids
  }
  const selftest = selftests(project)
  return { ok: Object.keys(unfilled).length === 0 && selftest.every(t => t.ok), unfilled, selftest }
}

module.exports = { verify }
