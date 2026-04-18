/* eslint-disable @next/next/no-img-element */
'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const LOGOS = [
  { src: '/images/fake-bobby-logo.png', preset: ['holo', 'bevel'] },
  { src: '/images/fake-david-logo.png', preset: ['sweep', 'reflection'] },
  { src: '/images/fake-tommy-logo.png', preset: ['sweep'] },
  { src: '/images/logo-hacka.png',      preset: ['sparkles', 'bevel'] },
  { src: '/images/logo-hack.png',       preset: ['holo', 'sweep'] },
]

export default function SplashOverlay() {
  const [dismissed, setDismissed] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [clockStr, setClockStr] = useState('')
  const [logoEntry] = useState(() => LOGOS[Math.floor(Math.random() * LOGOS.length)])

  const exitingRef = useRef(false)
  const dismissRef = useRef<() => void>(() => {})
  const logoRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)

  const dismiss = useCallback(() => {
    if (exitingRef.current) return
    exitingRef.current = true
    setExiting(true)
    setTimeout(() => setDismissed(true), 900)
  }, [])

  useEffect(() => { dismissRef.current = dismiss }, [dismiss])

  // Live clock — matches original format
  useEffect(() => {
    const tick = () => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      setClockStr(`${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} · ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Enter key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter') dismissRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 3D stack + animation loop — ported from exported design
  useEffect(() => {
    const logo = logoRef.current as HTMLDivElement
    const stage = stageRef.current as HTMLDivElement
    if (!logo || !stage) return

    const cfg = {
      idleSpinY: 0.15,
      idleSpinX: 0.05,
      friction: 0.96,
      sensitivity: 0.5,
      perspective: 1400,
      sliceCount: 40,
      thickness: 48,
      sliceAlpha: 0.55,
    }

    stage.style.perspective = cfg.perspective + 'px'

    let rotX = -6, rotY = 12
    let velX = 0, velY = 0
    let dragging = false
    let lastX = 0, lastY = 0, startX = 0, startY = 0
    let lastMoveTime = 0
    let inputVelX = 0, inputVelY = 0
    let rafId = 0

    const logoSrc = logoEntry.src
    const fxState: Record<string, boolean> = {
      sweep: false, gloss: false, sparkles: false,
      holo: false, bevel: false, glass: false,
      reflection: false, rim: false,
    }
    logoEntry.preset.forEach(k => { fxState[k] = true })

    let slices: HTMLImageElement[] = []
    let fxEls: Record<string, HTMLElement | null> = {}

    function buildStack(nW: number, nH: number) {
      slices.forEach(el => el.remove())
      slices = []
      Object.values(fxEls).forEach(el => el?.remove())
      fxEls = {}

      const n = cfg.sliceCount
      const step = cfg.thickness / Math.max(1, n - 1)
      const half = cfg.thickness / 2

      for (let i = 0; i < n; i++) {
        const z = -half + i * step
        const img = document.createElement('img')
        img.className = 'splash-slice'
        img.src = logoSrc
        img.draggable = false

        let filter = `opacity(${cfg.sliceAlpha})`
        if (fxState.glass && z < 0) filter += ' hue-rotate(40deg) saturate(1.3)'
        if (fxState.bevel) {
          const t = Math.abs(z) / half          // 0 = center, 1 = edge
          const b = 1 - 0.35 * (1 - t)         // center 0.65 → edge 1.0
          filter += ` brightness(${b.toFixed(3)})`
        }
        if (fxState.rim && (i === 0 || i === n - 1)) filter += ' brightness(1.6) saturate(1.4)'
        img.style.filter = filter
        img.style.transform = `translate(-50%, -50%) translateZ(${z.toFixed(2)}px)`
        logo.appendChild(img)
        slices.push(img)
      }

      // Overlay effects sit on the front face, masked by logo alpha
      const frontZ = (cfg.thickness / 2 + 0.5).toFixed(2)
      function addOverlay(cls: string) {
        const el = document.createElement('div')
        el.className = 'splash-fx-overlay ' + cls
        el.style.aspectRatio = `${nW} / ${nH}`
        el.style.maskImage = `url(${logoSrc})`
        ;(el.style as unknown as Record<string,string>).webkitMaskImage = `url(${logoSrc})`
        el.style.maskSize = '100% 100%'
        ;(el.style as unknown as Record<string,string>).webkitMaskSize = '100% 100%'
        el.style.maskRepeat = 'no-repeat'
        el.style.transform = `translate(-50%, -50%) translateZ(${frontZ}px)`
        logo.appendChild(el)
        return el
      }

      if (fxState.sweep)  fxEls.sweep  = addOverlay('splash-fx-sweep')
      if (fxState.gloss)  fxEls.gloss  = addOverlay('splash-fx-gloss')
      if (fxState.holo)   fxEls.holo   = addOverlay('splash-fx-holo')

      if (fxState.sparkles) {
        const el = addOverlay('splash-fx-sparkles')
        for (let s = 0; s < 18; s++) {
          const sp = document.createElement('div')
          sp.className = 'splash-fx-sparkle'
          sp.style.left = (Math.random() * 100).toFixed(1) + '%'
          sp.style.top = (Math.random() * 100).toFixed(1) + '%'
          sp.style.animationDelay = (Math.random() * 2).toFixed(2) + 's'
          sp.style.animationDuration = (1.4 + Math.random() * 1.2).toFixed(2) + 's'
          el.appendChild(sp)
        }
        fxEls.sparkles = el
      }

      if (fxState.reflection) {
        const refl = document.createElement('div')
        refl.className = 'splash-fx-reflection'
        refl.style.aspectRatio = `${nW} / ${nH}`
        refl.style.transform = `translate(-50%, 100%) scaleY(-1) translateZ(0)`
        const img = document.createElement('img')
        img.src = logoSrc
        img.style.cssText = 'width:100%;height:100%;display:block;pointer-events:none;'
        img.draggable = false
        refl.appendChild(img)
        logo.appendChild(refl)
        fxEls.reflection = refl
      }
    }

    // Preload image to get natural dimensions for correct overlay aspect ratio
    const preload = new Image()
    preload.src = logoSrc
    function init() {
      buildStack(preload.naturalWidth || 800, preload.naturalHeight || 800)
      const imgs = Array.from(logo.querySelectorAll<HTMLImageElement>('img.splash-slice'))
      Promise.all(imgs.map(img => img.decode ? img.decode().catch(() => {}) : Promise.resolve()))
        .then(() => requestAnimationFrame(() => logo.classList.add('loaded')))
    }
    if (preload.complete && preload.naturalWidth > 0) init()
    else {
      preload.addEventListener('load', init, { once: true })
      preload.addEventListener('error', init, { once: true })
    }

    // Pointer drag
    function onDown(e: PointerEvent) {
      if ((e.target as HTMLElement).closest?.('.splash-footer-nav')) return
      dragging = true
      startX = lastX = e.clientX
      startY = lastY = e.clientY
      lastMoveTime = performance.now()
      inputVelX = inputVelY = 0
      stage.setPointerCapture(e.pointerId)
    }
    function onMove(e: PointerEvent) {
      if (!dragging) return
      const dx = e.clientX - lastX
      const dy = e.clientY - lastY
      lastX = e.clientX; lastY = e.clientY
      rotY += dx * cfg.sensitivity
      rotX -= dy * cfg.sensitivity
      const now = performance.now()
      const dt = Math.max(1, now - lastMoveTime)
      inputVelX = (-dy * cfg.sensitivity) * (16.67 / dt)
      inputVelY = (dx * cfg.sensitivity) * (16.67 / dt)
      lastMoveTime = now
    }
    function onUp(e: PointerEvent) {
      if (!dragging) return
      dragging = false
      velX = inputVelX; velY = inputVelY
      stage.releasePointerCapture(e.pointerId)
      // Tap (no significant drag) = dismiss
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) {
        dismissRef.current()
      }
    }

    stage.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp as EventListener)
    window.addEventListener('pointercancel', onUp as EventListener)
    stage.addEventListener('contextmenu', e => e.preventDefault())

    function tick() {
      if (!dragging) {
        velX *= cfg.friction
        velY *= cfg.friction
        // Blend toward idle spin when nearly at rest
        if (Math.hypot(velX, velY) < 0.5) {
          velX += (cfg.idleSpinX - velX) * 0.02
          velY += (cfg.idleSpinY - velY) * 0.02
        }
        rotX += velX
        rotY += velY
      }
      logo.style.transform = `rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg)`
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(rafId)
      stage.removeEventListener('pointerdown', onDown)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp as EventListener)
      window.removeEventListener('pointercancel', onUp as EventListener)
    }
  }, [logoEntry])

  if (dismissed) return null

  return (
    <div className={`splash-outer${exiting ? ' exiting' : ''}`}>
      <div className="splash-masthead">
        <span className="splash-title">Fake Healthcare Experts</span>
        <span className="splash-clock">{clockStr}</span>
      </div>

      <div ref={stageRef} className="splash-stage-3d">
        <div ref={logoRef} className="splash-logo-wrap" />
      </div>

      <nav className="splash-footer-nav">
        <a href="#characters" onClick={dismiss}>FAKES</a>
        <a href="/blog.html">BLOG</a>
        <a href="/order.html">SWAG</a>
      </nav>
    </div>
  )
}
