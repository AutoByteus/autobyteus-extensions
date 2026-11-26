// A small ustar writer and reader for extension packages (Node built-ins only).
import { gunzipSync, gzipSync } from 'node:zlib'

const pad = (length) => Buffer.alloc((512 - (length % 512)) % 512)
const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

function header(name, size, mode, type) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long for the package: ${name}`)
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(mode, 8), 100)
  block.write(octal(0, 8), 108)
  block.write(octal(0, 8), 116)
  block.write(octal(size, 12), 124)
  block.write(octal(0, 12), 136)
  block.fill(' ', 148, 156)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

/** Packs `{ name, data }` files (sorted, owner 0, time 0, mode 644) into a .tar.gz, folders first. */
export function packTarGz(files) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name))
  const folders = [...new Set(sorted.flatMap((file) => {
    const parts = file.name.split('/').slice(0, -1)
    return parts.map((_, index) => `${parts.slice(0, index + 1).join('/')}/`)
  }))].sort()
  const blocks = []
  for (const folder of folders) blocks.push(header(folder, 0, 0o755, '5'))
  for (const file of sorted) blocks.push(header(file.name, file.data.length, 0o644, '0'), file.data, pad(file.data.length))
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks), { level: 9 })
}

/** Reads the regular files of a .tar.gz: `Map<name, Buffer>` (names without a leading `./`). */
export function readTarGz(bytes) {
  const tar = gunzipSync(bytes)
  const files = new Map()
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
  for (let offset = 0; offset + 512 <= tar.length;) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const size = parseInt(field(block, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(block[156] || 48)
    const prefix = field(block, 345, 155)
    const name = (prefix ? `${prefix}/` : '') + field(block, 0, 100)
    if (type === '0') files.set(name.replace(/^\.\//, ''), Buffer.from(tar.subarray(offset + 512, offset + 512 + size)))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}
