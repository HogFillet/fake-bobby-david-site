'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'

// ── Types ────────────────────────────────────────────────────────────────────

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '#ff1744', HIGH: '#ff6d00', MEDIUM: '#ffc400', LOW: '#00c853', NONE: '#78909c',
}
const SEVERITY_WEIGHTS: Record<string, number> = {
  CRITICAL: 10, HIGH: 7.5, MEDIUM: 5, LOW: 2.5, NONE: 0,
}
const SCOPE_FACTOR: Record<string, number> = {
  CRITICAL: 3.0, HIGH: 2.0, MEDIUM: 1.5, LOW: 1.0, NONE: 0.5,
}

interface CVE {
  id: string; published: string; severity: string; score: number
  description: string; kev?: boolean; epss?: number; epssPercentile?: number
  daysOpen?: number; trustDebt?: number
}
interface CVEWithDebt extends CVE { daysOpen: number; trustDebt: number }
interface HistoryEntry {
  company: string; years: number; cveCount: number; totalDebt: number
  grade: string; timestamp: number; severityCounts: Record<string, number>
}
interface Quarter { label: string; debt: number; count: number; critHigh: number }
interface Trajectory {
  tdCurrent: number; tdPrevious: number; delta: number; recurrence: number
  kevCount: number; kFactor: number; epssHighCount: number; pFactor: number
  trajectory: number; currentWindow: CVEWithDebt[]; previousWindow: CVEWithDebt[]
  critHighCurrent: number; quarters: Quarter[]
}
interface TrustVelocity { qoq: number[]; avg: number; grade: string; label: string; color: string }
interface LeaderboardEntry {
  slug: string; name: string; grade: string; trajectory: number
  cveCount: number; percentileRank?: number | null; breachCount?: number
  kevCount?: number; epssHighCount?: number; critCount?: number; highCount?: number; delta?: number
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TRUST_DEBT_API = 'https://trust-debt-api.hogfillet.workers.dev'
const CVE_SEARCH_API = 'https://cve-search.hogfillet.workers.dev'
const GRADE_COLOR: Record<string, string> = {
  'A+': '#00c853', A: '#00c853', B: '#64dd17', C: '#ffc400', D: '#ff6d00', F: '#ff1744',
}
const PRESETS = ['Microsoft', 'Apple', 'Google', 'Cisco', 'Adobe', 'Oracle', 'Fortinet', 'VMware', 'Samsung', 'Intel']
const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'] as const
type Grade = typeof GRADE_ORDER[number]

// ── Utility functions ──────────────────────────────────────────────────────────

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
}
function filterByVendorMatch(cves: CVE[], query: string): CVE[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return cves
  const patterns = words.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))
  const filtered = cves.filter(c => patterns.every(re => re.test(c.description || '')))
  return filtered.length > 0 ? filtered : cves
}
function calculateTrustDebt(cves: CVE[]): CVEWithDebt[] {
  const now = new Date()
  return cves.map((cve) => {
    const published = new Date(cve.published)
    const daysOpen = Math.max(1, Math.floor((now.getTime() - published.getTime()) / 86400000))
    const severity = cve.severity || 'NONE'
    const vi = SEVERITY_WEIGHTS[severity] || 0
    const si = SCOPE_FACTOR[severity] || 1
    const ti = Math.log2(daysOpen + 1)
    return { ...cve, daysOpen, trustDebt: vi * si * ti }
  })
}
function calculateTrajectory(cves: CVEWithDebt[]): Trajectory {
  const now = new Date()
  const msPerDay = 86400000
  const windowMs = 365 * msPerDay
  const currentWindow = cves.filter((c) => now.getTime() - new Date(c.published).getTime() <= windowMs)
  const previousWindow = cves.filter((c) => {
    const age = now.getTime() - new Date(c.published).getTime()
    return age > windowMs && age <= windowMs * 2
  })
  const tdCurrent = currentWindow.reduce((s, c) => s + c.trustDebt, 0)
  const tdPrevious = previousWindow.reduce((s, c) => s + c.trustDebt, 0)
  let delta = 1
  if (tdPrevious > 0) delta = Math.min(2.0, Math.max(0.5, tdCurrent / tdPrevious))
  else if (tdCurrent > 0 && previousWindow.length > 0) delta = 2.0
  const critHighCurrent = currentWindow.filter(c => c.severity === 'CRITICAL' || c.severity === 'HIGH').length
  const recurrence = 1 + critHighCurrent * 0.15
  const kevCount = currentWindow.filter((c) => c.kev).length
  const kFactor = 1 + 0.30 * kevCount
  const epssHighCount = currentWindow.filter((c) => (c.epss ?? 0) > 0.10).length
  const epssSum = currentWindow.reduce((s, c) => {
    const score = c.epss ?? 0
    const pct = c.epssPercentile ?? score
    return s + (score > 0.10 ? score * pct : 0)
  }, 0)
  const pFactor = Math.min(3.0, 1 + epssSum)
  const trajectory = tdCurrent * delta * recurrence * kFactor * pFactor
  const quarters: Quarter[] = []
  for (let q = 7; q >= 0; q--) {
    const qStart = new Date(now.getTime() - (q + 1) * 91 * msPerDay)
    const qEnd = new Date(now.getTime() - q * 91 * msPerDay)
    const qCves = cves.filter((c) => { const pub = new Date(c.published); return pub >= qStart && pub < qEnd })
    const qDebt = qCves.reduce((s, c) => s + c.trustDebt, 0)
    const qCritHigh = qCves.filter((c) => c.severity === 'CRITICAL' || c.severity === 'HIGH').length
    const qYear = qStart.getFullYear()
    const qNum = Math.floor(qStart.getMonth() / 3) + 1
    quarters.push({ label: `${qYear} Q${qNum}`, debt: qDebt, count: qCves.length, critHigh: qCritHigh })
  }
  return { tdCurrent, tdPrevious, delta, recurrence, kevCount, kFactor, epssHighCount, pFactor, trajectory, currentWindow, previousWindow, critHighCurrent, quarters }
}
function getGrade(trajectory: number, totalCVEs: number): string {
  if (!totalCVEs) return 'A+'
  const norm = trajectory / totalCVEs
  if (norm < 30) return 'A'
  if (norm < 80) return 'B'
  if (norm < 180) return 'C'
  if (norm < 400) return 'D'
  return 'F'
}
function gradeRank(g: string): number { return GRADE_ORDER.indexOf(g as Grade) }
function debtGrade(debt: number): { grade: string; color: string } {
  if (debt === 0) return { grade: 'A', color: '#00c853' }
  if (debt < 100) return { grade: 'C', color: '#ffc400' }
  if (debt < 400) return { grade: 'D', color: '#ff6d00' }
  return { grade: 'F', color: '#ff1744' }
}
function capGrade(result: { grade: string; color: string }, debt: number): { grade: string; color: string } {
  const cap = debtGrade(debt)
  return gradeRank(result.grade) > gradeRank(cap.grade) ? cap : result
}
function qoqTransition(quarters: Quarter[], i: number): { change: number; isNew: boolean } {
  const prev = quarters[i - 1].debt; const curr = quarters[i].debt
  if (prev > 0) return { change: (curr - prev) / prev, isNew: false }
  if (curr === 0) return { change: 0, isNew: false }
  return { change: 0, isNew: true }
}
function calculateTrustVelocity(quarters: Quarter[]): TrustVelocity | null {
  if (quarters.length < 2 || !quarters.some(q => q.debt > 0)) return null
  const qoq = quarters.slice(1).map((_, i) => {
    const { change, isNew } = qoqTransition(quarters, i + 1)
    if (!isNew) return change
    const debt = quarters[i + 1].debt
    return debt < 100 ? 0.05 : debt < 500 ? 0.20 : debt < 1500 ? 0.40 : 0.60
  })
  const avg = qoq.reduce((s, v) => s + v, 0) / qoq.length
  if (avg <= -0.15) return { qoq, avg, grade: 'A', label: 'Paying down debt', color: '#00c853' }
  if (avg < 0) return { qoq, avg, grade: 'B', label: 'Slowly improving', color: '#64dd17' }
  if (avg < 0.10) return { qoq, avg, grade: 'C', label: 'Stable', color: '#ffc400' }
  if (avg < 0.30) return { qoq, avg, grade: 'D', label: 'Accumulating risk', color: '#ff6d00' }
  return { qoq, avg, grade: 'F', label: 'Debt spiral', color: '#ff1744' }
}
function velGrade(qoq: number, currentDebt?: number): { grade: string; color: string } {
  if (Math.abs(qoq) <= 0.10 && currentDebt !== undefined) return debtGrade(currentDebt)
  let result: { grade: string; color: string }
  if (qoq <= -0.15) result = { grade: 'A', color: '#00c853' }
  else if (qoq < 0) result = { grade: 'B', color: '#64dd17' }
  else if (qoq < 0.10) result = { grade: 'C', color: '#ffc400' }
  else if (qoq < 0.30) result = { grade: 'D', color: '#ff6d00' }
  else result = { grade: 'F', color: '#ff1744' }
  return currentDebt !== undefined ? capGrade(result, currentDebt) : result
}

// ── Card Art: deterministic interference pattern ───────────────────────────

function hash(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0; let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CWE_CATALOG = [
  { id: 'CWE-79',  name: 'Cross-Site Scripting',      desc: 'Unsanitized input reflected into page output, enabling script injection.' },
  { id: 'CWE-89',  name: 'SQL Injection',              desc: 'User-controlled input interpolated into SQL query without parameterization.' },
  { id: 'CWE-22',  name: 'Path Traversal',             desc: 'Filename parameter allows traversal outside the intended directory.' },
  { id: 'CWE-78',  name: 'OS Command Injection',       desc: 'Shell command constructed from unvalidated input permits arbitrary execution.' },
  { id: 'CWE-416', name: 'Use After Free',             desc: 'Heap memory accessed after deallocation leads to code execution primitive.' },
  { id: 'CWE-787', name: 'Out-of-bounds Write',        desc: 'Buffer boundary not enforced; attacker-controlled write corrupts adjacent memory.' },
  { id: 'CWE-502', name: 'Unsafe Deserialization',     desc: 'Attacker-supplied serialized object instantiates arbitrary classes on restore.' },
  { id: 'CWE-306', name: 'Missing Authentication',     desc: 'Critical function reachable without verifying caller identity.' },
  { id: 'CWE-918', name: 'Server-Side Request Forgery','desc': 'URL parameter causes server to issue requests to internal infrastructure.' },
  { id: 'CWE-611', name: 'XML External Entity',        desc: 'XML parser resolves external entity references, exposing local files.' },
  { id: 'CWE-287', name: 'Improper Authentication',    desc: 'Authentication mechanism bypassable via crafted credential sequence.' },
  { id: 'CWE-434', name: 'Unrestricted File Upload',   desc: 'File type not validated server-side; executable content accepted and stored.' },
  { id: 'CWE-20',  name: 'Improper Input Validation',  desc: 'Input accepted without structural checks, enabling downstream misinterpretation.' },
  { id: 'CWE-119', name: 'Buffer Overflow',            desc: 'Fixed-size buffer written past end; return address or vtable pointer overwritten.' },
  { id: 'CWE-732', name: 'Insecure Permissions',       desc: 'Resource permissions grant write access to unintended principals.' },
]

function CardArt({ seed, color }: { seed: number; color: string }) {
  const els = useMemo(() => {
    const r = rng(seed)
    return Array.from({ length: 8 }, () => ({
      cx: 40 + r() * 220, cy: 30 + r() * 140, rad: 18 + r() * 120, op: 0.05 + r() * 0.18,
    }))
  }, [seed])
  const angle = seed % 360
  const gradId = `g${seed}`, patId = `p${seed}`
  const cveYear = 2021 + (seed % 5)
  const cveNum = String((seed % 9000) + 1000)
  const cveId = `CVE-${cveYear}-${cveNum}`
  const cwe = CWE_CATALOG[seed % CWE_CATALOG.length]
  const score = (7.0 + (seed % 31) / 10).toFixed(1)
  // Split description into two lines of ~42 chars each
  const words = cwe.desc.split(' ')
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    if ((line + ' ' + w).trim().length > 42 && line) { lines.push(line); line = w } else { line = (line + ' ' + w).trim() }
  }
  if (line) lines.push(line)
  const [l1, l2] = [lines[0] ?? '', lines[1] ?? '']

  return (
    <svg viewBox="0 0 300 200" preserveAspectRatio="xMidYMid slice" style={{ display: 'block', width: '100%', height: '100%' }}>
      <defs>
        <radialGradient id={gradId} cx="50%" cy="40%" r="80%">
          <stop offset="0%" stopColor={color} stopOpacity="0.55" />
          <stop offset="60%" stopColor={color} stopOpacity="0.08" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.8" />
        </radialGradient>
        <pattern id={patId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform={`rotate(${angle})`}>
          <rect width="6" height="6" fill="transparent" />
          <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeOpacity="0.18" strokeWidth="0.6" />
        </pattern>
      </defs>
      <rect width="300" height="200" fill={`url(#${gradId})`} />
      <rect width="300" height="200" fill={`url(#${patId})`} />
      {els.map((e, i) => (
        <circle key={i} cx={e.cx} cy={e.cy} r={e.rad} fill="none" stroke={color} strokeWidth="0.5" strokeOpacity={e.op} />
      ))}
      {/* Upper left — CVE ID */}
      <text x="12" y="20" fontFamily="JetBrains Mono, monospace" fontSize="9" fontWeight="600" fill="rgba(255,255,255,0.9)" letterSpacing="0.5">
        {cveId}
      </text>
      {/* Upper right — CWE */}
      <text x="288" y="14" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="8" fill={color} fillOpacity="0.9" letterSpacing="0.3">
        {cwe.id}
      </text>
      <text x="288" y="25" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="8" fill={color} fillOpacity="0.65" letterSpacing="0.2">
        {cwe.name}
      </text>
      {/* Lower left — description */}
      <text x="12" y="174" fontFamily="JetBrains Mono, monospace" fontSize="7.5" fill="rgba(255,255,255,0.45)" letterSpacing="0.1">{l1}</text>
      <text x="12" y="185" fontFamily="JetBrains Mono, monospace" fontSize="7.5" fill="rgba(255,255,255,0.45)" letterSpacing="0.1">{l2}</text>
      {/* Lower right — base score */}
      <text x="288" y="185" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="8" fill="rgba(255,255,255,0.35)" letterSpacing="0.5">BASE SCORE</text>
      <text x="288" y="197" textAnchor="end" fontFamily="JetBrains Mono, monospace" fontSize="13" fontWeight="700" fill={color} fillOpacity="0.9" letterSpacing="0.5">
        {score}
      </text>
    </svg>
  )
}

// ── TradingCard ────────────────────────────────────────────────────────────────

type CardPosition = 'center' | 'left' | 'right' | 'far-left' | 'far-right'

const POS_STYLE: Record<CardPosition, React.CSSProperties> = {
  center:      { transform: 'translateZ(0) rotateY(0deg) rotateX(0deg)', zIndex: 5, opacity: 1, filter: 'none' },
  left:        { transform: 'translateX(-300px) translateZ(-160px) rotateY(22deg) scale(0.88)', opacity: 0.55, filter: 'blur(0.4px) brightness(0.7)', zIndex: 3, pointerEvents: 'none' },
  right:       { transform: 'translateX(300px) translateZ(-160px) rotateY(-22deg) scale(0.88)', opacity: 0.55, filter: 'blur(0.4px) brightness(0.7)', zIndex: 3, pointerEvents: 'none' },
  'far-left':  { transform: 'translateX(-460px) translateZ(-320px) rotateY(28deg) scale(0.72)', opacity: 0, pointerEvents: 'none', zIndex: 2 },
  'far-right': { transform: 'translateX(460px) translateZ(-320px) rotateY(-28deg) scale(0.72)', opacity: 0, pointerEvents: 'none', zIndex: 2 },
}

function gradeToTier(grade: string): { color: string; label: string; blurb: string } {
  if (grade === 'A+' || grade === 'A') return { color: '#62d27a', label: 'CONTAINED', blurb: 'Quieter than peers across the window.' }
  if (grade === 'B') return { color: '#f5a524', label: 'MODERATE', blurb: 'Average for the cohort; nothing unusual.' }
  if (grade === 'C') return { color: '#f5a524', label: 'MODERATE', blurb: 'Carrying moderate disclosure debt.' }
  if (grade === 'D') return { color: '#e85a30', label: 'ELEVATED', blurb: 'Carrying a real backlog of disclosure debt.' }
  return { color: '#e02020', label: 'SEVERE', blurb: 'A long, costly tail of unpatched edges.' }
}

function TradingCard({ company, position, onClick, sbdp }: {
  company: LeaderboardEntry
  position: CardPosition
  onClick?: () => void
  sbdp?: boolean
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, mx: 50, my: 50 })
  const isCenter = position === 'center'
  const tier = gradeToTier(company.grade)
  const seed = hash(company.slug)
  const serial = String((seed % 999) + 1).padStart(3, '0')
  const hibpCount = company.breachCount ?? 0

  function onMove(e: React.MouseEvent) {
    if (!isCenter || !cardRef.current) return
    const r = cardRef.current.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    setTilt({ rx: (0.5 - y) * 16, ry: (x - 0.5) * 18, mx: x * 100, my: y * 100 })
  }
  function onLeave() { setTilt({ rx: 0, ry: 0, mx: 50, my: 50 }) }

  const posStyle = POS_STYLE[position]
  const centerTransform = isCenter
    ? `translateZ(0) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`
    : posStyle.transform

  return (
    <div
      ref={cardRef}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      onClick={isCenter && onClick ? onClick : undefined}
      style={{
        position: 'absolute',
        width: 340,
        height: 500,
        borderRadius: 18,
        padding: 14,
        background: 'linear-gradient(135deg, #1a1a1a 0%, #0e0e0e 50%, #1a1a1a 100%)',
        boxShadow: '0 30px 60px -20px rgba(0,0,0,0.7), 0 10px 30px -10px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(255,255,255,0.04)',
        cursor: isCenter ? 'pointer' : 'default',
        transformStyle: 'preserve-3d',
        transition: 'transform 600ms cubic-bezier(0.2,0.8,0.2,1), opacity 600ms ease, filter 400ms ease',
        willChange: 'transform',
        ...posStyle,
        transform: centerTransform,
      }}
    >
      {/* Outer metallic rim */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 18,
        background: 'linear-gradient(140deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.02) 30%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0.02) 70%, rgba(255,255,255,0.18) 100%)',
        WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
        WebkitMaskComposite: 'xor',
        padding: 1,
        pointerEvents: 'none',
      }} />

      {/* Inner card */}
      <div style={{
        position: 'relative', height: '100%', borderRadius: 12,
        border: '1px solid rgba(255,255,255,0.06)',
        background: 'linear-gradient(180deg, #141312 0%, #0d0c0b 100%)',
        padding: '14px 16px 16px',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Holographic sheen */}
        <div style={{
          position: 'absolute', inset: 0, borderRadius: 12, pointerEvents: 'none',
          background: `radial-gradient(800px circle at ${tilt.mx}% ${tilt.my}%, rgba(255,255,255,0.10), transparent 30%), conic-gradient(from ${tilt.mx}deg at 50% 50%, ${tier.color}10, rgba(245,165,36,0.06), rgba(98,210,122,0.06), rgba(80,140,255,0.06), ${tier.color}10)`,
          mixBlendMode: 'screen', opacity: isCenter ? 0.6 : 0.3,
          transition: 'opacity 240ms',
        }} />
        {/* Grain */}
        <div style={{
          position: 'absolute', inset: 0, pointerEvents: 'none',
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)',
          backgroundSize: '4px 4px', opacity: 0.35,
        }} />

        {/* Header */}
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: 12, paddingBottom: 10, borderBottom: '1px solid rgba(255,255,255,0.06)',
          position: 'relative', zIndex: 1,
        }}>
          <div>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 22, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1, color: '#ece7d9' }}>
              {company.name}
            </div>
            <div style={{ marginTop: 6, display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', padding: '3px 7px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 999, color: '#7a736a' }}>{tier.label}</span>
              {sbdp && <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '3px 7px', border: '1px solid rgba(6,182,212,0.4)', borderRadius: 999, color: '#06b6d4', background: 'rgba(6,182,212,0.1)', fontWeight: 700 }}>SBDP ✓</span>}
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '3px 7px', border: `1px solid ${hibpCount > 0 ? 'rgba(249,115,22,0.4)' : 'rgba(98,210,122,0.4)'}`, borderRadius: 999, color: hibpCount > 0 ? '#f97316' : '#62d27a', background: hibpCount > 0 ? 'rgba(249,115,22,0.1)' : 'rgba(98,210,122,0.1)', fontWeight: 700 }}>HIBP {hibpCount > 0 ? `×${hibpCount}` : '0'}</span>
            </div>
          </div>
          <div style={{ textAlign: 'right', lineHeight: 1, flexShrink: 0 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.18em', color: '#7a736a', textTransform: 'uppercase', marginBottom: 4 }}>Trust Debt™</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 22, color: tier.color, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.5 }}>
              {Math.round(company.trajectory).toLocaleString()}<small style={{ fontSize: 11, color: '#7a736a', fontWeight: 400, marginLeft: 4, letterSpacing: '0.1em' }}>pt</small>
            </div>
          </div>
        </div>

        {/* Art window */}
        <div style={{
          marginTop: 12, height: 170, borderRadius: 8, overflow: 'hidden',
          position: 'relative', border: '1px solid rgba(255,255,255,0.06)', background: '#050505',
        }}>
          <CardArt seed={seed} color={tier.color} />
          <div style={{
            position: 'absolute', bottom: 6, left: 8, right: 8,
            display: 'flex', justifyContent: 'space-between',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.14em',
            color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase',
            textShadow: '0 1px 2px rgba(0,0,0,0.6)',
          }}>
            <span>FB-TD/2026.1</span>
            <span>№ {serial}/999</span>
          </div>
        </div>

        {/* Grade strip */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 14, alignItems: 'center',
          marginTop: 12, padding: '10px 12px', borderRadius: 8,
          background: `${tier.color}18`,
          border: `1px solid ${tier.color}40`,
        }}>
          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 48, lineHeight: 0.9, color: tier.color, fontWeight: 800, fontStyle: 'italic', minWidth: 40, textAlign: 'center' }}>
            {company.grade}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.18em', color: tier.color, textTransform: 'uppercase', fontWeight: 600 }}>
              Tier · {tier.label}
            </div>
            <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 11, color: '#7a736a', lineHeight: 1.3 }}>
              {tier.blurb}
            </div>
          </div>
        </div>

        {/* Stats grid */}
        {(() => {
          const kev = company.kevCount ?? 0
          const epss = company.epssHighCount ?? 0
          const crit = company.critCount ?? 0
          const high = company.highCount ?? 0
          const d = company.delta ?? 1
          const deltaLabel = d < 0.95 ? `↓ ${Math.round((1 - d) * 100)}%` : d > 1.05 ? `↑ ${Math.round((d - 1) * 100)}%` : '→ stable'
          const deltaColor = d < 0.95 ? '#62d27a' : d > 1.05 ? '#e02020' : '#f5a524'
          return (
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px' }}>
              {[
                { k: 'ATK · Crit', v: crit.toString(), vc: crit > 0 ? '#ff1744' : '#7a736a' },
                { k: 'HP · CVEs', v: company.cveCount.toLocaleString(), vc: '#ece7d9' },
                { k: 'KEV hits', v: kev > 0 ? String(kev) : 'none', vc: kev > 0 ? '#ff1744' : '#7a736a' },
                { k: 'High EPSS', v: epss > 0 ? String(epss) : 'none', vc: epss > 0 ? '#ff6d00' : '#7a736a' },
                { k: 'Crit+High', v: `${crit + high}`, vc: (crit + high) > 10 ? '#ff6d00' : '#ece7d9' },
                { k: 'Trend', v: deltaLabel, vc: deltaColor },
              ].map(({ k, v, vc }) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 0', borderBottom: '1px dashed rgba(255,255,255,0.07)', fontFamily: "'JetBrains Mono', monospace", fontSize: 9.5, letterSpacing: '0.04em' }}>
                  <span style={{ color: '#7a736a', textTransform: 'uppercase' }}>{k}</span>
                  <span style={{ color: vc, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
                </div>
              ))}
            </div>
          )
        })()}

        {/* Footer */}
        <div style={{
          marginTop: 'auto', paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          fontFamily: "'JetBrains Mono', monospace", fontSize: 9, letterSpacing: '0.1em',
          color: '#7a736a', textTransform: 'uppercase',
        }}>
          <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: 11, fontStyle: 'italic', color: '#ece7d9', textTransform: 'none', letterSpacing: 0, flex: 1, marginRight: 12 }}>
            &ldquo;{tier.blurb}&rdquo;
          </span>
          <span>NVD · live</span>
        </div>
      </div>
    </div>
  )
}

// ── CompanyDeck ────────────────────────────────────────────────────────────────

function CompanyDeck({ companies, onSelect, sbdpSlugs }: { companies: LeaderboardEntry[]; onSelect: (name: string) => void; sbdpSlugs: string[] }) {
  function isSBDP(slug: string) { return sbdpSlugs.some(s => s === slug || s.startsWith(slug + '-') || slug.startsWith(s + '-')) }
  const [idx, setIdx] = useState(0)
  const [auto, setAuto] = useState(true)
  const n = companies.length

  useEffect(() => {
    if (!auto || n < 2) return
    const t = setInterval(() => setIdx(v => (v + 1) % n), 4500)
    return () => clearInterval(t)
  }, [auto, n])

  function posFor(i: number): CardPosition | null {
    const d = ((i - idx) % n + n) % n
    if (d === 0) return 'center'
    if (d === 1) return 'right'
    if (d === n - 1) return 'left'
    if (d === 2) return 'far-right'
    if (d === n - 2) return 'far-left'
    return null
  }

  return (
    <div>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#475569' }}>
          § Tracked Companies
        </span>
        <div style={{ flex: 1, height: 1, background: 'rgba(148,163,184,0.08)' }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: '#475569' }}>
          {n} cards · click to score
        </span>
      </div>

      {/* Stage */}
      <div style={{
        position: 'relative', height: 560,
        perspective: '1600px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden',
      }}>
        {companies.map((company, i) => {
          const pos = posFor(i)
          if (!pos) return null
          return (
            <TradingCard
              key={company.slug}
              company={company}
              position={pos}
              sbdp={isSBDP(company.slug)}
              onClick={() => { setAuto(false); onSelect(company.name) }}
            />
          )
        })}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 24, marginTop: 12 }}>
        <button
          onClick={() => { setAuto(false); setIdx(v => (v - 1 + n) % n) }}
          style={{ width: 40, height: 40, borderRadius: '50%', border: '1px solid rgba(148,163,184,0.12)', background: 'rgba(15,23,42,0.6)', color: '#475569', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'all 200ms' }}
          aria-label="Previous"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
        </button>

        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: '#475569', letterSpacing: '0.14em', textTransform: 'uppercase', minWidth: 120, textAlign: 'center' }}>
          <span style={{ color: '#e2e8f0', fontWeight: 500 }}>{String(idx + 1).padStart(2, '0')}</span>
          {' / '}{String(n).padStart(2, '0')} · {companies[idx]?.name}
        </div>

        <button
          onClick={() => { setAuto(false); setIdx(v => (v + 1) % n) }}
          style={{ width: 40, height: 40, borderRadius: '50%', border: '1px solid rgba(148,163,184,0.12)', background: 'rgba(15,23,42,0.6)', color: '#475569', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', transition: 'all 200ms' }}
          aria-label="Next"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
        </button>

        {/* Auto-rotate button */}
        <button
          onClick={() => setAuto(a => !a)}
          title={auto ? 'Pause auto-rotation' : 'Resume auto-rotation'}
          style={{
            position: 'relative', width: 28, height: 28, borderRadius: '50%',
            border: '1px solid rgba(148,163,184,0.12)', cursor: 'pointer',
            background: auto ? 'rgba(99,102,241,0.1)' : 'rgba(15,23,42,0.6)',
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          }}
        >
          <span style={{ fontSize: 10, color: auto ? '#818cf8' : '#475569' }}>{auto ? '⏸' : '▶'}</span>
        </button>
      </div>

      {/* Pip dots */}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 18 }}>
        {companies.map((_, i) => (
          <span
            key={i}
            onClick={() => { setAuto(false); setIdx(i) }}
            style={{
              width: i === idx ? 18 : 6, height: 6,
              background: i === idx ? '#6366f1' : 'rgba(148,163,184,0.15)',
              borderRadius: 3, cursor: 'pointer',
              transition: 'all 300ms',
            }}
          />
        ))}
      </div>

      {/* Link to compare */}
      <div style={{ textAlign: 'center', marginTop: 20 }}>
        <a href="/trust/vs/" style={{ fontSize: 11, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', padding: '4px 12px', borderRadius: 6 }}>
          ⚔ Compare companies →
        </a>
      </div>
    </div>
  )
}

// ── Existing Analysis Components ───────────────────────────────────────────────

function TrendIndicator({ delta }: { delta: number }) {
  const improving = delta < 0.95; const worsening = delta > 1.05
  const color = improving ? '#00c853' : worsening ? '#ff1744' : '#ffc400'
  const arrow = improving ? '↓' : worsening ? '↑' : '→'
  const label = improving ? `${Math.round((1 - delta) * 100)}% improving` : worsening ? `${Math.round((delta - 1) * 100)}% worsening` : 'Stable'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <span style={{ fontSize: 28, fontWeight: 800, color }}>{arrow}</span>
      <span style={{ fontSize: 10, color, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>{label}</span>
    </div>
  )
}

function QuarterlySparkline({ quarters }: { quarters: Quarter[] }) {
  const maxDebt = Math.max(...quarters.map((q) => q.debt), 1)
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 0.8 }}>CVEs / qtr</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 60 }}>
        {quarters.map((q, i) => {
          const pct = (q.debt / maxDebt) * 100; const isRecent = i >= 6
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{q.count > 0 ? q.count : ''}</span>
              <div style={{ width: '100%', height: `${Math.max(pct, 3)}%`, borderRadius: '3px 3px 0 0', background: isRecent ? 'linear-gradient(to top, #6366f1, #818cf8)' : 'rgba(99,102,241,0.25)', transition: 'height 0.6s ease', minHeight: 2 }} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function AnimatedNumber({ value, duration = 800 }: { value: number; duration?: number }) {
  const [display, setDisplay] = useState(0)
  const ref = useRef<number | null>(null)
  useEffect(() => {
    const start = display; const diff = value - start; const startTime = performance.now()
    function animate(time: number) {
      const elapsed = time - startTime; const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(start + diff * eased)
      if (progress < 1) ref.current = requestAnimationFrame(animate)
    }
    ref.current = requestAnimationFrame(animate)
    return () => { if (ref.current) cancelAnimationFrame(ref.current) }
  }, [value])
  return <span>{Math.round(display).toLocaleString()}</span>
}

function SeverityBar({ counts, total }: { counts: Record<string, number>; total: number }) {
  if (!total) return null
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', width: '100%' }}>
      {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE'].map((s) =>
        counts[s] ? <div key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: SEVERITY_COLORS[s], transition: 'width 0.6s ease' }} /> : null
      )}
    </div>
  )
}

function TimelineChart({ cves }: { cves: CVEWithDebt[] }) {
  if (!cves.length) return null
  const yearMap: Record<string, { total: number; debt: number; CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number; NONE: number }> = {}
  cves.forEach((c) => {
    const y = String(new Date(c.published).getFullYear())
    if (!yearMap[y]) yearMap[y] = { total: 0, debt: 0, CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
    yearMap[y].total++; yearMap[y].debt += c.trustDebt
    yearMap[y][c.severity as keyof typeof yearMap[string]]++
  })
  const years = Object.keys(yearMap).sort()
  const maxCount = Math.max(...years.map((y) => yearMap[y].total), 1)
  const scaleMax = Math.ceil(maxCount / 10) * 10
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']
  const chartHeight = 180
  return (
    <div style={{ marginTop: 24 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', height: chartHeight, paddingBottom: 20, flexShrink: 0 }}>
          {[scaleMax, Math.round(scaleMax / 2), 0].map((v) => (
            <span key={v} style={{ fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>{v}</span>
          ))}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', height: chartHeight - 20, gap: 4, borderLeft: '1px solid rgba(148,163,184,0.15)', borderBottom: '1px solid rgba(148,163,184,0.15)', padding: '0 4px' }}>
            {years.map((y) => {
              const pct = (yearMap[y].total / scaleMax) * 100
              return (
                <div key={y} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, maxWidth: 60, height: '100%', justifyContent: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${Math.max(pct, 1)}%`, borderRadius: '4px 4px 0 0', overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse', transition: 'height 0.6s ease' }}>
                    {order.map((s) => yearMap[y][s as keyof typeof yearMap[string]] ? (
                      <div key={s} style={{ width: '100%', flex: yearMap[y][s as keyof typeof yearMap[string]] as number, background: SEVERITY_COLORS[s], minHeight: 2 }} />
                    ) : null)}
                  </div>
                </div>
              )
            })}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4, padding: '4px 4px 0' }}>
            {years.map((y) => (
              <div key={y} style={{ flex: 1, maxWidth: 60, textAlign: 'center' }}>
                <span style={{ fontSize: 10, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{y}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function CVERow({ cve, index }: { cve: CVEWithDebt; index: number }) {
  const [expanded, setExpanded] = useState(false)
  const reportedYear = cve.published ? new Date(cve.published).getFullYear() : null
  const cveIdYear = parseInt(cve.id.split('-')[1], 10)
  const isLateDisclosure = reportedYear !== null && !isNaN(cveIdYear) && (reportedYear - cveIdYear) >= 1
  const reportedDate = cve.published ? new Date(cve.published).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null
  return (
    <div style={{ borderBottom: '1px solid rgba(148,163,184,0.1)', padding: '12px 0', cursor: 'pointer', animation: `fadeSlideIn 0.3s ease ${index * 0.03}s both` }} onClick={() => setExpanded(!expanded)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_COLORS[cve.severity], flexShrink: 0, boxShadow: `0 0 6px ${SEVERITY_COLORS[cve.severity]}60` }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>{cve.id}</span>
              {isLateDisclosure && <span title={`CVE assigned in ${cveIdYear}, reported to NVD in ${reportedYear}`} style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', padding: '2px 5px', borderRadius: 4, border: '1px solid rgba(167,139,250,0.3)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5, cursor: 'default' }}>LATE</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              {cve.kev && <span style={{ fontSize: 10, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.12)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,23,68,0.35)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>KEV</span>}
              {(cve.epss ?? 0) > 0.01 && (() => {
                const e = cve.epss ?? 0; const p = cve.epssPercentile ?? 0
                const color = e >= 0.5 ? '#ff6d00' : e >= 0.1 ? '#ffc400' : '#64748b'
                const bg = e >= 0.5 ? 'rgba(255,109,0,0.1)' : e >= 0.1 ? 'rgba(255,196,0,0.1)' : 'rgba(100,116,139,0.1)'
                const border = e >= 0.5 ? 'rgba(255,109,0,0.35)' : e >= 0.1 ? 'rgba(255,196,0,0.35)' : 'rgba(100,116,139,0.2)'
                return <span title={`EPSS: ${(e*100).toFixed(2)}% · p${(p*100).toFixed(0)}`} style={{ fontSize: 10, fontWeight: 700, color, background: bg, padding: '2px 6px', borderRadius: 4, border: `1px solid ${border}`, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>EPSS {(e * 100).toFixed(1)}%</span>
              })()}
              <span style={{ fontSize: 11, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{cve.daysOpen}d open</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: SEVERITY_COLORS[cve.severity], fontFamily: "'JetBrains Mono', monospace" }}>CVSS {cve.score}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#f8fafc', background: 'rgba(99,102,241,0.2)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace" }}>TD {Math.round(cve.trustDebt)}</span>
            </div>
          </div>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 20, fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          {reportedDate && <div style={{ marginBottom: 6 }}><span style={{ color: '#475569' }}>Reported:</span> <span style={{ color: '#cbd5e1', fontFamily: "'JetBrains Mono', monospace" }}>{reportedDate}</span>{isLateDisclosure && <span style={{ color: '#a78bfa', marginLeft: 12 }}>Late disclosure</span>}</div>}
          {cve.description.slice(0, 300)}{cve.description.length > 300 ? '...' : ''}
        </div>
      )}
    </div>
  )
}

function GradeBadge({ grade, size = 48 }: { grade: string; size?: number }) {
  const color = GRADE_COLOR[grade] || '#78909c'
  return (
    <div style={{ width: size, height: size, borderRadius: 12, background: `${color}18`, border: `2px solid ${color}`, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      {grade === 'F'
        ? <img src="/images/fake-bobby-logo.png" alt="F" style={{ width: '85%', height: '85%', objectFit: 'contain', filter: 'drop-shadow(0 0 4px #ff174480)' }} />
        : <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: size * 0.45, fontWeight: 800, color }}>{grade}</span>
      }
    </div>
  )
}

function HistoryCard({ entry, index, onClick }: { entry: HistoryEntry; index: number; onClick: () => void }) {
  const gc = GRADE_COLOR[entry.grade] || '#78909c'
  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts; const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'; if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60); if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }
  return (
    <button onClick={onClick} className="history-card" style={{ background: 'rgba(15,23,42,0.8)', border: `1px solid ${gc}25`, borderRadius: 12, padding: 16, cursor: 'pointer', textAlign: 'left', width: '100%', transition: 'all 0.2s', animation: `fadeSlideIn 0.3s ease ${index * 0.05}s both`, display: 'flex', alignItems: 'center', gap: 14, fontFamily: "'Space Grotesk', sans-serif" }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: `${gc}15`, border: `2px solid ${gc}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: gc }}>{entry.grade}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e2e8f0', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.company}</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace" }}>TD {entry.totalDebt.toLocaleString()}</span>
          <span style={{ fontSize: 11, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{entry.cveCount} CVEs</span>
          <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{entry.years}y range</span>
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{timeAgo(entry.timestamp)}</div>
    </button>
  )
}

function PeerChart({ currentTrajectory, currentName, leaderboard }: { currentTrajectory: number; currentName: string; leaderboard: LeaderboardEntry[] }) {
  if (leaderboard.length < 2) return null
  const slug = toSlug(currentName)
  const peers = leaderboard.filter(c => c.slug !== slug && c.trajectory != null && isFinite(c.trajectory))
  const allScores = [...peers.map(c => c.trajectory), currentTrajectory]
  const logMin = Math.log10(Math.max(1, Math.min(...allScores)))
  const logMax = Math.log10(Math.max(...allScores))
  const toX = (v: number) => logMax <= logMin ? 50 : ((Math.log10(Math.max(1, v)) - logMin) / (logMax - logMin)) * 96 + 2
  const rank = leaderboard.filter(c => c.trajectory < currentTrajectory).length + 1
  const total = leaderboard.length
  return (
    <div style={{ background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: '16px 20px', marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: "'JetBrains Mono', monospace" }}>Peer Comparison</span>
        <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace" }}><span style={{ color: '#818cf8', fontWeight: 700 }}>#{rank}</span><span style={{ color: '#475569' }}> of {total} tracked</span></span>
      </div>
      <div style={{ position: 'relative', height: 56, marginBottom: 4 }}>
        <div style={{ position: 'absolute', top: 20, left: '2%', right: '2%', height: 3, borderRadius: 2, background: 'rgba(148,163,184,0.1)' }} />
        {peers.map(c => (
          <div key={c.slug} title={`${c.name}: ${c.trajectory.toLocaleString()}`} style={{ position: 'absolute', top: 12, left: `${toX(c.trajectory)}%`, width: 13, height: 13, borderRadius: '50%', background: GRADE_COLOR[c.grade] ?? '#64748b', transform: 'translateX(-50%)', opacity: 0.65, boxShadow: `0 0 6px ${GRADE_COLOR[c.grade] ?? '#64748b'}50` }} />
        ))}
        <div style={{ position: 'absolute', top: 7, left: `${toX(currentTrajectory)}%`, width: 22, height: 22, borderRadius: '50%', background: '#818cf8', border: '2px solid #6366f1', transform: 'translateX(-50%)', zIndex: 2, boxShadow: '0 0 12px #6366f160' }} title={`${currentName}: ${currentTrajectory.toLocaleString()}`} />
        <div style={{ position: 'absolute', top: 36, left: `clamp(10%, ${toX(currentTrajectory)}%, 90%)`, transform: 'translateX(-50%)', fontSize: 10, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>{currentName}</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, paddingTop: 8, borderTop: '1px solid rgba(148,163,184,0.06)' }}>
        <span style={{ fontSize: 9, color: '#00c853', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1 }}>← better</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {(['A', 'B', 'C', 'D', 'F'] as const).map(g => (
            <span key={g} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: GRADE_COLOR[g], display: 'inline-block', opacity: 0.8 }} />{g}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 9, color: '#ff1744', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1 }}>worse →</span>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function TrustDebtNew() {
  const [query, setQuery] = useState('')
  const [cves, setCves] = useState<CVEWithDebt[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [yearsBack, setYearsBack] = useState(5)
  const [searched, setSearched] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [sortBy, setSortBy] = useState('trustDebt')
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [dataSource, setDataSource] = useState<'cached' | 'live' | null>(null)
  const [syncing, setSyncing] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [fakeCharacter, setFakeCharacter] = useState<{ img: string; name: string; caption: string } | null>(null)
  const [searchHistory, setSearchHistory] = useState<HistoryEntry[]>([])
  const [viewMode, setViewMode] = useState('trajectory')
  const [currentSlug, setCurrentSlug] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [dbCounts, setDbCounts] = useState<{ cveCount: number; kevCount: number; epssCount: number; totalCompanies: number } | null>(null)
  const [sbdpSlugs, setSbdpSlugs] = useState<string[]>([])
  const [currentBreachCount, setCurrentBreachCount] = useState(0)
  const [currentBFactor, setCurrentBFactor] = useState(1.0)
  const [listView, setListView] = useState(false)

  useEffect(() => {
    try { const s = localStorage.getItem('trust-debt-history'); if (s) setSearchHistory(JSON.parse(s)) } catch { /* ok */ }
  }, [])
  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])
  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/nvd/count`).then(r => r.json()).then(d => { if (d.cveCount != null) setDbCounts(d) }).catch(() => {})
    fetch(`${TRUST_DEBT_API}/api/cisa/sbdp`).then(r => r.json()).then(d => { if (Array.isArray(d.slugs)) setSbdpSlugs(d.slugs) }).catch(() => {})
  }, [])
  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/leaderboard`).then(r => r.json()).then(data => { if (Array.isArray(data)) setLeaderboard(data) }).catch(() => {})
  }, [])

  const saveToHistory = useCallback((company: string, years: number, cveList: CVEWithDebt[], debt: number, grade: string) => {
    const entry: HistoryEntry = { company, years, cveCount: cveList.length, totalDebt: Math.round(debt), grade, timestamp: Date.now(), severityCounts: { CRITICAL: cveList.filter(c => c.severity === 'CRITICAL').length, HIGH: cveList.filter(c => c.severity === 'HIGH').length, MEDIUM: cveList.filter(c => c.severity === 'MEDIUM').length, LOW: cveList.filter(c => c.severity === 'LOW').length } }
    const updated = [entry, ...searchHistory.filter(h => h.company.toLowerCase() !== company.toLowerCase())].slice(0, 10)
    setSearchHistory(updated)
    try { localStorage.setItem('trust-debt-history', JSON.stringify(updated)) } catch { /* ok */ }
  }, [searchHistory])

  const fetchCVEs = useCallback(async (searchQuery: string, years: number) => {
    if (!searchQuery.trim()) return
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; setSyncing(false) }
    setLoading(true); setError(''); setCves([]); setFakeCharacter(null)
    setSearched(true); setCompanyName(searchQuery.trim())
    const now = new Date(); const startYear = now.getFullYear() - years
    try {
      const slug = toSlug(searchQuery.trim()); setCurrentSlug(slug)
      const cachedRes = await fetch(`${TRUST_DEBT_API}/api/company/${slug}`)
      let rawCves: CVE[] = []
      async function useLive() {
        const response = await fetch(`${CVE_SEARCH_API}/api/cve/search?keyword=${encodeURIComponent(searchQuery.trim())}&startYear=${startYear}&endYear=${now.getFullYear()}`)
        if (!response.ok) { const errBody = await response.json().catch(() => ({})); throw new Error((errBody as { error?: string }).error || `Request failed with status ${response.status}`) }
        setDataSource('live')
        return await response.json() as CVE[]
      }
      if (cachedRes.ok) {
        const cached = await cachedRes.json()
        const cachedCves = (cached.cves || []) as CVE[]
        setCurrentBreachCount(cached.company?.breachCount ?? 0)
        setCurrentBFactor(cached.company?.bFactor ?? 1.0)
        if (cachedCves.length > 0) { rawCves = cachedCves; setDataSource('cached') } else { rawCves = await useLive() }
      } else {
        setCurrentBreachCount(0); setCurrentBFactor(1.0); rawCves = await useLive()
      }
      if (!Array.isArray(rawCves) || rawCves.length === 0) {
        const fakes = [
          { img: '/images/fake-bobby.png', name: 'Fake Bobby', caption: `"${searchQuery.trim()}"? Never heard of 'em.` },
          { img: '/images/fake-david.png', name: 'Fake David', caption: `No vulnerabilities found. Either they're perfect... or they're not real.` },
          { img: '/images/fake-tommy.png', name: 'Fake Tommy', caption: `Our records show nothing. That's either impressive or suspicious.` },
        ]
        setFakeCharacter(fakes[Math.floor(Math.random() * fakes.length)]); setLoading(false); return
      }
      const parsed: CVE[] = filterByVendorMatch(
        rawCves.filter((c) => c.id && c.severity).map((c) => ({
          id: c.id, published: c.published || `${startYear}-06-01`,
          severity: (c.severity || 'NONE').toUpperCase(),
          score: typeof c.score === 'number' ? c.score : 0,
          description: c.description || 'No description available',
          kev: c.kev === true,
          epss: typeof c.epss === 'number' ? c.epss : undefined,
          epssPercentile: typeof c.epssPercentile === 'number' ? c.epssPercentile : undefined,
        })), searchQuery.trim()
      )
      const withDebt = calculateTrustDebt(parsed); setCves(withDebt)
      if (parsed.length >= 10 && !cachedRes.ok) {
        setSyncing(true)
        fetch(`${TRUST_DEBT_API}/api/companies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: searchQuery.trim(), keywords: [searchQuery.trim()], yearsBack: years }) })
          .then(() => fetch(`${TRUST_DEBT_API}/api/sync/${slug}`, { method: 'POST' })).catch(() => {})
        const slugCapture = slug; const queryCapture = searchQuery.trim()
        let attempts = 0
        pollRef.current = setInterval(async () => {
          attempts++
          if (attempts > 36) { clearInterval(pollRef.current!); pollRef.current = null; setSyncing(false); return }
          try {
            const res = await fetch(`${TRUST_DEBT_API}/api/company/${slugCapture}`)
            if (!res.ok) return
            const data = await res.json()
            const cveList = (data.cves || []) as CVE[]
            if (cveList.length === 0) return
            clearInterval(pollRef.current!); pollRef.current = null; setSyncing(false)
            const freshParsed = filterByVendorMatch(
              cveList.filter(c => c.id && c.severity).map(c => ({
                id: c.id, published: c.published || `${startYear}-06-01`,
                severity: (c.severity || 'NONE').toUpperCase(),
                score: typeof c.score === 'number' ? c.score : 0,
                description: c.description || 'No description available',
                kev: c.kev === true,
                epss: typeof c.epss === 'number' ? c.epss : undefined,
                epssPercentile: typeof c.epssPercentile === 'number' ? c.epssPercentile : undefined,
              })), queryCapture
            )
            const freshWithDebt = calculateTrustDebt(freshParsed)
            setCves(freshWithDebt); setDataSource('cached')
            setCurrentBreachCount(data.company?.breachCount ?? 0)
            setCurrentBFactor(data.company?.bFactor ?? 1.0)
            const ft = freshWithDebt.length > 0 ? calculateTrajectory(freshWithDebt) : null
            const fTraj = ft ? ft.trajectory : 0
            saveToHistory(queryCapture, years, freshWithDebt, fTraj, getGrade(fTraj, freshWithDebt.length))
          } catch { /* keep polling */ }
        }, 5000)
      }
      const t = withDebt.length > 0 ? calculateTrajectory(withDebt) : null
      const trajScore = t ? t.trajectory : 0
      const g = getGrade(trajScore, withDebt.length)
      saveToHistory(searchQuery.trim(), years, withDebt, trajScore, g)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally { setLoading(false) }
  }, [saveToHistory])

  const handleSubmit = (e?: React.FormEvent) => { e?.preventDefault?.(); fetchCVEs(query, yearsBack) }
  const isSBDP = (slug: string) => sbdpSlugs.some(s => s === slug || s.startsWith(slug + '-') || slug.startsWith(s + '-'))

  const severityCounts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
  cves.forEach((c) => severityCounts[c.severity]++)
  const totalDebt = cves.reduce((s, c) => s + c.trustDebt, 0)
  const traj = cves.length > 0 ? calculateTrajectory(cves) : null
  const trajectoryScore = traj ? traj.trajectory : 0
  const grade = getGrade(trajectoryScore, cves.length)
  const sorted = [...cves].sort((a, b) => sortBy === 'trustDebt' ? b.trustDebt - a.trustDebt : sortBy === 'score' ? b.score - a.score : b.daysOpen - a.daysOpen)

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        @keyframes spin { to { transform: rotate(360deg); } }
        .td-input:focus { outline: none; border-color: #6366f1 !important; box-shadow: 0 0 0 3px rgba(99,102,241,0.15); }
        .td-btn:hover { background: #4f46e5 !important; transform: translateY(-1px); }
        .td-btn:active { transform: translateY(0); }
        .preset-btn:hover { background: rgba(99,102,241,0.15) !important; border-color: #6366f1 !important; }
        .sort-btn:hover { background: rgba(99,102,241,0.12) !important; }
        .history-card:hover { border-color: rgba(99,102,241,0.3) !important; background: rgba(15,23,42,1) !important; transform: translateY(-1px); box-shadow: 0 4px 20px rgba(0,0,0,0.3); }
        .clear-btn:hover { background: rgba(255,23,68,0.12) !important; color: #ff5252 !important; }
        .view-tab { transition: all 0.2s; cursor: pointer; border: none; font-family: 'JetBrains Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .view-tab:hover { background: rgba(99,102,241,0.12) !important; }
        * { box-sizing: border-box; }
        @media (max-width: 600px) {
          .td-search-row { flex-wrap: wrap !important; }
          .td-search-row .td-input { min-width: 100% !important; order: -1; }
          .td-search-row select { flex: 1 !important; }
          .td-search-row .td-btn { flex: 1 !important; }
          .rw-cols { flex-direction: column !important; }
          .rw-divider { flex-direction: row !important; align-items: center !important; justify-content: center !important; gap: 12px !important; padding: 4px 0 !important; }
          .view-tab { font-size: 9.5px !important; padding: 8px 4px !important; }
        }
      `}</style>

      <div style={{ minHeight: '100vh', background: '#0b0f1a', color: '#e2e8f0', fontFamily: "'Space Grotesk', sans-serif", position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', opacity: 0.03, backgroundImage: `linear-gradient(rgba(99,102,241,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.5) 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />

        <header className="site-header">
          <a href="/" className="site-logo" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src="/images/fake-bobby-logo.png" alt="Fake Bobby" style={{ width: 22, height: 22, objectFit: 'contain', filter: 'drop-shadow(0 0 4px #ff174460)' }} />
            Fake Healthcare Experts
          </a>
          <nav>
            <ul className="nav-links">
              <li><a href="/trust/" style={{ color: '#475569' }}>Calculator</a></li>
              <li><a href="/trust/new/" style={{ color: '#818cf8', fontWeight: 700 }}>◆ New</a></li>
              <li><a href="/trust/vs/">⚔ Compare</a></li>
            </ul>
          </nav>
          <button className="hamburger" onClick={() => setMenuOpen(v => !v)} aria-label="Toggle menu"><span /><span /><span /></button>
        </header>
        <div className={`mobile-menu${menuOpen ? ' open' : ''}`}>
          <ul>
            <li><a href="/" onClick={() => setMenuOpen(false)}>← Home</a></li>
            <li><a href="/trust/" onClick={() => setMenuOpen(false)}>Calculator</a></li>
            <li><a href="/trust/new/" onClick={() => setMenuOpen(false)} style={{ color: '#818cf8' }}>◆ New</a></li>
            <li><a href="/trust/vs/" onClick={() => setMenuOpen(false)}>⚔ Compare</a></li>
          </ul>
        </div>

        <div style={{ maxWidth: 900, margin: '0 auto', padding: '88px 20px 40px', position: 'relative' }}>
          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: 48 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 8, padding: '6px 16px', marginBottom: 20, fontSize: 12, fontWeight: 600, letterSpacing: 2, textTransform: 'uppercase', color: '#818cf8', fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366f1', animation: 'pulse 2s infinite' }} />
              LIVE CVE DATA
            </div>
            <h1 style={{ fontSize: 52, fontWeight: 800, lineHeight: 1.05, margin: 0, background: 'linear-gradient(135deg, #e2e8f0, #6366f1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: -2 }}>
              Trust Debt
            </h1>
            <p style={{ color: '#64748b', fontSize: 16, marginTop: 12, maxWidth: 620, margin: '12px auto 0', lineHeight: 1.6 }}>
              Every company accrues tech debt. Every company also accrues Trust Debt™ — but rarely is it taken into account when choosing a CSP or SaaS provider.
            </p>
          </div>

          {/* Search */}
          <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.1)', borderRadius: 16, padding: 24, marginBottom: 24, backdropFilter: 'blur(12px)' }}>
            <form onSubmit={handleSubmit}>
              <div className="td-search-row" style={{ display: 'flex', gap: 8 }}>
                <input className="td-input" type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Enter company name (e.g. Microsoft, Cisco, Adobe)..." style={{ flex: 1, height: 48, borderRadius: 10, border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(15,23,42,0.6)', color: '#e2e8f0', fontSize: 15, padding: '0 16px', fontFamily: "'Space Grotesk', sans-serif", transition: 'all 0.2s' }} />
                <select value={yearsBack} onChange={(e) => setYearsBack(Number(e.target.value))} style={{ height: 48, borderRadius: 10, border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(15,23,42,0.6)', color: '#94a3b8', fontSize: 13, padding: '0 12px', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
                  <option value={1}>1 year</option>
                  <option value={3}>3 years</option>
                  <option value={5}>5 years</option>
                  <option value={10}>10 years</option>
                </select>
                <button type="submit" className="td-btn" disabled={loading} style={{ height: 48, padding: '0 24px', borderRadius: 10, border: 'none', background: '#6366f1', color: '#fff', fontWeight: 700, fontSize: 14, cursor: loading ? 'wait' : 'pointer', transition: 'all 0.2s', fontFamily: "'Space Grotesk', sans-serif", whiteSpace: 'nowrap' }}>
                  {loading ? 'Scanning...' : 'Calculate'}
                </button>
              </div>
            </form>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
              {PRESETS.map(p => (
                <button key={p} className="preset-btn" onClick={() => { setQuery(p); fetchCVEs(p, yearsBack) }} style={{ height: 28, padding: '0 12px', borderRadius: 8, border: '1px solid rgba(148,163,184,0.12)', background: 'rgba(15,23,42,0.4)', color: '#94a3b8', fontSize: 11, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.15s' }}>
                  {p}
                </button>
              ))}
            </div>
            {dbCounts !== null && (
              <p style={{ margin: '12px 0 0', fontSize: 11, color: '#334155', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, textAlign: 'right', display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '0 10px' }}>
                <span style={{ whiteSpace: 'nowrap' }}>NIST NVD · {dbCounts.cveCount.toLocaleString()} CVES</span>
                <span style={{ whiteSpace: 'nowrap' }}>CISA · {dbCounts.kevCount.toLocaleString()} KEV</span>
                <span style={{ whiteSpace: 'nowrap' }}>FIRST · {dbCounts.epssCount.toLocaleString()} EPSS</span>
              </p>
            )}
          </div>

          {/* Loading */}
          {loading && (
            <div style={{ textAlign: 'center', padding: 60 }}>
              <div style={{ width: 48, height: 48, border: '3px solid rgba(99,102,241,0.2)', borderTopColor: '#6366f1', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
              <p style={{ color: '#64748b', fontSize: 14 }}>{dataSource === 'cached' ? `Loading cached data for ${companyName}...` : `Searching NVD for ${companyName} vulnerabilities...`}</p>
            </div>
          )}

          {/* No Results */}
          {fakeCharacter && !loading && (
            <div style={{ textAlign: 'center', padding: '40px 20px', animation: 'fadeSlideIn 0.4s ease' }}>
              <img src={fakeCharacter.img} alt={fakeCharacter.name} style={{ width: 180, height: 180, objectFit: 'contain', marginBottom: 20, filter: 'drop-shadow(0 8px 24px rgba(99,102,241,0.25))' }} />
              <p style={{ color: '#94a3b8', fontSize: 15, margin: '0 0 6px', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>{fakeCharacter.caption}</p>
              <p style={{ color: '#475569', fontSize: 12, margin: '0 0 24px', fontFamily: "'JetBrains Mono', monospace" }}>No CVEs found in NVD for &quot;{companyName}&quot;</p>
              <button onClick={() => { setFakeCharacter(null); setSearched(false) }} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.1)', color: '#818cf8', fontSize: 13, cursor: 'pointer', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>Try another company</button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.2)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
              <p style={{ color: '#ff5252', fontSize: 14, margin: 0, fontWeight: 600 }}>Search failed</p>
              <p style={{ color: '#94a3b8', fontSize: 12, margin: '8px 0 0', lineHeight: 1.6, wordBreak: 'break-word', fontFamily: "'JetBrains Mono', monospace" }}>{error}</p>
              <button onClick={() => { setError(''); fetchCVEs(companyName || query, yearsBack) }} style={{ marginTop: 12, padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.1)', color: '#818cf8', fontSize: 13, cursor: 'pointer', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>Retry search</button>
            </div>
          )}

          {/* Results */}
          {searched && !loading && !error && (
            <div style={{ animation: 'fadeSlideIn 0.4s ease' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
                {searchHistory.length > 0 && (
                  <button onClick={() => { setSearched(false); setCves([]); setError('') }} className="sort-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', color: '#64748b', fontSize: 12, cursor: 'pointer', padding: '4px 0', fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.15s' }}>
                    ← Recent searches
                  </button>
                )}
                <a href={`/trust/vs/${currentSlug ? `?a=${currentSlug}` : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', padding: '3px 10px', borderRadius: 6 }}>⚔ Compare</a>
                {syncing && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '2px 8px', borderRadius: 4, background: 'rgba(251,191,36,0.1)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.25)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: '#fbbf24', animation: 'pulse 1.2s ease-in-out infinite' }} />
                    syncing full history…
                  </span>
                )}
                {!syncing && dataSource && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '2px 8px', borderRadius: 4, background: dataSource === 'cached' ? 'rgba(0,200,83,0.1)' : 'rgba(99,102,241,0.1)', color: dataSource === 'cached' ? '#00c853' : '#818cf8', border: `1px solid ${dataSource === 'cached' ? '#00c85330' : '#6366f130'}` }}>
                    {dataSource === 'cached' ? '⚡ cached' : '🔍 live query'}
                  </span>
                )}
              </div>
              {dataSource === 'cached' && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 8, background: 'rgba(0,200,83,0.05)', border: '1px solid rgba(0,200,83,0.12)', marginBottom: 16, fontSize: 12, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6 }}>
                  <span style={{ color: '#00c853', flexShrink: 0, marginTop: 1 }}>ⓘ</span>
                  <span><span style={{ color: '#94a3b8' }}>Showing pre-cached data (last 12 months, updated nightly).</span> The year range selector only applies to live queries.</span>
                </div>
              )}
              <div className="view-tabs-bar" style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 10, padding: 4, border: '1px solid rgba(148,163,184,0.08)' }}>
                {[{ key: 'trajectory', label: 'Trajectory', icon: '◆' }, { key: 'window', label: 'Window', icon: '↔' }, { key: 'recurrence', label: 'Recurrence', icon: '⟳' }, { key: 'velocity', label: 'Velocity', icon: '⚡' }].map((tab) => (
                  <button key={tab.key} className="view-tab" onClick={() => setViewMode(tab.key)} style={{ flex: 1, padding: '10px 8px', borderRadius: 8, background: viewMode === tab.key ? 'rgba(99,102,241,0.15)' : 'transparent', color: viewMode === tab.key ? '#818cf8' : '#64748b', fontSize: 11, fontWeight: viewMode === tab.key ? 700 : 500, letterSpacing: 0.3, borderBottom: viewMode === tab.key ? '2px solid #6366f1' : '2px solid transparent' }}>
                    {tab.icon} {tab.label}
                  </button>
                ))}
              </div>

              {/* Trajectory View */}
              {viewMode === 'trajectory' && (
                <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16, textAlign: 'center', backdropFilter: 'blur(8px)' }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>Trust Trajectory Score</div>
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 20 }}>
                      <GradeBadge grade={grade} size={56} />
                      <div style={{ fontSize: 52, fontWeight: 800, color: '#e2e8f0' }}><AnimatedNumber value={Math.round(trajectoryScore)} /></div>
                    </div>
                    <div style={{ fontSize: 12, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", marginTop: 12 }}>TT = TD × Δ × R × K × P × B</div>
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
                      <span style={{ fontSize: 12, color: '#475569' }}>{cves.length} CVEs analyzed</span>
                      {traj && traj.kevCount > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.1)', padding: '2px 10px', borderRadius: 20, border: '1px solid rgba(255,23,68,0.3)', fontFamily: "'JetBrains Mono', monospace" }}>{traj.kevCount} KEV {traj.kevCount === 1 ? 'hit' : 'hits'}</span>}
                      {isSBDP(currentSlug) && <span style={{ fontSize: 10, fontWeight: 700, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>CISA SBDP ✓</span>}
                      {currentBreachCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.25)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>HIBP{currentBreachCount > 1 ? ` ×${currentBreachCount}` : ''}</span>}
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, marginBottom: 24, overflow: 'hidden' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '36px 1fr 1fr auto 52px', alignItems: 'center', padding: '8px 16px', borderBottom: '1px solid rgba(148,163,184,0.1)' }}>
                      {['SYM', 'FACTOR', 'SOURCE', 'WEIGHT', ''].map((h, i) => (
                        <span key={i} style={{ fontSize: 9, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: "'JetBrains Mono', monospace", textAlign: i === 3 ? 'right' : 'left' }}>{h}</span>
                      ))}
                    </div>
                    {traj ? [
                      { sym: 'TD', name: 'Base Debt', source: 'NVD CVEs', weight: Math.round(traj.tdCurrent).toLocaleString(), color: '#e2e8f0', status: null, onClick: () => setViewMode('window') },
                      { sym: 'Δ', name: 'Trend', source: '12-month window', weight: `${traj.delta.toFixed(2)}×`, color: traj.delta > 1.05 ? '#ff6d00' : traj.delta < 0.95 ? '#00c853' : '#e2e8f0', status: null, onClick: () => setViewMode('window') },
                      { sym: 'R', name: 'Recurrence', source: `${traj.critHighCurrent} crit/high`, weight: `${traj.recurrence.toFixed(2)}×`, color: traj.recurrence > 1.5 ? '#ff6d00' : '#e2e8f0', status: null, onClick: () => setViewMode('recurrence') },
                      { sym: 'K', name: 'KEV Exploited', source: `${traj.kevCount} CISA KEV`, weight: `${traj.kFactor.toFixed(2)}×`, color: traj.kevCount > 0 ? '#ff1744' : '#e2e8f0', status: 'NEW', onClick: null },
                      { sym: 'P', name: 'EPSS × Percentile', source: `${traj.epssHighCount} high-risk (>10%)`, weight: `${traj.pFactor.toFixed(2)}×`, color: traj.pFactor > 1.5 ? '#ff6d00' : traj.pFactor > 1.1 ? '#ffc400' : '#e2e8f0', status: 'NEW', onClick: null },
                      { sym: 'B', name: 'Breach History', source: currentBreachCount > 0 ? `${currentBreachCount} HIBP breach${currentBreachCount > 1 ? 'es' : ''}` : 'no known breaches', weight: `${currentBFactor.toFixed(2)}×`, color: currentBFactor > 1.3 ? '#ff6d00' : currentBFactor > 1.05 ? '#ffc400' : '#e2e8f0', status: 'NEW', onClick: null },
                    ].map((row) => (
                      <div key={row.sym} onClick={row.onClick || undefined} style={{ display: 'grid', gridTemplateColumns: '36px 1fr 1fr auto 52px', alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid rgba(148,163,184,0.05)', cursor: row.onClick ? 'pointer' : 'default', transition: 'background 0.15s' }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 800, color: row.color }}>{row.sym}</span>
                        <span style={{ fontSize: 12, color: '#94a3b8' }}>{row.name}</span>
                        <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{row.source}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: row.color, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right', paddingRight: 16 }}>{row.weight}</span>
                        {row.status === 'NEW' ? <span style={{ fontSize: 9, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.12)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,23,68,0.3)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>NEW</span> : <span />}
                      </div>
                    )) : null}
                  </div>
                  {leaderboard.length >= 2 && traj && <PeerChart currentTrajectory={trajectoryScore} currentName={companyName} leaderboard={leaderboard} />}
                  <TimelineChart cves={cves} />
                </div>
              )}

              {/* Window View */}
              {viewMode === 'window' && traj && (
                <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 20, fontFamily: "'JetBrains Mono', monospace", textAlign: 'center' }}>12-Month Rolling Window Comparison</div>
                    <div className="rw-cols" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div style={{ flex: 1, textAlign: 'center', padding: 20, borderRadius: 12, background: 'rgba(148,163,184,0.04)' }}>
                        <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>Previous 12 months</div>
                        <div style={{ fontSize: 36, fontWeight: 800, color: '#94a3b8' }}>{Math.round(traj.tdPrevious).toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{traj.previousWindow.length} CVEs</div>
                        <div style={{ marginTop: 12 }}><SeverityBar counts={{ CRITICAL: traj.previousWindow.filter(c => c.severity === 'CRITICAL').length, HIGH: traj.previousWindow.filter(c => c.severity === 'HIGH').length, MEDIUM: traj.previousWindow.filter(c => c.severity === 'MEDIUM').length, LOW: traj.previousWindow.filter(c => c.severity === 'LOW').length, NONE: traj.previousWindow.filter(c => c.severity === 'NONE').length }} total={traj.previousWindow.length} /></div>
                      </div>
                      <div className="rw-divider" style={{ flexShrink: 0, textAlign: 'center' }}>
                        <TrendIndicator delta={traj.delta} />
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#818cf8', marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>Δ {traj.delta.toFixed(2)}</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center', padding: 20, borderRadius: 12, background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)' }}>
                        <div style={{ fontSize: 10, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>Current 12 months</div>
                        <div style={{ fontSize: 36, fontWeight: 800, color: '#e2e8f0' }}>{Math.round(traj.tdCurrent).toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{traj.currentWindow.length} CVEs</div>
                        <div style={{ marginTop: 12 }}><SeverityBar counts={{ CRITICAL: traj.currentWindow.filter(c => c.severity === 'CRITICAL').length, HIGH: traj.currentWindow.filter(c => c.severity === 'HIGH').length, MEDIUM: traj.currentWindow.filter(c => c.severity === 'MEDIUM').length, LOW: traj.currentWindow.filter(c => c.severity === 'LOW').length, NONE: traj.currentWindow.filter(c => c.severity === 'NONE').length }} total={traj.currentWindow.length} /></div>
                      </div>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>Quarterly Trust Debt</span>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>← older · newer →</span>
                    </div>
                    <QuarterlySparkline quarters={traj.quarters} />
                  </div>
                </div>
              )}

              {/* Recurrence View */}
              {viewMode === 'recurrence' && traj && (
                <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16, textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>Recurrence Multiplier</div>
                    <div style={{ fontSize: 64, fontWeight: 800, color: traj.recurrence >= 2.5 ? '#ff1744' : traj.recurrence >= 1.5 ? '#ff6d00' : traj.recurrence > 1.0 ? '#ffc400' : '#00c853' }}>{traj.recurrence.toFixed(2)}×</div>
                    <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 8 }}>{traj.recurrence >= 2.5 ? 'Systemic failure pattern detected' : traj.recurrence >= 1.5 ? 'Repeated high-severity vulnerabilities' : traj.recurrence > 1.0 ? 'Some recurring issues' : 'Minimal recurrence'}</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
                    {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((sev) => {
                      const count = traj.currentWindow.filter(c => c.severity === sev).length
                      const contributes = sev === 'CRITICAL' || sev === 'HIGH'
                      return (
                        <div key={sev} style={{ background: 'rgba(15,23,42,0.8)', border: `1px solid ${contributes ? SEVERITY_COLORS[sev] + '30' : 'rgba(148,163,184,0.08)'}`, borderRadius: 12, padding: 16, textAlign: 'center' }}>
                          <div style={{ width: 12, height: 12, borderRadius: '50%', background: SEVERITY_COLORS[sev], margin: '0 auto 8px', boxShadow: `0 0 8px ${SEVERITY_COLORS[sev]}40` }} />
                          <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', fontFamily: "'JetBrains Mono', monospace", marginBottom: 6 }}>{sev}</div>
                          <div style={{ fontSize: 28, fontWeight: 800, color: SEVERITY_COLORS[sev] }}>{count}</div>
                          <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{contributes ? `+${(count * 0.15).toFixed(2)} to R` : 'not in R'}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Velocity View */}
              {viewMode === 'velocity' && traj && (() => {
                const tv = calculateTrustVelocity(traj.quarters)
                return (
                  <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                    <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16, textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>Debt Velocity</div>
                      {tv ? (
                        <>
                          <div style={{ fontSize: 52, fontWeight: 800, color: tv.color }}>{tv.grade}</div>
                          <div style={{ fontSize: 15, color: tv.color, fontFamily: "'JetBrains Mono', monospace", marginTop: 8 }}>{tv.label}</div>
                          <div style={{ fontSize: 13, color: '#475569', marginTop: 8 }}>Avg QoQ: {tv.avg >= 0 ? '+' : ''}{(tv.avg * 100).toFixed(1)}%</div>
                        </>
                      ) : (
                        <div style={{ fontSize: 14, color: '#475569' }}>Insufficient quarterly data</div>
                      )}
                    </div>
                  </div>
                )
              })()}

              {/* CVE List */}
              <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginTop: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>{cves.length} CVEs</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {[{ k: 'trustDebt', l: 'Trust Debt' }, { k: 'score', l: 'CVSS' }, { k: 'daysOpen', l: 'Age' }].map(({ k, l }) => (
                      <button key={k} className="sort-btn" onClick={() => setSortBy(k)} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(148,163,184,0.12)', background: sortBy === k ? 'rgba(99,102,241,0.15)' : 'transparent', color: sortBy === k ? '#818cf8' : '#64748b', fontSize: 11, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.15s' }}>{l}</button>
                    ))}
                  </div>
                </div>
                {sorted.slice(0, 50).map((cve, i) => <CVERow key={cve.id} cve={cve} index={i} />)}
                {sorted.length > 50 && <div style={{ textAlign: 'center', padding: '16px 0 4px', fontSize: 12, color: '#475569', fontFamily: "'JetBrains Mono', monospace' " }}>+ {sorted.length - 50} more CVEs</div>}
              </div>
            </div>
          )}

          {/* Landing — History + Carousel ──────────────── */}
          {!searched && (
            <div style={{ animation: 'fadeSlideIn 0.4s ease' }}>
              {searchHistory.length > 0 && (
                <div style={{ marginBottom: 32 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: '#cbd5e1' }}>Recent Searches</span>
                      <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(99,102,241,0.08)', padding: '2px 8px', borderRadius: 4 }}>{searchHistory.length}</span>
                    </div>
                    <button className="clear-btn" onClick={() => { setSearchHistory([]); try { localStorage.removeItem('trust-debt-history') } catch { /* ok */ } }} style={{ fontSize: 11, color: '#64748b', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.15s' }}>Clear all</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {searchHistory.map((entry, i) => (
                      <HistoryCard key={entry.company + entry.timestamp} entry={entry} index={i} onClick={() => { setQuery(entry.company); setYearsBack(entry.years); fetchCVEs(entry.company, entry.years) }} />
                    ))}
                  </div>
                </div>
              )}

              {/* Tracked Companies — Carousel */}
              {leaderboard.length > 0 && (
                <div style={{ marginTop: searchHistory.length > 0 ? 0 : 0 }}>
                  {/* Quick insights */}
                  {(() => {
                    const s = [...leaderboard].sort((a, b) => a.trajectory - b.trajectory)
                    const best = s[0]; const worst = s[s.length - 1]
                    return (
                      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          {best && <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: '#00c853', background: 'rgba(0,200,83,0.07)', border: '1px solid rgba(0,200,83,0.15)', padding: '3px 8px', borderRadius: 6 }}>Most trusted: {best.name} ({best.grade})</span>}
                          {worst && <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: '#ff6d00', background: 'rgba(255,109,0,0.07)', border: '1px solid rgba(255,109,0,0.15)', padding: '3px 8px', borderRadius: 6 }}>Least trusted: {worst.name} ({worst.grade})</span>}
                        </div>
                        <button onClick={() => setListView(v => !v)} style={{ fontSize: 10, color: '#475569', background: 'rgba(15,23,42,0.6)', border: '1px solid rgba(148,163,184,0.12)', padding: '3px 10px', borderRadius: 6, cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace" }}>
                          {listView ? '⊟ Carousel' : '⊞ List view'}
                        </button>
                      </div>
                    )
                  })()}

                  {listView ? (
                    /* List fallback */
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                      {leaderboard.map((c) => {
                        const gc = GRADE_COLOR[c.grade] || '#78909c'
                        return (
                          <button key={c.slug} onClick={() => { setQuery(c.name); fetchCVEs(c.name, yearsBack) }} style={{ background: 'rgba(15,23,42,0.6)', border: `1px solid ${gc}30`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                              <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', lineHeight: 1.2 }}>{c.name}</span>
                              <span style={{ fontSize: 13, fontWeight: 800, color: gc, flexShrink: 0, marginLeft: 6 }}>{c.grade}</span>
                            </div>
                            <span style={{ fontSize: 10, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{c.cveCount} CVEs</span>
                          </button>
                        )
                      })}
                    </div>
                  ) : (
                    <CompanyDeck companies={leaderboard} sbdpSlugs={sbdpSlugs} onSelect={(name) => { setQuery(name); fetchCVEs(name, yearsBack) }} />
                  )}
                </div>
              )}

              {leaderboard.length === 0 && searchHistory.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#64748b', fontSize: 16, margin: 0 }}>Search a company to see their Trust Debt score</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ maxWidth: 900, margin: '40px auto 0', padding: '24px 20px 60px', borderTop: '1px solid rgba(148,163,184,0.08)' }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: '#334155', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16 }}>Data Sources &amp; Disclaimers</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
            {[
              { label: 'NIST NVD — CVEs', body: 'Vulnerability data sourced from the National Institute of Standards and Technology National Vulnerability Database.' },
              { label: 'CISA KEV', body: 'Known Exploited Vulnerabilities catalog maintained by CISA. KEV entries indicate confirmed active exploitation.' },
              { label: 'FIRST EPSS', body: 'Exploit Prediction Scoring System scores by FIRST. Estimates the probability a CVE will be exploited within 30 days.' },
              { label: 'CISA Secure by Design', body: 'The CISA SBDP ✓ badge indicates a software manufacturer has voluntarily signed the Secure by Design pledge.' },
              { label: 'Have I Been Pwned', body: 'Breach data from HIBP. B factor weighted by breach PwnCount with 12-month halflife decay.' },
            ].map(({ label, body }) => (
              <div key={label} style={{ padding: '14px 16px', borderRadius: 8, background: 'rgba(15,23,42,0.4)', border: '1px solid rgba(148,163,184,0.06)' }}>
                <p style={{ fontSize: 10, fontWeight: 700, color: '#475569', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, textTransform: 'uppercase', margin: '0 0 8px' }}>{label}</p>
                <p style={{ fontSize: 11, color: '#334155', lineHeight: 1.6, margin: 0 }}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
