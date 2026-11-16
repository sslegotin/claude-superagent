#!/usr/bin/env node
// Installs, upgrades and verifies the super-agent setup in a project. Deterministic: no questions,
// no git changes. The /superagent:setup skill runs it and handles everything that needs judgment.
//
//   node install.cjs plan   --project <repo root>
//   node install.cjs apply  --project <repo root> [--take <file>]... [--blocks <json>] [--backup]
//
// Prints one JSON object. Exit 0 on success, 2 with {"error"} when it refuses.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parseBlocks, fillBlocks } = require('./lib/blocks.cjs')
const { mergeSettings, mergeRules, addGitignore } = require('./lib/merge.cjs')
const { MANIFEST, hashText, readManifest, writeManifest } = require('./lib/manifest.cjs')

const SETTINGS = '.claude/settings.json'
const RULES = '.claude/watchdog/rules.json'
const BOARD = 'specs/tickets/BOARD.md'
const MERGED = new Set([RULES])
const PROJECT_OWNED = new Set([BOARD])
const LEGACY = ['.claude/skills/adapt-superagent/', '.claude/mods/']

class Refusal extends Error {}

function parseArgs(argv) {
  const args = { cmd: argv[0], take: [] }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = argv[++i]
    else if (a === '--template') args.template = argv[++i]
    else if (a === '--blocks') args.blocks = argv[++i]
    else if (a === '--take') args.take.push(argv[++i])
    else if (a === '--backup') args.backup = true
    else throw new Refusal(`unknown argument ${a}`)
  }
  if (!['plan', 'apply', 'verify'].includes(args.cmd)) throw new Refusal('usage: install.cjs plan|apply|verify --project <repo root>')
  if (!args.project) throw new Refusal('--project <repo root> is required')
  return args
}

function repoRoot(project) {
  const dir = fs.realpathSync(path.resolve(project))
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' })
  if (r.status !== 0) throw new Refusal(`${dir} is not inside a git repository (run git init and make a first commit)`)
  const top = fs.realpathSync(r.stdout.trim())
  if (top !== dir) throw new Refusal(`--project must be the repository root: ${top}`)
  return dir
}

function walk(root, dir = root, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(root, full, out)
    else if (e.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'))
  }
  return out.sort()
}

const readIf = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)

function loadTemplate(templateDir) {
  const pluginJson = path.join(templateDir, '..', '.claude-plugin', 'plugin.json')
  const version = JSON.parse(fs.readFileSync(pluginJson, 'utf8')).version
  const files = walk(templateDir)
  return { dir: templateDir, version, files }
}

function plan(project, tpl) {
  const manifest = readManifest(project)
  const hasRouter = fs.existsSync(path.join(project, '.claude/agents/router.md'))
  const mode = manifest ? (manifest.version === tpl.version ? 'current' : 'upgrade') : hasRouter ? 'adopt' : 'fresh'
  const known = manifest?.files ?? {}
  const result = { mode, from: manifest?.version ?? null, to: tpl.version, add: [], replace: [], unchanged: [], edited: [], remove: [], blocks: {}, settings: [], gitignore: [], board: false, legacy: [] }

  for (const rel of tpl.files) {
    if (MERGED.has(rel)) continue
    const tplText = fs.readFileSync(path.join(tpl.dir, rel), 'utf8')
    const projText = readIf(path.join(project, rel))
    if (PROJECT_OWNED.has(rel)) { result.board = projText === null; continue }
    const tplIds = Object.keys(parseBlocks(tplText, rel))
    if (projText === null) {
      result.add.push(rel)
      if (tplIds.length) result.blocks[rel] = { carried: [], new: tplIds, dropped: [] }
      continue
    }
    if (mode === 'adopt') {
      result.replace.push(rel)
      if (tplIds.length) result.blocks[rel] = { carried: [], new: tplIds, dropped: [] }
      continue
    }
    const projHash = hashText(projText, rel)
    if (!known[rel] || projHash !== known[rel]) { result.edited.push(rel); continue }
    if (projHash === hashText(tplText, rel)) { result.unchanged.push(rel); continue }
    result.replace.push(rel)
    const projIds = Object.keys(parseBlocks(projText, rel))
    if (tplIds.length || projIds.length) {
      result.blocks[rel] = {
        carried: tplIds.filter(id => projIds.includes(id)),
        new: tplIds.filter(id => !projIds.includes(id)),
        dropped: projIds.filter(id => !tplIds.includes(id)),
      }
    }
  }

  for (const rel of Object.keys(known)) {
    if (tpl.files.includes(rel)) continue
    const projText = readIf(path.join(project, rel))
    if (projText === null) continue
    if (hashText(projText, rel) === known[rel]) result.remove.push(rel)
    else result.edited.push(rel)
  }

  const settings = JSON.parse(readIf(path.join(project, SETTINGS)) ?? '{}')
  result.settings = mergeSettings(settings).changes
  result.gitignore = addGitignore(readIf(path.join(project, '.gitignore'))).added
  result.legacy = LEGACY.filter(p => fs.existsSync(path.join(project, p)))
  return result
}

function writeFile(project, rel, text) {
  const p = path.join(project, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}

function backup(project, tpl) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(project, '.job', 'superagent-backup', stamp)
  for (const rel of [...tpl.files, SETTINGS]) {
    const src = path.join(project, rel)
    if (!fs.existsSync(src)) continue
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true })
    fs.copyFileSync(src, path.join(dest, rel))
  }
  return path.relative(project, dest)
}

function apply(project, tpl, args) {
  const p = plan(project, tpl)
  if (p.mode === 'adopt' && !args.backup) throw new Refusal('adopt mode: this project has a hand-installed setup; run apply with --backup (and --blocks with the mapped project text)')
  const given = args.blocks ? JSON.parse(fs.readFileSync(args.blocks, 'utf8')) : {}
  for (const rel of args.take) {
    if (!p.edited.includes(rel)) throw new Refusal(`--take ${rel}: not an edited file in this plan`)
  }
  const result = { mode: p.mode, from: p.from, to: p.to, written: [], kept: [], removed: [], blocks: {}, backup: null }
  if (args.backup) result.backup = backup(project, tpl)

  const files = {}
  const toWrite = new Set([...p.add, ...p.replace, ...args.take])
  for (const rel of tpl.files) {
    if (MERGED.has(rel) || PROJECT_OWNED.has(rel)) continue
    const tplText = fs.readFileSync(path.join(tpl.dir, rel), 'utf8')
    files[rel] = hashText(tplText, rel)
    if (!toWrite.has(rel)) {
      if (p.edited.includes(rel)) result.kept.push(rel)
      continue
    }
    const projText = readIf(path.join(project, rel))
    const carried = projText !== null && p.mode !== 'adopt' ? parseBlocks(projText, rel) : {}
    const filled = fillBlocks(tplText, { ...carried, ...(given[rel] ?? {}) }, rel)
    // Ids the new template no longer has are dropped; they are listed in the plan.
    writeFile(project, rel, filled.text)
    result.written.push(rel)
    if (filled.filled.length || filled.missing.length) result.blocks[rel] = { filled: filled.filled, unfilled: filled.missing }
  }
  for (const rel of p.remove) { fs.rmSync(path.join(project, rel)); result.removed.push(rel) }
  for (const rel of p.edited) if (!tpl.files.includes(rel)) result.kept.push(rel)

  const tplRules = JSON.parse(fs.readFileSync(path.join(tpl.dir, RULES), 'utf8'))
  const projRules = readIf(path.join(project, RULES))
  writeFile(project, RULES, JSON.stringify(mergeRules(projRules ? JSON.parse(projRules) : {}, tplRules), null, 2) + '\n')

  const settings = mergeSettings(JSON.parse(readIf(path.join(project, SETTINGS)) ?? '{}')).settings
  writeFile(project, SETTINGS, JSON.stringify(settings, null, 2) + '\n')
  const gi = addGitignore(readIf(path.join(project, '.gitignore')))
  if (gi.added.length) fs.writeFileSync(path.join(project, '.gitignore'), gi.text)
  if (p.board) writeFile(project, BOARD, fs.readFileSync(path.join(tpl.dir, BOARD), 'utf8'))

  writeManifest(project, tpl.version, files)
  result.manifest = MANIFEST
  return result
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2))
    const project = repoRoot(args.project)
    const tpl = loadTemplate(path.resolve(args.template ?? path.join(__dirname, '..', '..', '..', 'template')))
    const out = args.cmd === 'plan' ? plan(project, tpl) : args.cmd === 'apply' ? apply(project, tpl, args) : require('./lib/verify.cjs').verify(project)
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    if (args.cmd === 'verify' && !out.ok) process.exitCode = 1
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: err.message }) + '\n')
    process.exitCode = err instanceof Refusal ? 2 : 1
  }
}

main()
