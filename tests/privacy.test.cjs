// Guards the published repo: nothing personal, nothing from the video, no `eval` in the template.
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const SKIP = new Set(['.git', 'node_modules', '.superpowers'])

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

// Built from pieces so this file doesn't match itself.
const FORBIDDEN = new RegExp(
  ['\\/Us' + 'ers\\/', 'web' + 'labs', 'AI ' + 'LABS', 'you' + 'tube', 'you' + 'tu\\.be', '3Dkl' + 'R44DHnM',
    'm' + '31', 'tui-' + 'factory', 'game-' + 'night', 'todo-' + 'board', 'nether' + 'more'].join('|'),
  'i',
)

test('no private or video strings', () => {
  const hits = []
  for (const file of walk(ROOT)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (FORBIDDEN.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  assert.deepStrictEqual(hits, [])
})

test('no eval in template', () => {
  const dir = path.join(ROOT, 'plugins', 'superagent', 'template')
  const hits = []
  for (const file of fs.existsSync(dir) ? walk(dir) : []) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/\beval\b/.test(line) && !/No `eval`|refuses any command containing `eval`|\beval\b[^.]*(isolat|refus)/i.test(line)) {
        hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`)
      }
    })
  }
  assert.deepStrictEqual(hits, [])
})
