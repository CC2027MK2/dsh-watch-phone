const fs = require('node:fs')
const asar = 'C:\\Users\\excal\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const jsonBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, jsonBuf, 0, jsonSize, 16)
const header = JSON.parse(jsonBuf.toString('utf8'))
const baseOffset = 8 + headerSize

const files = new Map()
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name
    if (entry.files) walk(entry, p)
    else if (entry.offset !== undefined) files.set(p, { offset: Number(entry.offset), size: entry.size })
  }
}
walk(header, '')

function readFile(p) {
  const meta = files.get(p)
  if (!meta) return null
  const buf = Buffer.alloc(meta.size)
  fs.readSync(fd, buf, 0, meta.size, baseOffset + meta.offset)
  return buf.toString('utf8')
}

const needles = ['SKILL.md', "'skills'", '"skills"', 'skillsDirs', 'skillRoots', 'discoverSkills']
for (const [p, meta] of files) {
  if (!/\.(ts|js|mjs|cjs)$/.test(p)) continue
  if (meta.size > 2_000_000) continue
  const text = readFile(p)
  if (!needles.some((n) => text.includes(n))) continue
  const lines = text.split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    if (needles.some((n) => lines[i].includes(n))) hits.push(`${i + 1}: ${lines[i].trim().slice(0, 180)}`)
    if (hits.length >= 6) break
  }
  if (hits.length) {
    console.log('=== ' + p)
    for (const h of hits) console.log('   ' + h)
  }
}
