// The package and catalog release steps: a package holds the contract's layout, the catalog check refuses a package
// that differs from its entry, and the catalog signature verifies with the public key (contract §2, §3).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { checkCatalog } from '../scripts/check-catalog.mjs'
import { packExtension } from '../scripts/pack.mjs'
import { readTarGz } from '../scripts/lib/tar-gz.mjs'

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'extensions-release-'))

test('packs voice-input with the contract layout, the same bytes each time', async () => {
  const out = await tmp()
  const first = await packExtension('voice-input', { outDir: out })
  const second = await packExtension('voice-input', { outDir: out })
  assert.equal(first.sha256, second.sha256)
  const files = readTarGz(await fs.readFile(first.file))
  assert.deepEqual([...files.keys()].sort(), ['extension.json', 'server/index.mjs', 'ui/index.html'])
  assert.equal(JSON.parse(files.get('extension.json')).offeredOn, 'desktop-node')
  await assert.rejects(packExtension('voice-input', { outDir: out, expectVersion: '9.9.9' }), /is version 1\.0\.0, not 9\.9\.9/)
})

test('checks catalog entries against their packages', async () => {
  const out = await tmp()
  const { file, sha256, description } = await packExtension('voice-input', { outDir: out })
  const bytes = await fs.readFile(file)
  const fetchUrl = async () => new Response(bytes)
  const catalogFile = path.join(out, 'catalog.json')
  const entry = { ...description, packageUrl: 'https://github.com/AutoByteus/autobyteus-extensions/releases/download/voice-input-v1.0.0/voice-input-1.0.0.tar.gz', sha256 }
  await fs.writeFile(catalogFile, JSON.stringify({ extensions: [entry] }))
  assert.deepEqual(await checkCatalog(catalogFile, fetchUrl), ['voice-input 1.0.0'])
  await fs.writeFile(catalogFile, JSON.stringify({ extensions: [{ ...entry, description: 'changed' }] }))
  await assert.rejects(checkCatalog(catalogFile, fetchUrl), /differs from its catalog entry/)
  await fs.writeFile(catalogFile, JSON.stringify({ extensions: [{ ...entry, sha256: '0'.repeat(64) }] }))
  await assert.rejects(checkCatalog(catalogFile, fetchUrl), /does not match its sha256/)
  assert.deepEqual(await checkCatalog('catalog.json', fetchUrl), [])
})

test('signs the exact catalog bytes with the key from the environment, checked against the public key', async () => {
  const out = await tmp()
  const keys = generateKeyPairSync('ed25519')
  const publicKey = path.join(out, 'public.pem')
  await fs.writeFile(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }))
  const privatePem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  execFileSync(process.execPath, ['scripts/sign-catalog.mjs', '--catalog', 'catalog.json', '--public-key', publicKey, '--out', out], {
    env: { ...process.env, EXTENSIONS_CATALOG_SIGNING_KEY: privatePem },
  })
  const bytes = await fs.readFile(path.join(out, 'extensions-catalog.json'))
  assert.deepEqual(bytes, await fs.readFile('catalog.json'))
  const signature = Buffer.from(await fs.readFile(path.join(out, 'extensions-catalog.json.sig'), 'utf8'), 'base64')
  assert.equal(verify(null, bytes, createPublicKey(await fs.readFile(publicKey)), signature), true)

  const other = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  assert.throws(() => execFileSync(process.execPath, ['scripts/sign-catalog.mjs', '--catalog', 'catalog.json', '--public-key', publicKey, '--out', out], {
    env: { ...process.env, EXTENSIONS_CATALOG_SIGNING_KEY: other }, stdio: 'pipe',
  }), /does not match the public key/)
})
