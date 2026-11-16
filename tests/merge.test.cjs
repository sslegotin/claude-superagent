const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { mergeSettings, mergeRules, addGitignore } =
  require(path.resolve(__dirname, '..', 'plugins', 'superagent', 'skills', 'setup', 'scripts', 'lib', 'merge.cjs'))

const MARKET = { source: { source: 'github', repo: 'sslegotin/claude-superagent' } }

test('adds setup keys', () => {
  const { settings, changes } = mergeSettings({})
  assert.deepStrictEqual(settings, {
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    extraKnownMarketplaces: { superagent: MARKET },
    enabledPlugins: { 'superagent-board@superagent': true, 'superagent@superagent': true },
  })
  assert.ok(changes.length >= 4)
})

test('keeps foreign settings', () => {
  const before = {
    permissions: { allow: ['Bash(make:*)'] },
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
    env: { FOO: 'bar' },
    enabledPlugins: { 'other@market': true },
  }
  const { settings } = mergeSettings(JSON.parse(JSON.stringify(before)))
  assert.deepStrictEqual(settings.permissions, before.permissions)
  assert.deepStrictEqual(settings.hooks, before.hooks)
  assert.strictEqual(settings.env.FOO, 'bar')
  assert.strictEqual(settings.enabledPlugins['other@market'], true)
})

test('replaces legacy mod marketplace', () => {
  const { settings, changes } = mergeSettings({
    extraKnownMarketplaces: { 'superagent-mods': { source: { source: 'directory', path: './.claude/mods' } } },
    enabledPlugins: { 'superagent-board@superagent-mods': true },
  })
  assert.ok(!('superagent-mods' in settings.extraKnownMarketplaces))
  assert.ok(!('superagent-board@superagent-mods' in settings.enabledPlugins))
  assert.ok(changes.some(c => /superagent-mods/.test(c)))
})

test('settings already current reports no changes', () => {
  const { settings } = mergeSettings({})
  assert.deepStrictEqual(mergeSettings(settings).changes, [])
})

test('rules keeps project values', () => {
  const merged = mergeRules({ health_command: 'make up', ignore: ['x'], interval_minutes: 5 },
    { health_command: null, ignore: [], interval_minutes: 10, foo: 1 })
  assert.deepStrictEqual(merged, { health_command: 'make up', ignore: ['x'], interval_minutes: 5, foo: 1 })
})

test('gitignore without newline', () => {
  const { text, added } = addGitignore('node_modules')
  assert.strictEqual(text, 'node_modules\n\n# Added by the super-agent setup\n.claude/worktrees/\n.job/\n')
  assert.deepStrictEqual(added, ['.claude/worktrees/', '.job/'])
})

test('gitignore missing file', () => {
  assert.strictEqual(addGitignore(null).text, '# Added by the super-agent setup\n.claude/worktrees/\n.job/\n')
})

test('gitignore idempotent', () => {
  const once = addGitignore('node_modules\n').text
  const twice = addGitignore(once)
  assert.strictEqual(twice.text, once)
  assert.deepStrictEqual(twice.added, [])
})

test('gitignore keeps an entry that is already there', () => {
  const { text, added } = addGitignore('.job/\n')
  assert.deepStrictEqual(added, ['.claude/worktrees/'])
  assert.strictEqual(text, '.job/\n\n# Added by the super-agent setup\n.claude/worktrees/\n')
})
