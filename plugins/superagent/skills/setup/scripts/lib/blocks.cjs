// Project blocks: text between <!-- PROJECT:<id> --> and <!-- /PROJECT:<id> --> markers.
// The installer carries their content across upgrades; everything outside them belongs to the plugin.

const UNFILLED = '(not filled in yet: run /superagent:setup)'
const MARKER = /<!-- (\/?)PROJECT:([a-z0-9-]+) -->/g

// Returns [{ id, start, end }] where start..end is the content between the markers.
function scan(text, file) {
  const blocks = []
  const seen = new Set()
  let open = null
  for (const m of text.matchAll(MARKER)) {
    const [marker, slash, id] = m
    if (!slash) {
      if (open) throw new Error(`${file}: block ${open.id} is not closed before block ${id} opens`)
      if (seen.has(id)) throw new Error(`${file}: block ${id} appears twice`)
      seen.add(id)
      open = { id, start: m.index + marker.length }
    } else {
      if (!open || open.id !== id) throw new Error(`${file}: closing marker for block ${id} has no matching opening marker`)
      blocks.push({ id, start: open.start, end: m.index })
      open = null
    }
  }
  if (open) throw new Error(`${file}: block ${open.id} has no closing marker`)
  return blocks
}

function parseBlocks(text, file) {
  const out = {}
  for (const b of scan(text, file)) out[b.id] = text.slice(b.start, b.end)
  return out
}

// Replaces block contents with the given ones; ids without an entry keep their text.
function fillBlocks(text, blocks, file) {
  const found = scan(text, file)
  const filled = []
  const missing = []
  let out = ''
  let pos = 0
  for (const b of found) {
    out += text.slice(pos, b.start)
    if (Object.hasOwn(blocks, b.id)) {
      out += blocks[b.id]
      filled.push(b.id)
    } else {
      out += text.slice(b.start, b.end)
      missing.push(b.id)
    }
    pos = b.end
  }
  out += text.slice(pos)
  const ids = new Set(found.map(b => b.id))
  const unused = Object.keys(blocks).filter(id => !ids.has(id))
  return { text: out, filled, missing, unused }
}

function blankBlocks(text, file) {
  const empty = {}
  for (const b of scan(text, file)) empty[b.id] = ''
  return fillBlocks(text, empty, file).text
}

function unfilledIds(text, file) {
  return Object.entries(parseBlocks(text, file)).filter(([, v]) => v.trim() === UNFILLED).map(([id]) => id)
}

module.exports = { UNFILLED, parseBlocks, fillBlocks, blankBlocks, unfilledIds }
