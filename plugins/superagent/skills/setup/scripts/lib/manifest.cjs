// The install manifest, .claude/superagent.json: the installed version and, per plugin-owned file,
// a hash of the template text with block contents blanked. A project file whose blanked hash
// differs from its manifest hash was edited outside its blocks.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { blankBlocks } = require('./blocks.cjs')

const MANIFEST = '.claude/superagent.json'

function hashText(text, file) {
  return crypto.createHash('sha256').update(blankBlocks(text, file)).digest('hex')
}

function readManifest(project) {
  const p = path.join(project, MANIFEST)
  if (!fs.existsSync(p)) return null
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function writeManifest(project, version, files) {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))
  fs.writeFileSync(path.join(project, MANIFEST), JSON.stringify({ version, files: sorted }, null, 2) + '\n')
}

module.exports = { MANIFEST, hashText, readManifest, writeManifest }
