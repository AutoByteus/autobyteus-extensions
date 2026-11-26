// Voice Input's server part (contract §4) against a scripted voice runtime: a real manifest and runtime archive served
// over local HTTP, whose worker is a small Node script speaking the runtime's protocol (prepare; serve: ready, one JSON
// line per request and reply; a failed start writes one stderr line and exits 1, like runtime 0.3.2).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { packTarGz } from '../scripts/lib/tar-gz.mjs'

const WORKER = `#!/usr/bin/env node
const fs = require('node:fs'); const readline = require('node:readline');
const [command, ...args] = process.argv.slice(2); const arg = (name) => args[args.indexOf(name) + 1];
if (command === 'prepare') { fs.mkdirSync(arg('--model-path'), { recursive: true }); fs.appendFileSync(process.env.FAKE_WORKER_LOG, 'prepare\\n'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_WORKER_LOG, 'serve\\n');
if (process.env.FAKE_WORKER_FAIL) { process.stderr.write('loading\\nVoice Input worker could not start the mlx backend: FileNotFoundError: ffmpeg\\n'); process.exit(1); }
setTimeout(() => process.stdout.write(JSON.stringify({ type: 'ready', backendKind: arg('--backend') }) + '\\n'), 60);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line); const size = fs.statSync(request.audioPath).size;
  process.stdout.write(JSON.stringify({ requestId: request.requestId, ok: true, text: 'heard ' + size + ' bytes (' + request.languageMode + ')', noSpeech: false, detectedLanguage: 'en', error: null }) + '\\n');
});
`

let server, base, root, workerLog, part, n = 0
const archive = packTarGz([{ name: 'bin/voice-input-worker', data: Buffer.from(WORKER) }, { name: 'voice_input_worker.py', data: Buffer.from('# stand-in') }])
const platform = `${process.platform}-${process.arch}`
const [os_, cpu] = platform.split('-')
const ctxOf = (logs = [], progress = []) => ({ dir: path.join(root, 'voice-input', 'data'), platform, log: (line) => logs.push(line), progress: (p) => progress.push(p) })
const load = async () => (await import(`${pathToFileURL(path.resolve('voice-input/server/index.mjs')).href}?test=${++n}`)).default
const calls = async () => (await fs.readFile(workerLog, 'utf8').catch(() => '')).split('\n').filter(Boolean)

before(async () => {
  server = http.createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.end(JSON.stringify({ runtimeVersion: '0.3.2', assets: [{
        platform: os_, arch: cpu, fileName: 'runtime.tar.gz', url: `${base}/runtime.tar.gz`,
        sha256: createHash('sha256').update(archive).digest('hex'), entrypoint: 'bin/voice-input-worker', backendKind: 'mlx',
        model: { id: 'whisper-small-mlx', sourceRepo: 'mlx-community/whisper-small-mlx' },
      }] }))
    } else if (request.url === '/runtime.tar.gz') response.end(archive)
    else { response.statusCode = 404; response.end() }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${server.address().port}`
  process.env.AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL = `${base}/manifest.json`
})
after(() => { server.close(); delete process.env.AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL })
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-input-test-'))
  workerLog = path.join(root, 'worker.log')
  process.env.FAKE_WORKER_LOG = workerLog
  delete process.env.FAKE_WORKER_FAIL
  await fs.mkdir(ctxOf().dir, { recursive: true })
  part = await load()
})

test('install downloads and checks the runtime, prepares the model, and reports progress without a percent', async () => {
  const progress = []
  await part.install(ctxOf([], progress))
  assert.deepEqual(progress, [{ message: 'Preparing the speech model (downloads about 2 GB once; this can take a few minutes)', percent: null }])
  const installation = JSON.parse(await fs.readFile(path.join(ctxOf().dir, 'installation.json'), 'utf8'))
  assert.deepEqual(installation, { runtimeVersion: '0.3.2', backendKind: 'mlx', entrypoint: 'bin/voice-input-worker', modelId: 'whisper-small-mlx' })
  await fs.access(path.join(ctxOf().dir, 'models', 'whisper-small-mlx'))
  await assert.rejects(fs.access(path.join(ctxOf().dir, 'downloads')))
  assert.deepEqual(await calls(), ['prepare'])
  assert.deepEqual(await part.status(ctxOf()), { ready: true, message: 'Ready.' })

  // An update with the same runtime keeps runtime, model and language: nothing is downloaded again.
  const again = []
  await (await load()).install(ctxOf([], again))
  assert.deepEqual(again, [{ message: 'Keeping your voice runtime, speech model and language', percent: null }])
  assert.deepEqual(await calls(), ['prepare'])
})

test('start warms the worker: Getting ready while it loads, Ready after; transcribe uses the warm worker', async () => {
  await part.install(ctxOf())
  const starting = part.start(ctxOf())
  assert.deepEqual(await part.status(ctxOf()), { ready: true, message: 'Getting ready: the speech model is loading (about 30 seconds).' })
  await starting
  assert.deepEqual(await part.status(ctxOf()), { ready: true, message: 'Ready.' })
  await part.actions.setLanguage(ctxOf(), { json: { language: 'en' }, bytes: null })
  const output = await part.actions.transcribe(ctxOf(), { json: null, bytes: new Uint8Array(1234) })
  assert.deepEqual(output, { text: 'heard 1234 bytes (en)', noSpeech: false, detectedLanguage: 'en' })
  assert.deepEqual(await calls(), ['prepare', 'serve'])
  assert.deepEqual(await fs.readdir(path.join(ctxOf().dir, 'temp')), [])
  await part.stop(ctxOf())
  // After a stop, a dictation starts the worker again.
  await part.actions.transcribe(ctxOf(), { json: null, bytes: new Uint8Array(10) })
  assert.deepEqual(await calls(), ['prepare', 'serve', 'serve'])
  await part.stop(ctxOf())
})

test('a failed start rejects with the worker reason and reports not ready (the microphone button hides)', async () => {
  await part.install(ctxOf())
  process.env.FAKE_WORKER_FAIL = '1'
  await assert.rejects(part.start(ctxOf()), /could not start the mlx backend: FileNotFoundError: ffmpeg/)
  assert.deepEqual(await part.status(ctxOf()), { ready: false, message: 'Voice Input worker could not start the mlx backend: FileNotFoundError: ffmpeg' })
  delete process.env.FAKE_WORKER_FAIL
  await part.start(ctxOf())
  assert.deepEqual(await part.status(ctxOf()), { ready: true, message: 'Ready.' })
  await part.stop(ctxOf())
})

test('settings: language is validated and kept in ctx.dir; getSettings gives the folder', async () => {
  await part.install(ctxOf())
  assert.deepEqual(await part.actions.getSettings(ctxOf(), { json: null, bytes: null }), { language: 'auto', runtimeVersion: '0.3.2', model: 'whisper-small-mlx', folder: ctxOf().dir })
  await assert.rejects(part.actions.setLanguage(ctxOf(), { json: { language: 'de' }, bytes: null }), /auto, en or zh/)
  assert.deepEqual(await part.actions.setLanguage(ctxOf(), { json: { language: 'zh' }, bytes: null }), { language: 'zh' })
  assert.equal((await part.actions.getSettings(ctxOf(), { json: null, bytes: null })).language, 'zh')
})

test('without its runtime it is not ready and says so; transcribe needs bytes', async () => {
  assert.deepEqual(await part.status(ctxOf()), { ready: false, message: 'The voice runtime or speech model is missing. Remove Voice Input and install it again.' })
  await assert.rejects(part.actions.transcribe(ctxOf(), { json: null, bytes: null }), /needs the WAV recording/)
})

test('refuses a runtime archive that does not match its checksum', async () => {
  const original = process.env.AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL
  const bad = http.createServer((request, response) => {
    if (request.url === '/manifest.json') {
      response.end(JSON.stringify({ runtimeVersion: '0.3.2', assets: [{ platform: os_, arch: cpu, fileName: 'r.tar.gz', url: `${base}/runtime.tar.gz`, sha256: '0'.repeat(64), entrypoint: 'bin/voice-input-worker', backendKind: 'mlx', model: { id: 'm', sourceRepo: 'x' } }] }))
    } else { response.statusCode = 404; response.end() }
  })
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve))
  process.env.AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL = `http://127.0.0.1:${bad.address().port}/manifest.json`
  try {
    await assert.rejects(part.install(ctxOf()), /does not match its checksum/)
  } finally {
    process.env.AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL = original
    bad.close()
  }
})
