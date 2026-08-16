/**
 * dsh-pet-in-frame — Host half.
 *
 * Listens to the agent lifecycle (status / tool calls / errors), watches the
 * assets directory for image and manifest changes, and serves four HTTP routes:
 *
 *   GET /dsh-pet-in-frame/state          → { status, action, tool, error, rev }
 *   GET /dsh-pet-in-frame/texts          → { texts }
 *   GET /dsh-pet-in-frame/frames/<action> → { frames: [url...], delay }
 *   GET /dsh-pet-in-frame/assets/<file>  → image bytes
 *
 * The client pet polls `state`, refetches frames when `rev` changes, and
 * renders static or frame-animated poses accordingly.
 *
 * Assets directory resolution order:
 *   1. `config.assetsDir` from the composition row
 *   2. `process.env.DSH_PET_ASSETS`
 *   3. this package's own `assets/` directory
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const PKG_DIR = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_ASSETS = join(PKG_DIR, 'assets')

export const name = 'dsh-pet-in-frame'
export const inject = ['timer', 'webServer']

const TOOL_MAP = {
  bash: 'bash', pwsh: 'bash',
  edit: 'edit', write: 'edit',
  read: 'read', glob: 'read', grep: 'read',
  web_search: 'search', web_fetch: 'search',
  todo_write: 'plan', create_goal: 'plan', update_goal: 'plan', get_goal: 'plan',
  workflow: 'plan',
}
const TEXTS = {
  default: '待命中', idle: '待命中', think: '我在思考…',
  bash: '我在跑命令…', edit: '我在改文件…', read: '我在看代码…',
  search: '我在查资料…', plan: '我在列计划…', error: '哎哟，出错了', done: '搞定啦',
}
const ACTION_KEYS = ['default', 'think', 'bash', 'edit', 'read', 'search', 'plan', 'error', 'done', 'idle']
const EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
const FALLBACKS = { read: ['search'] }
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
}
const SAFE_NAME = /^[\w.-]+$/

export function apply(ctx, config = {}) {
  const assetsDir = (config && typeof config.assetsDir === 'string' && config.assetsDir)
    || process.env.DSH_PET_ASSETS
    || DEFAULT_ASSETS

  const state = { status: 'idle', action: 'default', tool: null, toolSince: 0, error: null, errorUntil: 0 }
  const setAction = (a) => { state.action = a || 'default' }
  const cache = new Map() // filename -> fingerprint (mtimeMs:size)
  let imageNames = []
  let manifest = null
  let manifestFp = 'missing'
  let rev = 0
  const bumpRev = () => { rev += 1 }

  const fpOf = async (p) => {
    try {
      const i = await stat(p)
      return String(i.mtimeMs) + ':' + String(i.size)
    } catch {
      return 'gone'
    }
  }
  const listImages = async () => {
    try {
      const names = await readdir(assetsDir)
      return names.filter((n) => /\.(png|jpe?g|gif|webp|svg)$/i.test(n))
    } catch {
      return []
    }
  }
  const loadManifest = async () => {
    try {
      const text = await readFile(join(assetsDir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(text)
      manifest = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      manifest = null
    }
    manifestFp = await fpOf(join(assetsDir, 'manifest.json'))
  }

  // ---- agent lifecycle -------------------------------------------------
  ctx.on('agent/status', (payload) => {
    try {
      const s = payload && payload.status
      if (s === 'running') { state.status = 'running'; if (!state.tool) setAction('think') }
      else if (s === 'idle') { state.status = 'idle'; if (!state.tool) setAction('idle') }
    } catch (e) { console.error('dsh-pet-in-frame status', e) }
  })
  ctx.on('tools/execute', (exec, next) => {
    try {
      const t = exec && exec.name
      if (typeof t === 'string' && t) {
        state.tool = t
        state.toolSince = Date.now()
        setAction(TOOL_MAP[t] || 'default')
      }
    } catch (e) { console.error('dsh-pet-in-frame exec', e) }
    return next()
  })
  ctx.on('tools/result', (exec) => {
    try {
      const t = exec && exec.name
      if (t && t === state.tool) {
        state.tool = null
        state.toolSince = 0
        setAction(state.status === 'running' ? 'think' : 'idle')
      }
    } catch (e) { console.error('dsh-pet-in-frame result', e) }
  })
  ctx.on('agent/error', (payload) => {
    try {
      const err = payload && payload.error
      let msg = '未知错误'
      if (err && typeof err === 'object' && err.message) msg = String(err.message)
      else if (err !== undefined && err !== null) msg = String(err)
      state.error = msg.slice(0, 120)
      state.errorUntil = Date.now() + 6000
      setAction('error')
    } catch (e) { console.error('dsh-pet-in-frame error', e) }
  })

  // ---- maintenance: stale tool/error fallback + asset hot-reload -------
  const watch = async () => {
    const now = Date.now()
    if (state.tool && now - state.toolSince > 15000) {
      state.tool = null
      setAction(state.status === 'running' ? 'think' : 'idle')
    }
    if (state.action === 'error' && state.errorUntil && now > state.errorUntil) {
      setAction(state.status === 'running' ? 'think' : 'idle')
    }
    try {
      const names = await listImages()
      const keyNow = names.slice().sort().join('|')
      const keyOld = imageNames.slice().sort().join('|')
      if (keyNow !== keyOld) { imageNames = names; bumpRev() }
      const mFp = await fpOf(join(assetsDir, 'manifest.json'))
      if (mFp !== manifestFp) { await loadManifest(); bumpRev() }
      for (const filename of [...cache.keys()]) {
        const fp = await fpOf(join(assetsDir, filename))
        if (fp !== cache.get(filename)) {
          cache.delete(filename)
          bumpRev()
        }
      }
    } catch (e) { /* keep current state */ }
  }
  ctx.effect(() => ctx.interval(watch, 3000))

  // ---- frame resolution ------------------------------------------------
  const resolveFrames = (action) => {
    const m = manifest && manifest[action]
    let frames = null
    let delay = 0
    if (typeof m === 'string') frames = [m]
    else if (m && typeof m === 'object' && Array.isArray(m.imgs)) {
      frames = m.imgs.filter((n) => typeof n === 'string')
      delay = typeof m.delay === 'number' && m.delay > 0 ? m.delay : 500
    }
    if (frames) {
      const existing = frames.filter((n) => imageNames.includes(n))
      if (existing.length) return { frames: existing, delay }
    }
    const want = ACTION_KEYS.includes(action) ? action : 'default'
    for (const ext of EXTS) if (imageNames.includes(want + '.' + ext)) return { frames: [want + '.' + ext], delay: 0 }
    const chain = (FALLBACKS[want] || []).concat(want !== 'default' ? ['default'] : [])
    for (const alt of chain) for (const ext of EXTS) if (imageNames.includes(alt + '.' + ext)) return { frames: [alt + '.' + ext], delay: 0 }
    return null
  }

  // ---- routes -----------------------------------------------------------
  const json = (res, body) => {
    const text = JSON.stringify(body)
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(text)),
    })
    res.end(text)
  }
  const allowGet = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return true
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return false
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-in-frame/state',
    handler: async (req, res) => {
      if (!allowGet(req, res)) return
      const now = Date.now()
      json(res, {
        status: state.status,
        action: state.action,
        tool: state.tool,
        error: state.action === 'error' && state.errorUntil > now ? state.error : null,
        rev,
      })
    },
  }), 'dsh-pet-in-frame: state route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-in-frame/texts',
    handler: async (req, res) => {
      if (!allowGet(req, res)) return
      json(res, { texts: TEXTS })
    },
  }), 'dsh-pet-in-frame: texts route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-pet-in-frame/frames',
    handler: async (req, res) => {
      if (!allowGet(req, res)) return
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const action = pathname.slice('/dsh-pet-in-frame/frames/'.length) || 'default'
      const resolved = resolveFrames(action)
      if (!resolved) { json(res, { frames: null, delay: 0 }); return }
      json(res, {
        frames: resolved.frames.map((f) => `/dsh-pet-in-frame/assets/${encodeURIComponent(f)}?rev=${rev}`),
        delay: resolved.delay,
      })
    },
  }), 'dsh-pet-in-frame: frames route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-pet-in-frame/assets',
    handler: async (req, res) => {
      if (!allowGet(req, res)) return
      const pathname = new URL(req.url ?? '/', 'http://x').pathname
      const name = decodeURIComponent(pathname.slice('/dsh-pet-in-frame/assets/'.length))
      if (!name || !SAFE_NAME.test(name)) { res.writeHead(400); res.end(); return }
      try {
        const body = await readFile(join(assetsDir, name))
        const m = /\.([a-z0-9]+)$/i.exec(name)
        const type = MIME[(m ? m[1] : '').toLowerCase()] || 'application/octet-stream'
        cache.set(name, await fpOf(join(assetsDir, name)))
        res.writeHead(200, {
          'cache-control': 'public, max-age=3600',
          'content-length': String(body.byteLength),
          'content-type': type,
        })
        res.end(req.method === 'HEAD' ? undefined : body)
      } catch {
        res.writeHead(404)
        res.end()
      }
    },
  }), 'dsh-pet-in-frame: assets route')
}
