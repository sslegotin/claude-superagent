#!/usr/bin/env node
// Installs, upgrades and verifies the super-agent setup in a project. Deterministic: no questions,
// no git changes. The /superagent:setup skill runs it and handles everything that needs judgment.
//
//   node install.cjs plan   --project <repo root>
//   node install.cjs apply  --project <repo root> [--take <file>]... [--blocks <json>] [--drop <file>:<id>]... [--backup]
//   node install.cjs verify --project <repo root>
//
// Prints one JSON object. Exit 0: done. Exit 2 with {"error"}: refused, nothing was written.
// Exit 1 with {"error"}: an unexpected failure. verify exits 1 when the setup isn't ok.
// apply reads and checks every input and builds every output before it writes anything.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { parseBlocks, fillBlocks, UNFILLED } = require('./lib/blocks.cjs')
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
  const args = { cmd: argv[0], take: [], drop: [] }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--project') args.project = argv[++i]
    else if (a === '--template') args.template = argv[++i]
    else if (a === '--blocks') args.blocks = argv[++i]
    else if (a === '--take') args.take.push(argv[++i])
    else if (a === '--drop') args.drop.push(argv[++i])
    else if (a === '--backup') args.backup = true
    else throw new Refusal(`unknown argument ${a}`)
  }
  if (!['plan', 'apply', 'verify'].includes(args.cmd)) throw new Refusal('usage: install.cjs plan|apply|verify --project <repo root>')
  if (!args.project) throw new Refusal('--project <repo root> is required')
  return args
}

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' })

function repoRoot(project) {
  const dir = fs.realpathSync(path.resolve(project))
  const r = git(dir, 'rev-parse', '--show-toplevel')
  if (r.status !== 0) throw new Refusal(`${dir} is not inside a git repository (run git init -b main and make a first commit)`)
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

// JSON from a file: null if it doesn't exist, {} if it's empty, a refusal naming the file if it's invalid.
function readJson(file, label) {
  const text = readIf(file)
  if (text === null) return null
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Refusal(`${label} is not valid JSON (${err.message}); fix it and run again`)
  }
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  }
  return 0
}

function loadTemplate(templateDir) {
  const pluginJson = path.join(templateDir, '..', '.claude-plugin', 'plugin.json')
  const version = JSON.parse(fs.readFileSync(pluginJson, 'utf8')).version
  return { dir: templateDir, version, files: walk(templateDir) }
}

// A block is "filled" when it holds something other than the placeholder.
const isFilled = text => text.trim() !== '' && text.trim() !== UNFILLED

function plan(project, tpl) {
  const manifest = readManifest(project)
  const hasRouter = fs.existsSync(path.join(project, '.claude/agents/router.md'))
  let mode = manifest ? 'current' : hasRouter ? 'adopt' : 'fresh'
  if (manifest) {
    const c = compareVersions(manifest.version, tpl.version)
    mode = c === 0 ? 'current' : c < 0 ? 'upgrade' : 'downgrade'
  }
  const known = manifest?.files ?? {}
  const branch = git(project, 'branch', '--show-current').stdout.trim()
  const result = {
    mode, from: manifest?.version ?? null, to: tpl.version,
    add: [], replace: [], unchanged: [], edited: [], remove: [], blocks: {},
    settings: [], gitignore: [], board: false, legacy: [],
    mainBranch: git(project, 'rev-parse', '--verify', '--quiet', 'refs/heads/main').status === 0,
    branch,
    batchRunning: branch.startsWith('batch/') || fs.existsSync(path.join(project, '.job', 'merge.lock')),
  }

  for (const rel of tpl.files) {
    if (MERGED.has(rel)) continue
    const tplText = fs.readFileSync(path.join(tpl.dir, rel), 'utf8')
    const projText = readIf(path.join(project, rel))
    if (PROJECT_OWNED.has(rel)) { result.board = projText === null; continue }
    const tplIds = Object.keys(parseBlocks(tplText, rel))
    if (projText === null) {
      result.add.push(rel)
      if (tplIds.length) result.blocks[rel] = { carried: [], new: tplIds, dropped: [], droppedFilled: [] }
      continue
    }
    if (mode === 'adopt') {
      result.replace.push(rel)
      if (tplIds.length) result.blocks[rel] = { carried: [], new: tplIds, dropped: [], droppedFilled: [] }
      continue
    }
    const projHash = hashText(projText, rel)
    if (!known[rel] || projHash !== known[rel]) { result.edited.push(rel); continue }
    if (projHash === hashText(tplText, rel)) { result.unchanged.push(rel); continue }
    result.replace.push(rel)
    const projBlocks = parseBlocks(projText, rel)
    const projIds = Object.keys(projBlocks)
    if (tplIds.length || projIds.length) {
      const dropped = projIds.filter(id => !tplIds.includes(id))
      result.blocks[rel] = {
        carried: tplIds.filter(id => projIds.includes(id)),
        new: tplIds.filter(id => !projIds.includes(id)),
        dropped,
        droppedFilled: dropped.filter(id => isFilled(projBlocks[id])),
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

  const settings = readJson(path.join(project, SETTINGS), SETTINGS) ?? {}
  result.settings = mergeSettings(settings).changes
  result.gitignore = addGitignore(readIf(path.join(project, '.gitignore'))).added
  result.legacy = LEGACY.filter(p => fs.existsSync(path.join(project, p)))
  return result
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

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function apply(project, tpl, args) {
  const p = plan(project, tpl)

  // 1. Refusals that need no file contents.
  if (p.mode === 'downgrade') throw new Refusal(`this plugin (${tpl.version}) is older than the setup installed here (${p.from}); update the plugin first`)
  if (p.mode === 'adopt' && !args.backup) throw new Refusal('adopt mode: this project has a hand-installed setup; run apply with --backup (and --blocks with the mapped project text)')
  for (const rel of args.take) {
    if (!p.edited.includes(rel)) throw new Refusal(`--take ${rel}: not an edited file in this plan`)
    if (!tpl.files.includes(rel)) throw new Refusal(`--take ${rel}: the new version no longer has this file; keep or delete it by hand`)
  }

  // 2. Read and check every input.
  const given = args.blocks ? readJson(args.blocks, `--blocks file ${args.blocks}`) ?? {} : {}
  const projSettings = readJson(path.join(project, SETTINGS), SETTINGS) ?? {}
  const projRules = readJson(path.join(project, RULES), RULES)
  const tplRules = readJson(path.join(tpl.dir, RULES), `template ${RULES}`)
  const drops = new Set(args.drop)
  const toWrite = new Set([...p.add, ...p.replace, ...args.take])
  for (const rel of Object.keys(given)) {
    if (!toWrite.has(rel)) throw new Refusal(`--blocks names ${rel}, which this apply doesn't write`)
  }

  // 3. Build every output.
  const outputs = []
  const files = {}
  const result = { mode: p.mode, from: p.from, to: p.to, written: [], kept: [], removed: [], blocks: {}, backup: null }
  for (const rel of tpl.files) {
    if (MERGED.has(rel) || PROJECT_OWNED.has(rel)) continue
    const tplText = fs.readFileSync(path.join(tpl.dir, rel), 'utf8')
    files[rel] = hashText(tplText, rel)
    if (!toWrite.has(rel)) {
      if (p.edited.includes(rel)) result.kept.push(rel)
      continue
    }
    const tplIds = Object.keys(parseBlocks(tplText, rel))
    const projText = readIf(path.join(project, rel))
    const projBlocks = projText !== null && p.mode !== 'adopt' ? parseBlocks(projText, rel) : {}
    const carried = Object.fromEntries(Object.entries(projBlocks).filter(([id]) => tplIds.includes(id)))
    for (const [id, text] of Object.entries(projBlocks)) {
      if (tplIds.includes(id) || !isFilled(text) || drops.has(`${rel}:${id}`)) continue
      throw new Refusal(`${rel}: the new version has no block ${id}, which holds project text; move it with --blocks and pass --drop ${rel}:${id}`)
    }
    const filled = fillBlocks(tplText, { ...carried, ...(given[rel] ?? {}) }, rel)
    if (filled.unused.length) throw new Refusal(`--blocks: ${rel} has no block ${filled.unused.join(', ')}`)
    let outIds
    try {
      outIds = Object.keys(parseBlocks(filled.text, rel))
    } catch (err) {
      throw new Refusal(`block text for ${rel} contains a block marker: ${err.message}`)
    }
    if (!sameJson(outIds, tplIds)) throw new Refusal(`block text for ${rel} contains a block marker`)
    outputs.push([rel, filled.text])
    if (filled.filled.length || filled.missing.length) result.blocks[rel] = { filled: filled.filled, unfilled: filled.missing }
  }
  for (const rel of p.edited) if (!tpl.files.includes(rel)) result.kept.push(rel)
  const mergedRules = mergeRules(projRules ?? {}, tplRules)
  const mergedSettings = mergeSettings(JSON.parse(JSON.stringify(projSettings))).settings
  const gi = addGitignore(readIf(path.join(project, '.gitignore')))

  // 4. Write.
  if (args.backup) result.backup = backup(project, tpl)
  const writeFile = (rel, text) => {
    const target = path.join(project, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text)
  }
  for (const [rel, text] of outputs) { writeFile(rel, text); result.written.push(rel) }
  for (const rel of p.remove) { fs.rmSync(path.join(project, rel)); result.removed.push(rel) }
  if (projRules === null || !sameJson(mergedRules, projRules)) writeFile(RULES, JSON.stringify(mergedRules, null, 2) + '\n')
  if (!fs.existsSync(path.join(project, SETTINGS)) || !sameJson(mergedSettings, projSettings)) writeFile(SETTINGS, JSON.stringify(mergedSettings, null, 2) + '\n')
  if (gi.added.length) writeFile('.gitignore', gi.text)
  if (p.board) writeFile(BOARD, fs.readFileSync(path.join(tpl.dir, BOARD), 'utf8'))
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
