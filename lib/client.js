/**
 * dsh-pet-in-frame — Client half.
 *
 * Loaded through the page module loader (`window.__ModuleLoader__`). Renders a
 * draggable pet in `shell.overlay`, polls `/dsh-pet-in-frame/state`, swaps
 * static frames or cycles frame animations from `/dsh-pet-in-frame/frames`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-pet-in-frame',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const PLUGIN_ID = 'dsh-pet-in-frame'
    const STYLE_ID = `${PLUGIN_ID}/overlay`
    const UI_KEY = 'dsh-pet-in-frame:ui'
    const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

    function loadSaved() {
      try {
        const raw = localStorage.getItem(UI_KEY)
        if (!raw) return null
        const p = JSON.parse(raw)
        if (!p || typeof p !== 'object') return null
        const size = typeof p.size === 'number' ? clampNum(p.size, 100, 320) : 180
        const pos = p.pos && typeof p.pos.x === 'number' && typeof p.pos.y === 'number'
          ? {
              x: clampNum(p.pos.x, 0, Math.max(window.innerWidth - size, 0)),
              y: clampNum(p.pos.y, 0, Math.max(window.innerHeight - size, 0)),
            }
          : null
        return { size, pos }
      } catch (e) {
        return null
      }
    }

    if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = [
        '.dshpet-wrap{position:fixed;right:24px;bottom:24px;z-index:10;cursor:grab;user-select:none;touch-action:none;pointer-events:auto;line-height:0;width:180px;height:180px}',
        '.dshpet-wrap:active{cursor:grabbing}',
        '.dshpet-img{width:180px;height:180px;object-fit:contain;display:block;pointer-events:none}',
        '.dshpet-placeholder{font-size:80px;line-height:180px;text-align:center;pointer-events:none}',
        '.dshpet-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:10px;background:rgba(15,18,28,.88);color:#f4f6fb;padding:6px 12px;border-radius:12px;font-size:13px;white-space:nowrap;pointer-events:none;animation:dshpet-pop .18s ease-out;line-height:1.4}',
        '.dshpet-bubble-below{top:100%;bottom:auto;margin-top:10px;margin-bottom:0}',
        '.dshpet-close{position:absolute;top:-8px;right:-8px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:12px;line-height:20px;text-align:center;cursor:pointer;opacity:0;transition:opacity .15s;pointer-events:auto}',
        '.dshpet-wrap:hover .dshpet-close{opacity:1}',
        '.dshpet-size{position:absolute;left:50%;bottom:6px;transform:translateX(-50%);display:flex;gap:4px;align-items:center;background:rgba(15,18,28,.85);color:#fff;font-size:12px;line-height:1;padding:3px 8px;border-radius:10px;opacity:0;transition:opacity .15s;pointer-events:auto;white-space:nowrap}',
        '.dshpet-wrap:hover .dshpet-size{opacity:1}',
        '.dshpet-size-btn{width:18px;height:18px;line-height:18px;text-align:center;border-radius:50%;background:rgba(255,255,255,.2);cursor:pointer;pointer-events:auto}',
        '.dshpet-size-btn:active{background:rgba(255,255,255,.4)}',
        '.dshpet-size-label{min-width:36px;text-align:center}',
        '.dshpet-tab{position:fixed;right:24px;bottom:24px;z-index:10;font-size:22px;cursor:pointer;pointer-events:auto;line-height:1;padding:6px;border-radius:12px;background:rgba(15,18,28,.35)}',
        '.dshpet-working{position:absolute;left:4.63%;top:31.66%;width:26.63%;height:36.92%;z-index:2;pointer-events:none;line-height:0}',
        '.dshpet-working-img{display:block;width:100%;height:100%;pointer-events:none}',
        '@keyframes dshpet-pop{from{opacity:0;transform:translateX(-50%) scale(.85)}to{opacity:1;transform:translateX(-50%) scale(1)}}',
      ].join('')
      document.head.appendChild(tag)
    }

    const isCtlEl = (el) => el && typeof el.className === 'string' && el.className.indexOf('dshpet-ctl') >= 0

    function Pet() {
      const [hidden, setHidden] = React.useState(false)
      const [size, setSize] = React.useState(() => { const s = loadSaved(); return s ? s.size : 180 })
      const [frames, setFrames] = React.useState(null) // { urls: string[], delay: number }
      const [idx, setIdx] = React.useState(0)
      const [texts, setTexts] = React.useState({})
      const [action, setAction] = React.useState('default')
      const [pos, setPos] = React.useState(() => { const s = loadSaved(); return s ? s.pos : null })
      const [bubble, setBubble] = React.useState(null)
      const [pinned, setPinned] = React.useState(false)
      const dragRef = React.useRef(null)
      const bubbleTimer = React.useRef(null)
      const revRef = React.useRef(null)
      const [subagentActive, setSubagentActive] = React.useState(false)
      const [workFrames, setWorkFrames] = React.useState(null)
      const [workIdx, setWorkIdx] = React.useState(0)
      // a click wakes the pet; ignore sleep reported by polls for 2s after a
      // click so a stale poll response cannot flip it back to sleep
      const wokeAtRef = React.useRef(0)

      const clearBubbleTimer = () => { if (bubbleTimer.current) { clearTimeout(bubbleTimer.current); bubbleTimer.current = null } }
      // transient flash on action change; never stomps a user-pinned bubble
      const flashBubble = (text) => {
        if (pinned) return
        clearBubbleTimer()
        setBubble(text || null)
        if (text) bubbleTimer.current = setTimeout(() => { setBubble(null); bubbleTimer.current = null }, 3000)
      }
      // click toggles a persistent bubble until the next click
      const toggleBubble = (act) => {
        clearBubbleTimer()
        if (bubble !== null) {
          setBubble(null)
          setPinned(false)
        } else {
          setBubble(texts[act || action] || texts.idle || '待命中')
          setPinned(true)
        }
      }
      const changeSize = (delta) => setSize((s) => Math.min(320, Math.max(100, s + delta)))

      const loadFrames = (act) => {
        fetch(`/dsh-pet-in-frame/frames/${encodeURIComponent(act)}`)
          .then((r) => r.json())
          .then((data) => {
            if (data && data.frames) setFrames({ urls: data.frames, delay: data.delay || 0 })
          })
          .catch(() => {})
      }

      React.useEffect(() => {
        let alive = true
        fetch('/dsh-pet-in-frame/texts')
          .then((r) => r.json())
          .then((d) => { if (alive && d && d.texts) setTexts(d.texts) })
          .catch(() => {})
        return () => { alive = false }
      }, [])

      React.useEffect(() => { loadFrames('default') }, [])

      React.useEffect(() => {
        let alive = true
        const timer = setInterval(async () => {
          try {
            const r = await fetch('/dsh-pet-in-frame/state')
            if (!r.ok) return
            const s = await r.json()
            if (!alive) return
            // a poll arriving right after a click may still carry 'sleep';
            // keep the pet awake for 2s after the click instead
            const eff = (s.action === 'sleep' && Date.now() - wokeAtRef.current < 2000)
              ? 'idle'
              : (s.action || 'default')
            setAction(eff)
            setSubagentActive(!!s.subagentActive)
            if (s.rev !== revRef.current) {
              revRef.current = s.rev
              loadFrames(eff)
            }
          } catch (e) { /* server restarting */ }
        }, 1000)
        return () => { alive = false; clearInterval(timer) }
      }, [])

      React.useEffect(() => {
        loadFrames(action)
        if (action !== 'default' && action !== 'idle' && action !== 'sleep') {
          flashBubble(texts[action] || (action === 'error' ? '出错了' : ''))
        }
      }, [action])

      React.useEffect(() => {
        setIdx(0)
        if (!frames || !frames.urls || frames.urls.length < 2 || !frames.delay) return
        const timer = setInterval(() => setIdx((i) => (i + 1) % frames.urls.length), frames.delay)
        return () => clearInterval(timer)
      }, [frames])

      // subagent working badge, pinned inside the pet image. Runs on the same
      // polled subagentActive flag as the pose flash but is a persistent badge
      // (visible while subagentCount > 0) instead of a 4s transient pose.
      React.useEffect(() => {
        if (subagentActive && workFrames === null) {
          fetch('/dsh-pet-in-frame/frames/subagent_working')
            .then((r) => r.json())
            .then((d) => { if (d && d.frames) setWorkFrames({ urls: d.frames, delay: d.delay || 500 }) })
            .catch(() => {})
        }
      }, [subagentActive, workFrames])

      React.useEffect(() => {
        setWorkIdx(0)
        if (!subagentActive || !workFrames || !workFrames.urls || workFrames.urls.length < 2 || !workFrames.delay) return
        const timer = setInterval(() => setWorkIdx((i) => (i + 1) % workFrames.urls.length), workFrames.delay)
        return () => clearInterval(timer)
      }, [subagentActive, workFrames])

      // persist size + position (debounced)
      React.useEffect(() => {
        const timer = setTimeout(() => {
          try { localStorage.setItem(UI_KEY, JSON.stringify({ size, pos })) } catch (e) { /* storage unavailable */ }
        }, 400)
        return () => clearTimeout(timer)
      }, [size, pos])

      const onDown = (e) => {
        if (isCtlEl(e.target)) return
        const rect = e.currentTarget.getBoundingClientRect()
        dragRef.current = { sx: e.clientX, sy: e.clientY, px: rect.left, py: rect.top, w: rect.width, h: rect.height, moved: false }
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId)
      }
      const onMove = (e) => {
        const d = dragRef.current
        if (!d) return
        const dx = e.clientX - d.sx
        const dy = e.clientY - d.sy
        if (Math.abs(dx) + Math.abs(dy) > 5) d.moved = true
        if (!d.moved) return
        const w = d.w || 180
        const h = d.h || 180
        let x = d.px + dx
        let y = d.py + dy
        x = Math.min(Math.max(x, 0), Math.max(window.innerWidth - w, 0))
        y = Math.min(Math.max(y, 0), Math.max(window.innerHeight - h, 0))
        setPos({ x, y })
      }
      const onUp = (e) => {
        const d = dragRef.current
        dragRef.current = null
        if (d && !d.moved) {
          const wasSleeping = action === 'sleep'
          // clicking wakes a sleeping pet right away (host resets the idle
          // countdown via POST /wake); any click also counts as activity
          if (wasSleeping) {
            setAction('idle')
            loadFrames('idle')
          }
          wokeAtRef.current = Date.now()
          fetch('/dsh-pet-in-frame/wake', { method: 'POST' }).catch(() => {})
          toggleBubble(wasSleeping ? 'idle' : null)
        }
      }

      if (hidden) {
        return React.createElement('div', { className: 'dshpet-tab', onClick: () => setHidden(false), title: '显示宠物' }, '🐾')
      }
      const imgSrc = frames ? frames.urls[frames.urls.length > 1 ? idx : 0] : null
      const bubbleCls = pos && pos.y < 60 ? 'dshpet-bubble dshpet-bubble-below' : 'dshpet-bubble'
      const wrapStyle = Object.assign({ width: size, height: size }, pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : null)
      return React.createElement(
        'div',
        {
          className: 'dshpet-wrap',
          style: wrapStyle,
          onPointerDown: onDown,
          onPointerMove: onMove,
          onPointerUp: onUp,
          onPointerCancel: onUp,
        },
        bubble ? React.createElement('div', { className: bubbleCls }, bubble) : null,
        imgSrc
          ? React.createElement('img', { className: 'dshpet-img', src: imgSrc, alt: action, draggable: false, style: { width: size, height: size } })
          : React.createElement('div', { className: 'dshpet-img dshpet-placeholder', style: { width: size, height: size, fontSize: Math.round(size * 0.45), lineHeight: size + 'px' } }, '🐾'),
        subagentActive && workFrames && workFrames.urls.length
          ? React.createElement('div', { className: 'dshpet-working', title: '子代理运行中' },
              React.createElement('img', { className: 'dshpet-working-img', src: workFrames.urls[workFrames.urls.length > 1 ? workIdx : 0], alt: 'subagent working', draggable: false }))
          : null,
        React.createElement('div', { className: 'dshpet-size' },
          React.createElement('div', { className: 'dshpet-size-btn dshpet-ctl', onClick: (e) => { e.stopPropagation(); changeSize(-20) }, title: '缩小' }, '−'),
          React.createElement('span', { className: 'dshpet-size-label dshpet-ctl' }, String(size)),
          React.createElement('div', { className: 'dshpet-size-btn dshpet-ctl', onClick: (e) => { e.stopPropagation(); changeSize(20) }, title: '放大' }, '+'),
        ),
        React.createElement('div', { className: 'dshpet-close dshpet-ctl', title: '隐藏宠物', onClick: (e) => { e.stopPropagation(); setHidden(true) } }, '×'),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('shell.overlay', () => slots.register({
        name: 'shell.overlay',
        id: 'dsh-pet-in-frame',
        order: 100,
      }, Pet))
    }

    exports.apply = apply
    return module.exports
  },
})
