'use client'

import { useState, useEffect, Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import LogoCarousel from './LogoCarousel'

export default function SplashOverlay() {
  const [dismissed, setDismissed] = useState(false)
  const [exiting, setExiting] = useState(false)
  const [clockStr, setClockStr] = useState('')

  // Live clock
  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setClockStr(now.toTimeString().slice(0, 8))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Keyboard [Enter] also dismisses
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') dismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const dismiss = () => {
    if (exiting) return
    setExiting(true)
    setTimeout(() => setDismissed(true), 920)
  }

  if (dismissed) return null

  return (
    <div
      className={`splash-overlay${exiting ? ' exiting' : ''}`}
      onClick={dismiss}
    >
      <div className="splash-header">
        <span className="splash-logo-text">Fake Healthcare Experts</span>
        <span className="splash-clock">{clockStr}</span>
      </div>

      <hr className="splash-hr" />

      <div className="splash-body">
        <div className="splash-canvas-container">
          <Canvas
            camera={{ fov: 55, position: [0, 1.6, 4.2] as [number, number, number] }}
            gl={{ alpha: true, antialias: true }}
            style={{ background: 'transparent', width: '100%', height: '100%' }}
          >
            <ambientLight intensity={0.5} />
            <directionalLight position={[5, 5, 5]} intensity={1.5} />
            <directionalLight position={[-5, -2, -5]} intensity={0.6} color="#8888ff" />
            <Suspense fallback={null}>
              <LogoCarousel />
            </Suspense>
          </Canvas>
        </div>

        <p className="splash-subtitle">Fake Bobby &mdash; Fake David &mdash; Fake Tommy</p>
        <p className="splash-subtitle muted">
          A satirical, educational website demonstrating how to identify phishing.
        </p>
      </div>

      <hr className="splash-hr" />

      <div className="splash-footer">
        <span className="splash-enter">[Enter]</span>
        <span className="splash-hint">click anywhere to enter</span>
      </div>
    </div>
  )
}
