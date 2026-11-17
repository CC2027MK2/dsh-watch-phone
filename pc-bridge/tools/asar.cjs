const fs = require('fs')
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

const mode = process.argv[2]
if (mode === 'list') {
  const re = new RegExp(process.argv[3])
  for (const p of files.keys()) if (re.test(p)) console.log(files.get(p).size, p)
} else if (mode === 'cat') {
  const p = process.argv[3]
  const out = readFile(p)
  if (out === null) { console.error('not found: ' + p); process.exit(2) }
  process.stdout.write(out)
} else if (mode === 'grep') {
  const re = new RegExp(process.argv[3])
  const limit = Number(process.argv[4] || 20)
  let n = 0
  for (const [p, meta] of files) {
    if (!/\.(ts|js|mjs|cjs|json)$/.test(p)) continue
    if (meta.size > 3_000_000) continue
    const text = readFile(p)
    const lines = text.split('\n')
    let hit = false
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        if (!hit) { console.log('=== ' + p); hit = true }
        console.log(String(i + 1).padStart(5) + ': ' + lines[i].slice(0, 220))
        if (++n >= limit) process.exit(0)
      }
    }
  }
}
