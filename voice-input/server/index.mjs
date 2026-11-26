// Voice Input's server part (AutoByteus extension contract, version 1, §4).
//
// It installs the Voice Input runtime and its speech model into ctx.dir, runs the runtime's worker (one long-lived
// process: `serve --backend --model-path`, one JSON line per request and reply) and transcribes WAV recordings that
// AutoByteus's microphone buttons send. One self-contained module: Node built-ins only.
//
// ctx.dir holds:
//   runtime/          the unpacked runtime (its bin/ launcher creates its own Python environment on first prepare)
//   models/<id>/      the speech model the runtime prepared
//   installation.json what was installed: { runtimeVersion, backendKind, entrypoint, modelId }
//   settings.json     { language: "auto" | "en" | "zh" }
//   temp/             one WAV per transcription while it runs
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

/** The pinned runtime release: 0.3.2 writes `ready` only after its model is loaded and one transcription is done. */
const RUNTIME_VERSION = '0.3.2'
const RUNTIME_MANIFEST_URL =
  `https://github.com/AutoByteus/autobyteus-voice-runtime/releases/download/v${RUNTIME_VERSION}/voice-input-runtime-manifest.json`
/** The worker is stopped after this long without a transcription, to give its ~850 MB back (REQ-012). */
const IDLE_STOP_MS = 30 * 60_000
const LANGUAGES = ['auto', 'en', 'zh']

const READY_MESSAGE = 'Ready.'
const WARMING_MESSAGE = 'Getting ready: the speech model is loading (about 30 seconds).'
const MISSING_MESSAGE = 'The voice runtime or speech model is missing. Remove Voice Input and install it again.'
const PREPARING_MESSAGE = 'Preparing the speech model (downloads about 2 GB once; this can take a few minutes)'
const KEEPING_MESSAGE = 'Keeping your voice runtime, speech model and language'

const paths = (ctx) => ({
  runtime: path.join(ctx.dir, 'runtime'),
  models: path.join(ctx.dir, 'models'),
  downloads: path.join(ctx.dir, 'downloads'),
  temp: path.join(ctx.dir, 'temp'),
  installation: path.join(ctx.dir, 'installation.json'),
  settings: path.join(ctx.dir, 'settings.json'),
})

const exists = (file) => fs.access(file).then(() => true, () => false)
const isWindowsCommand = (file) => process.platform === 'win32' && file.toLowerCase().endsWith('.cmd')
const lastLine = (text) => text.trim().split('\n').filter(Boolean).at(-1) ?? ''

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return null }
}

/** What install() left, when its runtime launcher and model are still there; null otherwise. */
async function readInstallation(ctx) {
  const installation = await readJson(paths(ctx).installation)
  if (!installation || typeof installation.entrypoint !== 'string' || typeof installation.modelId !== 'string') return null
  const entrypoint = path.join(paths(ctx).runtime, installation.entrypoint)
  const modelPath = path.join(paths(ctx).models, installation.modelId)
  if (!(await exists(entrypoint)) || !(await exists(modelPath))) return null
  return { ...installation, entrypointPath: entrypoint, modelPath }
}

async function readLanguage(ctx) {
  const settings = await readJson(paths(ctx).settings)
  return LANGUAGES.includes(settings?.language) ? settings.language : 'auto'
}

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** Unpacks a .tar.gz (files and folders only; GNU and PAX long names) into `target`; any other entry is refused. */
async function unpackTarGz(bytes, target) {
  const tar = gunzipSync(bytes)
  const field = (header, start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '')
  let longName = null
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(field(header, 124, 12).trim() || '0', 8)
    const type = String.fromCharCode(header[156] || 48)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue }
    if (type === 'x') { longName = body.toString('utf8').match(/\d+ path=([^\n]*)\n/)?.[1] ?? longName; continue }
    if (type === 'g') continue
    const prefix = field(header, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    longName = null
    const relative = path.normalize(name)
    if (relative === '.' || relative === `.${path.sep}`) continue
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new Error(`The runtime archive holds an unsafe path: ${name}`)
    const destination = path.join(target, relative)
    if (type === '5') { await fs.mkdir(destination, { recursive: true }); continue }
    if (type !== '0' && type !== '7') throw new Error(`The runtime archive holds an entry of type ${type}: ${name}`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, body)
    if (process.platform !== 'win32') await fs.chmod(destination, parseInt(field(header, 100, 8).trim() || '644', 8) & 0o777)
  }
}

function run(entrypoint, args, ctx) {
  return new Promise((resolve, reject) => {
    const child = spawn(entrypoint, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: isWindowsCommand(entrypoint) })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) return resolve()
      ctx.log(`${args[0]} failed: ${stderr.trim().slice(-2000)}`)
      reject(new Error(lastLine(stderr) || `The voice runtime's ${args[0]} step failed (exit ${code}).`))
    })
  })
}

// ------------------------------------------------------------------------------------------------- the worker

let worker = null
let starting = false
let startFailure = null
let idleTimer = null
let requests = 0

function resetIdleTimer(ctx) {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    ctx.log('worker stopped after 30 minutes without dictation')
    void stopWorker()
  }, IDLE_STOP_MS)
  idleTimer.unref?.()
}

/** Starts the worker (or returns the one starting or running) and resolves when it is ready to transcribe. */
function ensureWorker(ctx, installation) {
  if (worker) return worker.ready
  const child = spawn(installation.entrypointPath, ['serve', '--backend', installation.backendKind, '--model-path', installation.modelPath], {
    stdio: ['pipe', 'pipe', 'pipe'], shell: isWindowsCommand(installation.entrypointPath),
  })
  const state = { child, pending: new Map(), buffer: '', stderr: '' }
  worker = state
  starting = true
  state.ready = new Promise((resolve, reject) => { state.resolveReady = resolve; state.rejectReady = reject })
  state.ready.catch(() => {})
  child.stdout.on('data', (chunk) => {
    state.buffer += chunk.toString()
    const lines = state.buffer.split('\n')
    state.buffer = lines.pop() ?? ''
    for (const line of lines) {
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'ready') {
        starting = false
        startFailure = null
        ctx.log(`worker ready (${installation.backendKind})`)
        state.resolveReady()
        continue
      }
      const reply = state.pending.get(message.requestId)
      if (reply) { state.pending.delete(message.requestId); reply.resolve(message) }
    }
  })
  child.stderr.on('data', (chunk) => { state.stderr = (state.stderr + chunk.toString()).slice(-8000) })
  const ended = (error) => {
    if (worker === state) { worker = null; starting = false }
    const failure = error ?? new Error(lastLine(state.stderr) || 'The voice worker stopped.')
    state.rejectReady(failure)
    for (const reply of state.pending.values()) reply.reject(failure)
    state.pending.clear()
    state.closed?.()
  }
  child.on('error', ended)
  child.on('close', (code) => {
    if (starting && worker === state) {
      startFailure = lastLine(state.stderr) || `The voice worker exited (${code}) before it was ready.`
      ctx.log(`worker could not start: ${state.stderr.trim().slice(-2000)}`)
    }
    ended(null)
  })
  ctx.log(`worker starting (${installation.backendKind}, runtime ${installation.runtimeVersion})`)
  return state.ready
}

async function stopWorker() {
  clearTimeout(idleTimer)
  const state = worker
  if (!state) return
  worker = null
  starting = false
  const closed = new Promise((resolve) => { state.closed = resolve })
  state.child.stdin.end()
  state.child.kill()
  await closed
}

// ------------------------------------------------------------------------------------------------- the contract

export default {
  async install(ctx) {
    const p = paths(ctx)
    const installed = await readInstallation(ctx)
    if (installed?.runtimeVersion === RUNTIME_VERSION) {
      ctx.progress({ message: KEEPING_MESSAGE, percent: null })
      ctx.log(`install: runtime ${RUNTIME_VERSION} and model ${installed.modelId} already here; kept`)
      return
    }
    ctx.progress({ message: PREPARING_MESSAGE, percent: null })
    const manifestUrl = process.env.AUTOBYTEUS_VOICE_INPUT_MANIFEST_URL?.trim() || RUNTIME_MANIFEST_URL
    const manifest = JSON.parse((await download(manifestUrl)).toString('utf8'))
    const [os, cpu] = ctx.platform.split('-')
    const asset = manifest.assets?.find((candidate) => candidate.platform === os && candidate.arch === cpu)
    if (!asset) throw new Error(`The voice runtime ${manifest.runtimeVersion} has no build for ${ctx.platform}.`)
    ctx.log(`install: runtime ${manifest.runtimeVersion} for ${ctx.platform} from ${asset.url}`)
    const archive = await download(asset.url)
    if (createHash('sha256').update(archive).digest('hex') !== asset.sha256) {
      throw new Error(`The voice runtime download does not match its checksum (${asset.fileName}).`)
    }
    await stopWorker()
    await fs.rm(p.runtime, { recursive: true, force: true })
    await fs.mkdir(p.runtime, { recursive: true })
    await unpackTarGz(archive, p.runtime)
    const entrypoint = path.join(p.runtime, asset.entrypoint)
    if (process.platform !== 'win32') await fs.chmod(entrypoint, 0o755)
    await fs.rm(p.downloads, { recursive: true, force: true })
    const modelPath = path.join(p.models, asset.model.id)
    ctx.log(`install: preparing the speech model ${asset.model.sourceRepo}`)
    await run(entrypoint, ['prepare', '--backend', asset.backendKind, '--model-path', modelPath, '--model-source-repo', asset.model.sourceRepo,
      ...(asset.model.sourceRevision ? ['--model-source-revision', asset.model.sourceRevision] : [])], ctx)
    if (!(await exists(modelPath))) throw new Error('The speech model was not prepared.')
    await fs.writeFile(p.installation, `${JSON.stringify({
      runtimeVersion: manifest.runtimeVersion, backendKind: asset.backendKind, entrypoint: asset.entrypoint, modelId: asset.model.id,
    }, null, 2)}\n`)
    startFailure = null
    ctx.log(`install: runtime ${manifest.runtimeVersion} and model ${asset.model.id} ready`)
  },

  /** Run at node start and when turned on: the worker loads the speech model now, so the first dictation is fast. */
  async start(ctx) {
    const installation = await readInstallation(ctx)
    if (!installation) throw new Error(MISSING_MESSAGE)
    startFailure = null
    try {
      await ensureWorker(ctx, installation)
    } catch (error) {
      throw new Error(startFailure ?? error.message)
    }
    resetIdleTimer(ctx)
  },

  async status(ctx) {
    if (!(await readInstallation(ctx))) return { ready: false, message: MISSING_MESSAGE }
    if (startFailure) return { ready: false, message: startFailure }
    return { ready: true, message: starting ? WARMING_MESSAGE : READY_MESSAGE }
  },

  async stop(ctx) {
    if (worker) ctx.log('worker stopped')
    await stopWorker()
  },

  actions: {
    async transcribe(ctx, input) {
      if (!input.bytes?.length) throw new Error('transcribe needs the WAV recording.')
      const installation = await readInstallation(ctx)
      if (!installation) throw new Error(MISSING_MESSAGE)
      const p = paths(ctx)
      await fs.mkdir(p.temp, { recursive: true })
      const audioPath = path.join(p.temp, `recording-${process.pid}-${++requests}.wav`)
      await fs.writeFile(audioPath, input.bytes)
      try {
        await ensureWorker(ctx, installation)
        const state = worker
        if (!state) throw new Error('The voice worker stopped.')
        const requestId = `r${requests}`
        const languageMode = await readLanguage(ctx)
        const reply = await new Promise((resolve, reject) => {
          state.pending.set(requestId, { resolve, reject })
          state.child.stdin.write(`${JSON.stringify({ requestId, type: 'transcribe-file', audioPath, languageMode })}\n`)
        })
        if (!reply.ok) throw new Error(reply.error || 'The transcription failed.')
        return { text: reply.text ?? '', noSpeech: Boolean(reply.noSpeech), detectedLanguage: reply.detectedLanguage ?? null }
      } finally {
        resetIdleTimer(ctx)
        await fs.rm(audioPath, { force: true })
      }
    },

    async getSettings(ctx) {
      const installation = await readInstallation(ctx)
      return {
        language: await readLanguage(ctx),
        runtimeVersion: installation?.runtimeVersion ?? null,
        model: installation?.modelId ?? null,
        folder: ctx.dir,
      }
    },

    async setLanguage(ctx, input) {
      const language = input.json?.language
      if (!LANGUAGES.includes(language)) throw new Error('The language must be auto, en or zh.')
      await fs.writeFile(paths(ctx).settings, `${JSON.stringify({ language })}\n`)
      ctx.log(`settings: language ${language}`)
      return { language }
    },
  },
}
