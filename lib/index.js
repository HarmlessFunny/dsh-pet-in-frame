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
  web_search: 'learn', skill: 'learn', web_fetch: 'search',
  todo_write: 'plan', create_goal: 'plan', update_goal: 'plan', get_goal: 'plan',
  workflow: 'plan',
  ask_user_question: 'ask',
  subagent: 'subagent', subagent_fork: 'subagent', send_message: 'subagent',
  cordis_define: 'cordis', cordis_run: 'cordis', cordis_stop: 'cordis', cordis_undefine: 'cordis',
  cordis_inspect_list: 'cordis', cordis_inspect_query: 'cordis', cordis_inspect_self: 'cordis',
}
const TEXTS = {
  default: '待命中', idle: '待命中', sleep: '睡得好香…', think: '我在思考…',
  bash: '我在跑命令…', edit: '我在改文件…', read: '我在看代码…',
  search: '我在查资料…', learn: '我在学习…', plan: '我在列计划…', ask: '我在问你…',
  subagent: '我在派活…',
  cordis: '我在鼓捣插件…',
  permission: '需要你的许可…',
  error: '哎哟，出错了', done: '搞定啦',
}
const ACTION_KEYS = ['default', 'cordis', 'think', 'bash', 'edit', 'read', 'search', 'learn', 'plan', 'ask', 'subagent', 'permission', 'error', 'done', 'idle', 'sleep']
// Tools whose dispatch legitimately blocks far past the stale-tool fallback:
// a question can sit unanswered for minutes, a shell command or a subagent
// run can take minutes. tools/result always fires when they settle (answer,
// cancel, error, or completion), so the fallback must not preempt them.
const LONG_WAIT_TOOLS = new Set(['ask_user_question', 'bash', 'pwsh', 'subagent', 'subagent_fork', 'send_message', 'workflow'])
// How long the subagent pose flashes on subagent/start and subagent/end.
const SUBAGENT_FLASH_MS = 2000
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

  const state = { status: 'idle', action: 'default', tool: null, toolSince: 0, error: null, errorUntil: 0, idleSince: 0, subagentCount: 0, subagentUntil: 0, subagentActiveUntil: 0, permissionSince: 0 }
  // Session ids of live subagents. Their own tool calls / status / error
  // events must not drive the pet: only the main agent's activity counts.
  // Otherwise a subagent running read/bash inside its task would steal the
  // pose from the subagent flash (or from the main agent's own activity).
  const subagentIds = new Set()
  const setAction = (a) => { state.action = a || 'default' }
  // Track continuous idle: enterIdle() stamps the start of an uninterrupted
  // idle period (after 30s the pet falls asleep and stays asleep until a
  // click wakes it); any tool / running / error event leaves idle so the
  // next idle period starts fresh.
  let wasIdle = false
  const enterIdle = () => { state.idleSince = Date.now(); wasIdle = true }
  const leaveIdle = () => { wasIdle = false }
  // Baseline: with zero lifecycle events (fresh restart, nothing happening),
  // the agent counts as idle from the moment the plugin starts, so the pet
  // falls asleep 30s after startup even without any agent/status event.
  enterIdle()
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
      const a = payload && payload.agent
      const aid = a && a.id
      if (typeof aid === 'string' && aid && subagentIds.has(aid)) return
      const s = payload && payload.status
      if (s === 'running') { state.status = 'running'; leaveIdle(); if (!state.tool) setAction('think') }
      else if (s === 'idle') { state.status = 'idle'; if (!state.tool) { if (!wasIdle) enterIdle(); setAction('idle') } }
    } catch (e) { console.error('dsh-pet-in-frame status', e) }
  })
  ctx.on('tools/execute', (exec, next) => {
    try {
      const t = exec && exec.name
      if (typeof t === 'string' && t) {
        const caller = exec && exec.agent
        const cid = caller && caller.id
        if (typeof cid === 'string' && cid && subagentIds.has(cid)) return next()
        state.tool = t
        state.toolSince = Date.now()
        leaveIdle()
        setAction(TOOL_MAP[t] || 'default')
      }
    } catch (e) { console.error('dsh-pet-in-frame exec', e) }
    return next()
  })
  ctx.on('tools/result', (exec) => {
    try {
      const t = exec && exec.name
      const caller = exec && exec.agent
      const cid = caller && caller.id
      if (typeof cid === 'string' && cid && subagentIds.has(cid)) return
      state.permissionSince = 0
      if (t && t === state.tool) {
        state.tool = null
        state.toolSince = 0
        setAction(state.status === 'running' ? 'think' : 'idle')
        if (state.status !== 'running') enterIdle()
      }
    } catch (e) { console.error('dsh-pet-in-frame result', e) }
  })
  ctx.on('agent/error', (payload) => {
    try {
      const a = payload && payload.agent
      const aid = a && a.id
      if (typeof aid === 'string' && aid && subagentIds.has(aid)) return
      state.permissionSince = 0
      const err = payload && payload.error
      let msg = '未知错误'
      if (err && typeof err === 'object' && err.message) msg = String(err.message)
      else if (err !== undefined && err !== null) msg = String(err)
      state.error = msg.slice(0, 120)
      state.errorUntil = Date.now() + 6000
      leaveIdle()
      setAction('error')
    } catch (e) { console.error('dsh-pet-in-frame error', e) }
  })

  // ---- permission (approval) lifecycle ----------------------------------
  // Fires when a tool needs the user's approval (sandbox escalation /
  // sandbox_permissions retry). The pet shows the permission pose for as
  // long as the request is pending; tools/result (or agent/error) clears it
  // once the tool settles, so an approved command then runs under its own
  // tool pose. Subagents never request approval (policy 'never'), but filter
  // defensively anyway.
  ctx.on('approval/request', (req, next) => {
    try {
      const a = req && req.agent
      const aid = a && a.id
      if (typeof aid === 'string' && aid && subagentIds.has(aid)) return next()
      state.permissionSince = Date.now()
      leaveIdle()
      setAction('permission')
    } catch (e) { console.error('dsh-pet-in-frame approval', e) }
    return next()
  })

  // ---- subagent lifecycle ----------------------------------------------
  // Logic 1: flash the subagent pose on start/end (independent of the
  // running indicator). Logic 2: the client shows a fixed-position working
  // badge while subagentCount > 0.
  const flashSubagent = () => {
    state.subagentUntil = Date.now() + SUBAGENT_FLASH_MS
    leaveIdle()
    setAction('subagent')
  }
  const agentIdOf = (info) => {
    const id = info && info.id
    return typeof id === 'string' && id ? id : null
  }
  ctx.on('subagent/start', (info) => {
    try {
      state.subagentCount += 1
      flashSubagent()
      const id = agentIdOf(info)
      if (id) subagentIds.add(id)
    } catch (e) { console.error('dsh-pet-in-frame subagent start', e) }
  })
  ctx.on('subagent/end', (info) => {
    try {
      if (state.subagentCount > 0) state.subagentCount -= 1
      flashSubagent()
      // Keep the working badge visible for the same flash window after the
      // last subagent settles, so the badge disappears in sync with the pose.
      if (state.subagentCount === 0) state.subagentActiveUntil = Date.now() + SUBAGENT_FLASH_MS
      const id = agentIdOf(info)
      if (id) subagentIds.delete(id)
    } catch (e) { console.error('dsh-pet-in-frame subagent end', e) }
  })

  // ---- maintenance: stale tool/error fallback + asset hot-reload -------
  const watch = async () => {
    const now = Date.now()
    if (state.tool && !LONG_WAIT_TOOLS.has(state.tool) && now - state.toolSince > 15000) {
      state.tool = null
      setAction(state.status === 'running' ? 'think' : 'idle')
      if (state.status !== 'running') enterIdle()
    }
    if (state.action === 'error' && state.errorUntil && now > state.errorUntil) {
      setAction(state.status === 'running' ? 'think' : 'idle')
      if (state.status !== 'running') enterIdle()
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
      // Idle -> sleep cycle: after 30s of continuous idle the pet falls asleep
      // and stays asleep until the client POSTs /wake (a click), which resets
      // idleSince so the pet shows default again; 30s later it sleeps again.
      // Any tool / running / error activity also resets the countdown.
      let action = state.action
      // Subagent pose is a start/end flash. During the flash window the
      // subagent pose wins over every other event — a tools/result or
      // agent/status fired right after start/end would otherwise instantly
      // overwrite the flash before the client ever sees it. Once the window
      // passes, revert to think/idle unless a tool is still holding the pose.
      // Same for the permission pose: while an approval request is pending
      // (permissionSince > 0) it wins over everything except an error, and
      // tools/result clears it when the tool settles.
      const errorActive = action === 'error' && state.errorUntil > now
      const permissionActive = state.permissionSince > 0
      if (!errorActive && permissionActive) {
        action = 'permission'
      } else if (!errorActive && !permissionActive && now < state.subagentUntil) {
        action = 'subagent'
      } else if (action === 'subagent' && !state.tool && state.subagentUntil && now > state.subagentUntil) {
        action = state.status === 'running' ? 'think' : 'idle'
      }
      if (state.status === 'idle' && !state.tool && action !== 'error' && !permissionActive && !(now < state.subagentUntil)) {
        const elapsed = state.idleSince ? now - state.idleSince : 0
        action = elapsed >= 30000 ? 'sleep' : 'idle'
      }
      json(res, {
        status: state.status,
        action,
        tool: state.tool,
        error: action === 'error' && state.errorUntil > now ? state.error : null,
        idleMs: state.idleSince ? now - state.idleSince : 0,
        subagentActive: state.subagentCount > 0 || now < state.subagentActiveUntil,
        subagentCount: state.subagentCount,
        rev,
      })
    },
  }), 'dsh-pet-in-frame: state route')

  // POST from the client when the user clicks the pet: wake it up and restart
  // the idle countdown (pet leaves the sleep pose, shows default, sleeps again
  // 30s later if nothing else happens).
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-pet-in-frame/wake',
    handler: async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
      enterIdle()
      json(res, { ok: true, idleMs: 0 })
    },
  }), 'dsh-pet-in-frame: wake route')

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
