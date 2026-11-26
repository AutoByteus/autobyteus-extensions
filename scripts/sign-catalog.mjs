#!/usr/bin/env node
// Signs the catalog with AutoByteus's catalog signing key (Ed25519) and writes the two release assets:
// <out>/extensions-catalog.json (the exact bytes of catalog.json) and <out>/extensions-catalog.json.sig (the base64
// signature over those bytes, no line break). The private key comes only from the environment variable
// EXTENSIONS_CATALOG_SIGNING_KEY (PEM, the repository secret of the same name); it is never printed or written. The
// signature is checked with the public key AutoByteus builds in (catalog-public-key.pem), so a secret that does not
// match it fails the release instead of publishing a catalog no node accepts. Node built-ins only.
//
//   EXTENSIONS_CATALOG_SIGNING_KEY=… node scripts/sign-catalog.mjs --catalog catalog.json --public-key catalog-public-key.pem --out dist
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const fail = (message) => { console.error(`sign-catalog: ${message}`); process.exit(1) }
const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  const value = index < 0 ? undefined : argv[index + 1]
  if (!value) fail(`--${name} is required`)
  return value
}
const catalogFile = option('catalog')
const publicKeyFile = option('public-key')
const outDir = option('out')

const secret = process.env.EXTENSIONS_CATALOG_SIGNING_KEY
if (!secret) fail('EXTENSIONS_CATALOG_SIGNING_KEY is not set')
let privateKey
try { privateKey = createPrivateKey(secret) } catch { fail('EXTENSIONS_CATALOG_SIGNING_KEY is not a readable private key') }
if (privateKey.asymmetricKeyType !== 'ed25519') fail('EXTENSIONS_CATALOG_SIGNING_KEY is not an Ed25519 key')

const bytes = fs.readFileSync(catalogFile)
const signature = sign(null, bytes, privateKey)
if (!verify(null, bytes, createPublicKey(fs.readFileSync(publicKeyFile)), signature)) {
  fail(`EXTENSIONS_CATALOG_SIGNING_KEY does not match the public key ${publicKeyFile}`)
}
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'extensions-catalog.json'), bytes)
fs.writeFileSync(path.join(outDir, 'extensions-catalog.json.sig'), signature.toString('base64'))
console.log(`Signed ${catalogFile}; the signature verifies with ${publicKeyFile}`)
