const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { parseBlocks, fillBlocks, blankBlocks, unfilledIds, UNFILLED } =
  require(path.resolve(__dirname, '..', 'plugins', 'superagent', 'skills', 'setup', 'scripts', 'lib', 'blocks.cjs'))

const doc = [
  'Intro <!-- PROJECT:one -->inline text<!-- /PROJECT:one --> end.',
  '<!-- PROJECT:two -->',
  '- Run: `node app.js` then check `<!-- x -->` stays',
  '- Line two',
  '<!-- /PROJECT:two -->',
  'Outro',
].join('\n')

test('parses block content verbatim', () => {
  assert.deepStrictEqual(parseBlocks(doc, 'a.md'), {
    one: 'inline text',
    two: '\n- Run: `node app.js` then check `<!-- x -->` stays\n- Line two\n',
  })
})

test('fills and reports missing and unused', () => {
  const out = fillBlocks(doc, { two: '\nnew\n', three: 'x' }, 'a.md')
  assert.deepStrictEqual(out.filled, ['two'])
  assert.deepStrictEqual(out.missing, ['one'])
  assert.deepStrictEqual(out.unused, ['three'])
  assert.strictEqual(parseBlocks(out.text, 'a.md').two, '\nnew\n')
  assert.strictEqual(parseBlocks(out.text, 'a.md').one, 'inline text')
  assert.ok(out.text.startsWith('Intro ') && out.text.endsWith('\nOutro'))
})

test('blank makes filled and unfilled hash the same', () => {
  const unfilled = fillBlocks(doc, { one: UNFILLED, two: `\n${UNFILLED}\n` }, 'a.md').text
  assert.strictEqual(blankBlocks(doc, 'a.md'), blankBlocks(unfilled, 'a.md'))
  assert.ok(!blankBlocks(doc, 'a.md').includes('inline text'))
})

test('lists unfilled ids', () => {
  const t = fillBlocks(doc, { one: UNFILLED }, 'a.md').text
  assert.deepStrictEqual(unfilledIds(t, 'a.md'), ['one'])
})

test('rejects broken markers', () => {
  assert.throws(() => parseBlocks('<!-- PROJECT:two -->\ntext', 'b.md'), /b\.md.*two/)
  assert.throws(() => parseBlocks('text\n<!-- /PROJECT:two -->', 'b.md'), /b\.md.*two/)
  assert.throws(() => parseBlocks('<!-- PROJECT:a -->x<!-- /PROJECT:a --><!-- PROJECT:a -->y<!-- /PROJECT:a -->', 'b.md'), /b\.md.*a/)
})
