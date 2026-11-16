// install.cjs plan/apply in scratch git repos.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'superagent')
const SCRIPT = path.join(PLUGIN, 'skills', 'setup', 'scripts', 'install.cjs')
const { parseBlocks, fillBlocks, UNFILLED } = require(path.join(PLUGIN, 'skills', 'setup', 'scripts', 'lib', 'blocks.cjs'))

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-install-')))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(dir, 'README.md'), '# sample\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// A copy of the plugin's template and manifest, so a test can change it and bump its version.
function makePluginCopy(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-plugin-'))
  fs.cpSync(path.join(PLUGIN, 'template'), path.join(dir, 'template'), { recursive: true })
  fs.mkdirSync(path.join(dir, '.claude-plugin'))
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'))
  if (version) manifest.version = version
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  return path.join(dir, 'template')
}

function run(cmd, project, ...extra) {
  const r = spawnSync('node', [SCRIPT, cmd, '--project', project, ...extra], { encoding: 'utf8' })
  let out = null
  try { out = JSON.parse(r.stdout) } catch { /* left null */ }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr }
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8')
const WORKER = '.claude/agents/worker.md'

function fillWorker(project, content) {
  const text = read(project, WORKER)
  fs.writeFileSync(path.join(project, WORKER), fillBlocks(text, { 'worker-run': content }, WORKER).text)
}

test('fresh install', () => {
  const p = makeRepo()
  const plan = run('plan', p)
  assert.strictEqual(plan.status, 0, plan.stderr)
  assert.strictEqual(plan.out.mode, 'fresh')
  assert.ok(plan.out.add.includes(WORKER))
  assert.strictEqual(plan.out.board, true)
  const applied = run('apply', p)
  assert.strictEqual(applied.status, 0, applied.stderr)
  assert.ok(fs.existsSync(path.join(p, WORKER)))
  assert.ok(fs.existsSync(path.join(p, '.claude/hooks/router-guard.cjs')))
  assert.ok(fs.existsSync(path.join(p, 'specs/tickets/BOARD.md')))
  const manifest = JSON.parse(read(p, '.claude/superagent.json'))
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/)
  assert.ok(manifest.files[WORKER])
  const settings = JSON.parse(read(p, '.claude/settings.json'))
  assert.strictEqual(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1')
  assert.match(read(p, '.gitignore'), /\.job\//)
  assert.strictEqual(parseBlocks(read(p, WORKER), WORKER)['worker-run'].trim(), UNFILLED)
})

test('rerun is current', () => {
  const p = makeRepo()
  run('apply', p)
  const plan = run('plan', p).out
  assert.strictEqual(plan.mode, 'current')
  assert.deepStrictEqual([plan.add, plan.replace, plan.edited, plan.remove, plan.settings, plan.gitignore],
    [[], [], [], [], [], []])
  assert.strictEqual(plan.board, false)
})

test('filled blocks do not count as edits', () => {
  const p = makeRepo()
  run('apply', p)
  fillWorker(p, '\n- Run: `make run`\n')
  const plan = run('plan', p).out
  assert.deepStrictEqual(plan.edited, [])
})

test('upgrade carries blocks', () => {
  const p = makeRepo()
  run('apply', p)
  fillWorker(p, '\n- Run: `make run`\n')
  const tpl = makePluginCopy('9.9.9')
  const tw = path.join(tpl, WORKER)
  fs.writeFileSync(tw, fs.readFileSync(tw, 'utf8').replace('You are a worker.', 'You are a worker, version nine.'))
  const plan = run('plan', p, '--template', tpl).out
  assert.strictEqual(plan.mode, 'upgrade')
  assert.ok(plan.replace.includes(WORKER))
  assert.deepStrictEqual(plan.blocks[WORKER].carried, ['worker-run'])
  run('apply', p, '--template', tpl)
  const text = read(p, WORKER)
  assert.match(text, /version nine/)
  assert.strictEqual(parseBlocks(text, WORKER)['worker-run'], '\n- Run: `make run`\n')
  assert.strictEqual(JSON.parse(read(p, '.claude/superagent.json')).version, '9.9.9')
})

test('edited file left alone', () => {
  const p = makeRepo()
  run('apply', p)
  const edited = read(p, WORKER).replace('You are a worker.', 'You are a careful worker.')
  fs.writeFileSync(path.join(p, WORKER), edited)
  const tpl = makePluginCopy('9.9.9')
  const plan = run('plan', p, '--template', tpl).out
  assert.ok(plan.edited.includes(WORKER))
  assert.ok(!plan.replace.includes(WORKER))
  run('apply', p, '--template', tpl)
  assert.strictEqual(read(p, WORKER), edited)
  // still reported as edited next time
  assert.ok(run('plan', p, '--template', tpl).out.edited.includes(WORKER))
})

test('take replaces an edited file and keeps its blocks', () => {
  const p = makeRepo()
  run('apply', p)
  fillWorker(p, '\nmine\n')
  fs.writeFileSync(path.join(p, WORKER), read(p, WORKER).replace('You are a worker.', 'You are a careful worker.'))
  run('apply', p, '--take', WORKER)
  const text = read(p, WORKER)
  assert.match(text, /You are a worker\./)
  assert.strictEqual(parseBlocks(text, WORKER)['worker-run'], '\nmine\n')
})

test('dropped file removed', () => {
  const p = makeRepo()
  run('apply', p)
  const tpl = makePluginCopy('9.9.9')
  fs.rmSync(path.join(tpl, '.claude/hooks/metrics.cjs'))
  fs.rmSync(path.join(tpl, '.claude/watchdog/rules.md'))
  fs.appendFileSync(path.join(p, '.claude/watchdog/rules.md'), '\nmy own rule\n')
  const plan = run('plan', p, '--template', tpl).out
  assert.ok(plan.remove.includes('.claude/hooks/metrics.cjs'))
  assert.ok(plan.edited.includes('.claude/watchdog/rules.md'))
  run('apply', p, '--template', tpl)
  assert.ok(!fs.existsSync(path.join(p, '.claude/hooks/metrics.cjs')))
  assert.ok(fs.existsSync(path.join(p, '.claude/watchdog/rules.md')))
})

test('adopt detected', () => {
  const p = makeRepo()
  fs.mkdirSync(path.join(p, '.claude/agents'), { recursive: true })
  fs.writeFileSync(path.join(p, '.claude/agents/router.md'), 'hand-filled router\n')
  fs.mkdirSync(path.join(p, '.claude/skills/adapt-superagent'), { recursive: true })
  fs.writeFileSync(path.join(p, '.claude/skills/adapt-superagent/SKILL.md'), 'old\n')
  const plan = run('plan', p).out
  assert.strictEqual(plan.mode, 'adopt')
  assert.ok(plan.replace.includes('.claude/agents/router.md'))
  assert.deepStrictEqual(plan.legacy, ['.claude/skills/adapt-superagent/'])
  const r = run('apply', p)
  assert.strictEqual(r.status, 2)
  assert.match(r.out.error, /--backup/)
})

test('adopt with blocks', () => {
  const p = makeRepo()
  fs.mkdirSync(path.join(p, '.claude/agents'), { recursive: true })
  fs.writeFileSync(path.join(p, '.claude/agents/router.md'), 'hand-filled router\n')
  const blocksFile = path.join(p, '..', `blocks-${path.basename(p)}.json`)
  fs.writeFileSync(blocksFile, JSON.stringify({ '.claude/agents/router.md': { 'router-project': 'Sample, a CLI.' } }))
  const r = run('apply', p, '--backup', '--blocks', blocksFile)
  assert.strictEqual(r.status, 0, r.stderr)
  const backups = fs.readdirSync(path.join(p, '.job/superagent-backup'))
  assert.strictEqual(backups.length, 1)
  assert.strictEqual(read(p, `.job/superagent-backup/${backups[0]}/.claude/agents/router.md`), 'hand-filled router\n')
  assert.strictEqual(parseBlocks(read(p, '.claude/agents/router.md'), 'router.md')['router-project'], 'Sample, a CLI.')
  assert.ok(fs.existsSync(path.join(p, '.claude/superagent.json')))
})

test('ignores worktrees and job', () => {
  const p = makeRepo()
  run('apply', p)
  const wt = path.join(p, '.claude/worktrees/agent-x/.claude/agents')
  fs.mkdirSync(wt, { recursive: true })
  fs.writeFileSync(path.join(wt, 'worker.md'), 'agent copy\n')
  fs.mkdirSync(path.join(p, '.job'), { recursive: true })
  fs.writeFileSync(path.join(p, '.job/status-x.json'), '{}')
  const tpl = makePluginCopy('9.9.9')
  const plan = run('plan', p, '--template', tpl).out
  const listed = [...plan.add, ...plan.replace, ...plan.unchanged, ...plan.edited, ...plan.remove]
  assert.ok(listed.every(f => !f.startsWith('.claude/worktrees/') && !f.startsWith('.job/')))
  run('apply', p, '--template', tpl)
  assert.strictEqual(fs.readFileSync(path.join(wt, 'worker.md'), 'utf8'), 'agent copy\n')
  assert.strictEqual(read(p, '.job/status-x.json'), '{}')
})

test('requires repo root', () => {
  const p = makeRepo()
  fs.mkdirSync(path.join(p, 'sub'))
  const r = run('plan', path.join(p, 'sub'))
  assert.strictEqual(r.status, 2)
  assert.ok(r.out.error.includes(p), r.out.error)
})

test('keeps CLAUDE.md and existing settings', () => {
  const p = makeRepo()
  fs.writeFileSync(path.join(p, 'CLAUDE.md'), '# mine\n')
  fs.mkdirSync(path.join(p, '.claude'))
  fs.writeFileSync(path.join(p, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make:*)'] } }))
  const r = run('apply', p)
  assert.strictEqual(r.status, 0, r.stderr)
  assert.strictEqual(read(p, 'CLAUDE.md'), '# mine\n')
  const settings = JSON.parse(read(p, '.claude/settings.json'))
  assert.deepStrictEqual(settings.permissions, { allow: ['Bash(make:*)'] })
  assert.strictEqual(settings.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, '1')
})

test('rules.json keeps project values on upgrade', () => {
  const p = makeRepo()
  run('apply', p)
  const rulesPath = path.join(p, '.claude/watchdog/rules.json')
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
  rules.health_command = 'make ping'
  fs.writeFileSync(rulesPath, JSON.stringify(rules))
  const tpl = makePluginCopy('9.9.9')
  const tr = path.join(tpl, '.claude/watchdog/rules.json')
  fs.writeFileSync(tr, JSON.stringify({ ...JSON.parse(fs.readFileSync(tr, 'utf8')), new_key: 7 }))
  run('apply', p, '--template', tpl)
  const after = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
  assert.strictEqual(after.health_command, 'make ping')
  assert.strictEqual(after.new_key, 7)
})
