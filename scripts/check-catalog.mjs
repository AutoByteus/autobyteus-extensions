#!/usr/bin/env node
// Checks catalog.json before it is signed (contract §3): every entry is a valid description with packageUrl and
// sha256, ids are unique, and each package downloads, matches its SHA-256 and holds an extension.json equal to its
// entry without packageUrl and sha256, plus server/index.mjs and ui/index.html.
//
//   node scripts/check-catalog.mjs [catalog.json]
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalDescription, checkDescription } from './lib/extension-package.mjs'
import { readTarGz } from './lib/tar-gz.mjs'

export async function checkCatalog(catalogFile, fetchUrl = fetch) {
  const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8'))
  if (!Array.isArray(catalog?.extensions)) throw new Error('catalog.json must be { "extensions": [ … ] }')
  const seen = new Set()
  for (const entry of catalog.extensions) {
    checkDescription(entry, `catalog entry ${entry?.id}`)
    if (seen.has(entry.id)) throw new Error(`catalog lists ${entry.id} twice`)
    seen.add(entry.id)
    if (!/^https:\/\//.test(entry.packageUrl ?? '')) throw new Error(`${entry.id}: packageUrl must be an https URL`)
    if (!/^[0-9a-f]{64}$/.test(entry.sha256 ?? '')) throw new Error(`${entry.id}: sha256 must be 64 hex characters`)
    const response = await fetchUrl(entry.packageUrl, { redirect: 'follow' })
    if (!response.ok) throw new Error(`${entry.id}: ${entry.packageUrl} answered HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`${entry.id}: the package does not match its sha256`)
    const files = readTarGz(bytes)
    for (const required of ['extension.json', 'server/index.mjs', 'ui/index.html']) {
      if (!files.has(required)) throw new Error(`${entry.id}: the package has no ${required}`)
    }
    const packaged = JSON.parse(files.get('extension.json').toString('utf8'))
    if (canonicalDescription(packaged) !== canonicalDescription(entry)) {
      throw new Error(`${entry.id}: the package's extension.json differs from its catalog entry`)
    }
  }
  return catalog.extensions.map((entry) => `${entry.id} ${entry.version}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = path.resolve(process.argv[2] ?? 'catalog.json')
  try {
    const checked = await checkCatalog(file)
    console.log(`catalog ok: ${checked.join(', ') || 'no extensions'}`)
  } catch (error) {
    console.error(`check-catalog: ${error.message}`)
    process.exit(1)
  }
}
