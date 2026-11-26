#!/usr/bin/env node
// Packs one extension folder into dist/<id>-<version>.tar.gz and writes its SHA-256 next to it.
//
//   node scripts/pack.mjs <id> [--expect-version <x.y.z>]
//
// The package holds extension.json, server/index.mjs and ui/** (contract §2), sorted, with fixed owner, time and modes.
// --expect-version (the release workflow passes the tag's version) refuses a tag that does not match extension.json.
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkDescription, packageFiles } from './lib/extension-package.mjs'
import { packTarGz } from './lib/tar-gz.mjs'

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export async function packExtension(id, { outDir = path.join(repository, 'dist'), expectVersion = null } = {}) {
  const folder = path.join(repository, id)
  const description = checkDescription(JSON.parse(await fs.readFile(path.join(folder, 'extension.json'), 'utf8')), `${id}/extension.json`)
  if (description.id !== id) throw new Error(`${id}/extension.json has the id ${description.id}`)
  if (expectVersion && description.version !== expectVersion) {
    throw new Error(`${id}/extension.json is version ${description.version}, not ${expectVersion}`)
  }
  const bytes = packTarGz(await packageFiles(folder))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const file = path.join(outDir, `${id}-${description.version}.tar.gz`)
  await fs.mkdir(outDir, { recursive: true })
  await fs.writeFile(file, bytes)
  await fs.writeFile(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`)
  return { file, sha256, description }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [id, ...rest] = process.argv.slice(2)
  const expectIndex = rest.indexOf('--expect-version')
  if (!id) { console.error('usage: node scripts/pack.mjs <id> [--expect-version <x.y.z>]'); process.exit(2) }
  try {
    const { file, sha256 } = await packExtension(id, { expectVersion: expectIndex >= 0 ? rest[expectIndex + 1] : null })
    console.log(`${path.relative(repository, file)} ${sha256}`)
  } catch (error) {
    console.error(`pack: ${error.message}`)
    process.exit(1)
  }
}
