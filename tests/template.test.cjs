// The bundled template: named project blocks, guidance for each, no web-only wording outside blocks.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const PLUGIN = path.resolve(__dirname, '..', 'plugins', 'superagent')
const AGENTS = path.join(PLUGIN, 'template', '.claude', 'agents')
const BLOCK_IDS = ['router-project', 'router-ports', 'router-cap', 'worker-run', 'teammate-run',
  'tester-run', 'checker-run', 'reproducer-run', 'merger-checks']

const agentFiles = () => fs.readdirSync(AGENTS).filter(f => f.endsWith('.md')).map(f => path.join(AGENTS, f))
const stripBlocks = text => text.replace(/<!-- PROJECT:([a-z-]+) -->[\s\S]*?<!-- \/PROJECT:\1 -->/g, '')

test('every block id once', () => {
  const opens = []
  for (const file of agentFiles()) {
    const text = fs.readFileSync(file, 'utf8')
    for (const m of text.matchAll(/<!-- PROJECT:([a-z-]+) -->/g)) {
      opens.push(m[1])
      assert.ok(text.includes(`<!-- /PROJECT:${m[1]} -->`), `${path.basename(file)}: ${m[1]} has no closing marker`)
    }
  }
  assert.deepStrictEqual([...opens].sort(), [...BLOCK_IDS].sort())
})

test('no old markers', () => {
  for (const file of agentFiles()) {
    assert.ok(!/<!-- PROJECT: /.test(fs.readFileSync(file, 'utf8')), `${path.basename(file)} has an old-style block`)
  }
})

test('blocks.md covers every id', () => {
  const guide = fs.readFileSync(path.join(PLUGIN, 'skills', 'setup', 'blocks.md'), 'utf8')
  for (const id of BLOCK_IDS) assert.match(guide, new RegExp(`^## ${id}$`, 'm'), `blocks.md lacks ## ${id}`)
})

test('no web-only wording outside blocks', () => {
  const hits = []
  for (const file of agentFiles()) {
    stripBlocks(fs.readFileSync(file, 'utf8')).split('\n').forEach((line, i) => {
      if (/agent-browser|3102|t002|port 3000|screenshot|dev server/i.test(line)) hits.push(`${path.basename(file)}: ${line.trim().slice(0, 100)}`)
    })
  }
  assert.deepStrictEqual(hits, [])
})
