const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'superagent')
const SCRIPT = path.join(PLUGIN, 'skills', 'setup', 'scripts', 'install.cjs')
const { fillBlocks, parseBlocks } = require(path.join(PLUGIN, 'skills', 'setup', 'scripts', 'lib', 'blocks.cjs'))

function makeRepo(extra = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-verify-')))
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'test')
  for (const [rel, text] of Object.entries({ 'README.md': '# sample\n', ...extra })) fs.writeFileSync(path.join(dir, rel), text)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  return dir
}

const run = (cmd, project) => {
  const r = spawnSync('node', [SCRIPT, cmd, '--project', project], { encoding: 'utf8' })
  return { status: r.status, out: JSON.parse(r.stdout) }
}

function fillAll(project) {
  const dir = path.join(project, '.claude', 'agents')
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const text = fs.readFileSync(p, 'utf8')
    const ids = Object.keys(parseBlocks(text, f))
    fs.writeFileSync(p, fillBlocks(text, Object.fromEntries(ids.map(id => [id, '\nfilled\n'])), f).text)
  }
}

test('fresh install is not ok', () => {
  const p = makeRepo()
  run('apply', p)
  const r = run('verify', p)
  assert.strictEqual(r.status, 1)
  assert.strictEqual(r.out.ok, false)
  assert.strictEqual(Object.values(r.out.unfilled).flat().length, 9)
  assert.ok(r.out.selftest.length >= 4)
  assert.ok(r.out.selftest.every(t => t.ok), JSON.stringify(r.out.selftest))
})

test('filled install is ok', () => {
  const p = makeRepo()
  run('apply', p)
  fillAll(p)
  const r = run('verify', p)
  assert.strictEqual(r.status, 0, JSON.stringify(r.out))
  assert.strictEqual(r.out.ok, true)
  assert.deepStrictEqual(r.out.unfilled, {})
})

test('module type project', () => {
  const p = makeRepo({ 'package.json': '{"type":"module"}\n' })
  run('apply', p)
  fillAll(p)
  const r = run('verify', p)
  assert.strictEqual(r.out.ok, true, JSON.stringify(r.out.selftest))
})

test('a broken hook fails verify', () => {
  const p = makeRepo()
  run('apply', p)
  fillAll(p)
  fs.writeFileSync(path.join(p, '.claude', 'hooks', 'router-guard.cjs'), 'process.exit(0)\n')
  const r = run('verify', p)
  assert.strictEqual(r.out.ok, false)
  assert.ok(r.out.selftest.some(t => !t.ok && /router-guard/.test(t.name)))
})
