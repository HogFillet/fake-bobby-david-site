'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

const SEVERITY_COLORS: Record<string, string> = {
  CRITICAL: '#ff1744',
  HIGH: '#ff6d00',
  MEDIUM: '#ffc400',
  LOW: '#00c853',
  NONE: '#78909c',
}

const SEVERITY_WEIGHTS: Record<string, number> = {
  CRITICAL: 10,
  HIGH: 7.5,
  MEDIUM: 5,
  LOW: 2.5,
  NONE: 0,
}

const SCOPE_FACTOR: Record<string, number> = {
  CRITICAL: 3.0,
  HIGH: 2.0,
  MEDIUM: 1.5,
  LOW: 1.0,
  NONE: 0.5,
}

interface CVE {
  id: string
  published: string
  severity: string
  score: number
  description: string
  kev?: boolean
  epss?: number
  epssPercentile?: number
  daysOpen?: number
  trustDebt?: number
}

interface CVEWithDebt extends CVE {
  daysOpen: number
  trustDebt: number
}

interface HistoryEntry {
  company: string
  years: number
  cveCount: number
  totalDebt: number
  grade: string
  timestamp: number
  severityCounts: Record<string, number>
}

interface Quarter {
  label: string
  debt: number
  count: number
  critHigh: number
}

interface Trajectory {
  tdCurrent: number
  tdPrevious: number
  delta: number
  recurrence: number
  kevCount: number
  kFactor: number
  epssHighCount: number
  pFactor: number
  trajectory: number
  currentWindow: CVEWithDebt[]
  previousWindow: CVEWithDebt[]
  critHighCurrent: number
  quarters: Quarter[]
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
    const td = vi * si * ti
    return { ...cve, daysOpen, trustDebt: td }
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
  if (tdPrevious > 0) {
    delta = Math.min(2.0, Math.max(0.5, tdCurrent / tdPrevious))
  } else if (tdCurrent > 0 && previousWindow.length > 0) {
    // Previous CVEs exist but all resolved — genuinely worsening
    delta = 2.0
  }
  // previousWindow.length === 0 means insufficient historical data — keep delta = 1.0 (neutral)

  const critHighCurrent = currentWindow.filter(
    (c) => c.severity === 'CRITICAL' || c.severity === 'HIGH'
  ).length
  const recurrence = 1 + critHighCurrent * 0.15
  const kevCount = currentWindow.filter((c) => c.kev).length
  const kFactor = 1 + 0.30 * kevCount
  const epssHighCount = currentWindow.filter((c) => (c.epss ?? 0) > 0.10).length
  const epssSum = currentWindow.reduce((s, c) => {
    const score = c.epss ?? 0
    const pct = c.epssPercentile ?? score  // fall back to score if percentile missing
    return s + (score > 0.10 ? score * pct : 0)
  }, 0)
  const pFactor = Math.min(3.0, 1 + epssSum)
  const trajectory = tdCurrent * delta * recurrence * kFactor * pFactor

  const quarters: Quarter[] = []
  for (let q = 7; q >= 0; q--) {
    const qStart = new Date(now.getTime() - (q + 1) * 91 * msPerDay)
    const qEnd = new Date(now.getTime() - q * 91 * msPerDay)
    const qCves = cves.filter((c) => {
      const pub = new Date(c.published)
      return pub >= qStart && pub < qEnd
    })
    const qDebt = qCves.reduce((s, c) => s + c.trustDebt, 0)
    const qCritHigh = qCves.filter((c) => c.severity === 'CRITICAL' || c.severity === 'HIGH').length
    const qYear = qStart.getFullYear()
    const qNum = Math.floor(qStart.getMonth() / 3) + 1
    quarters.push({ label: `${qYear} Q${qNum}`, debt: qDebt, count: qCves.length, critHigh: qCritHigh })
  }

  return { tdCurrent, tdPrevious, delta, recurrence, kevCount, kFactor, epssHighCount, pFactor, trajectory, currentWindow, previousWindow, critHighCurrent, quarters }
}

interface TrustVelocity {
  qoq: number[]       // quarter-over-quarter fractional change per quarter
  avg: number         // mean QoQ change
  grade: string
  label: string
  color: string
}

// Returns {change, isNew} for quarter i vs i-1.
// isNew=true means prev=0 and curr>0 — "new activity" after a quiet period.
// No lookback: comparing across empty quarters produces misleading percentages.
function qoqTransition(quarters: Quarter[], i: number): { change: number; isNew: boolean } {
  const prev = quarters[i - 1].debt
  const curr = quarters[i].debt
  if (prev > 0) return { change: (curr - prev) / prev, isNew: false }
  if (curr === 0) return { change: 0, isNew: false }  // both zero: stable
  return { change: 0, isNew: true }                   // zero → nonzero: new activity
}

const GRADE_ORDER = ['A', 'B', 'C', 'D', 'F'] as const
type Grade = typeof GRADE_ORDER[number]
function gradeRank(g: string): number { return GRADE_ORDER.indexOf(g as Grade) }

// Grade based purely on absolute debt — used for new-activity quarters and the grade cap.
function debtGrade(debt: number): { grade: string; color: string } {
  if (debt === 0)   return { grade: 'A', color: '#00c853' }
  if (debt < 100)   return { grade: 'C', color: '#ffc400' }  // small debt: max C
  if (debt < 400)   return { grade: 'D', color: '#ff6d00' }  // moderate debt: max D
  return                   { grade: 'F', color: '#ff1744' }  // significant debt: F allowed
}

// Cap a grade so it can't be worse than what the absolute debt justifies.
// Improvement grades (A/B) always pass through — only penalising grades are capped.
function capGrade(result: { grade: string; color: string }, debt: number): { grade: string; color: string } {
  const cap = debtGrade(debt)
  return gradeRank(result.grade) > gradeRank(cap.grade) ? cap : result
}

function calculateTrustVelocity(quarters: Quarter[]): TrustVelocity | null {
  if (quarters.length < 2 || !quarters.some(q => q.debt > 0)) return null
  const qoq = quarters.slice(1).map((_, i) => {
    const { change, isNew } = qoqTransition(quarters, i + 1)
    if (!isNew) return change
    // New activity: substitute a synthetic change based on absolute debt
    const debt = quarters[i + 1].debt
    return debt < 100 ? 0.05 : debt < 500 ? 0.20 : debt < 1500 ? 0.40 : 0.60
  })
  const avg = qoq.reduce((s, v) => s + v, 0) / qoq.length
  if (avg <= -0.15) return { qoq, avg, grade: 'A', label: 'Paying down debt', color: '#00c853' }
  if (avg < 0)      return { qoq, avg, grade: 'B', label: 'Slowly improving', color: '#64dd17' }
  if (avg < 0.10)   return { qoq, avg, grade: 'C', label: 'Stable', color: '#ffc400' }
  if (avg < 0.30)   return { qoq, avg, grade: 'D', label: 'Accumulating risk', color: '#ff6d00' }
  return               { qoq, avg, grade: 'F', label: 'Debt spiral', color: '#ff1744' }
}

function velGrade(qoq: number, currentDebt?: number): { grade: string; color: string } {
  // Stable band (±10%): grade on absolute debt level
  if (Math.abs(qoq) <= 0.10 && currentDebt !== undefined) return debtGrade(currentDebt)
  let result: { grade: string; color: string }
  if (qoq <= -0.15) result = { grade: 'A', color: '#00c853' }
  else if (qoq < 0) result = { grade: 'B', color: '#64dd17' }
  else if (qoq < 0.10) result = { grade: 'C', color: '#ffc400' }
  else if (qoq < 0.30) result = { grade: 'D', color: '#ff6d00' }
  else result = { grade: 'F', color: '#ff1744' }
  return currentDebt !== undefined ? capGrade(result, currentDebt) : result
}

function TrendIndicator({ delta }: { delta: number }) {
  const improving = delta < 0.95
  const worsening = delta > 1.05
  const color = improving ? '#00c853' : worsening ? '#ff1744' : '#ffc400'
  const arrow = improving ? '↓' : worsening ? '↑' : '→'
  const label = improving
    ? `${Math.round((1 - delta) * 100)}% improving`
    : worsening
    ? `${Math.round((delta - 1) * 100)}% worsening`
    : 'Stable'
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
          const pct = (q.debt / maxDebt) * 100
          const isRecent = i >= 6
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <span style={{ fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>
                {q.count > 0 ? q.count : ''}
              </span>
              <div style={{
                width: '100%', height: `${Math.max(pct, 3)}%`, borderRadius: '3px 3px 0 0',
                background: isRecent ? 'linear-gradient(to top, #6366f1, #818cf8)' : 'rgba(99,102,241,0.25)',
                transition: 'height 0.6s ease', minHeight: 2,
              }} />
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
    const start = display
    const diff = value - start
    const startTime = performance.now()
    function animate(time: number) {
      const elapsed = time - startTime
      const progress = Math.min(elapsed / duration, 1)
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
  const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NONE']
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', width: '100%' }}>
      {order.map((s) =>
        counts[s] ? (
          <div key={s} style={{ width: `${(counts[s] / total) * 100}%`, background: SEVERITY_COLORS[s], transition: 'width 0.6s ease' }} />
        ) : null
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
    yearMap[y].total++
    yearMap[y].debt += c.trustDebt
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
        {/* Y-axis scale */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', height: chartHeight, paddingBottom: 20, flexShrink: 0 }}>
          {[scaleMax, Math.round(scaleMax / 2), 0].map((v) => (
            <span key={v} style={{ fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1 }}>{v}</span>
          ))}
        </div>
        {/* Bars */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', height: chartHeight - 20, gap: 4, borderLeft: '1px solid rgba(148,163,184,0.15)', borderBottom: '1px solid rgba(148,163,184,0.15)', padding: '0 4px' }}>
            {years.map((y) => {
              const pct = (yearMap[y].total / scaleMax) * 100
              return (
                <div key={y} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, maxWidth: 60, height: '100%', justifyContent: 'flex-end' }}>
                  <div style={{ width: '100%', height: `${Math.max(pct, 1)}%`, borderRadius: '4px 4px 0 0', overflow: 'hidden', display: 'flex', flexDirection: 'column-reverse', transition: 'height 0.6s ease' }}>
                    {order.map((s) =>
                      yearMap[y][s as keyof typeof yearMap[string]] ? (
                        <div key={s} style={{ width: '100%', flex: yearMap[y][s as keyof typeof yearMap[string]] as number, background: SEVERITY_COLORS[s], minHeight: 2 }} />
                      ) : null
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {/* X-axis labels */}
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
    <div
      style={{ borderBottom: '1px solid rgba(148,163,184,0.1)', padding: '12px 0', cursor: 'pointer', animation: `fadeSlideIn 0.3s ease ${index * 0.03}s both` }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_COLORS[cve.severity], flexShrink: 0, boxShadow: `0 0 6px ${SEVERITY_COLORS[cve.severity]}60` }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>{cve.id}</span>
              {isLateDisclosure && (
                <span title={`CVE assigned in ${cveIdYear}, reported to NVD in ${reportedYear}`} style={{ fontSize: 9, fontWeight: 700, color: '#a78bfa', background: 'rgba(167,139,250,0.1)', padding: '2px 5px', borderRadius: 4, border: '1px solid rgba(167,139,250,0.3)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5, cursor: 'default' }}>LATE</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              {cve.kev && (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.12)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,23,68,0.35)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>KEV</span>
              )}
              {(cve.epss ?? 0) > 0.01 && (() => {
                const e = cve.epss ?? 0
                const p = cve.epssPercentile ?? 0
                const color = e >= 0.5 ? '#ff6d00' : e >= 0.1 ? '#ffc400' : '#64748b'
                const bg = e >= 0.5 ? 'rgba(255,109,0,0.1)' : e >= 0.1 ? 'rgba(255,196,0,0.1)' : 'rgba(100,116,139,0.1)'
                const border = e >= 0.5 ? 'rgba(255,109,0,0.35)' : e >= 0.1 ? 'rgba(255,196,0,0.35)' : 'rgba(100,116,139,0.2)'
                return (
                  <span title={`EPSS: ${(e*100).toFixed(2)}% probability · ${(p*100).toFixed(0)}th percentile`} style={{ fontSize: 10, fontWeight: 700, color, background: bg, padding: '2px 6px', borderRadius: 4, border: `1px solid ${border}`, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5, cursor: 'default' }}>
                    EPSS {(e * 100).toFixed(1)}%{p > 0 ? ` · p${(p * 100).toFixed(0)}` : ''}
                  </span>
                )
              })()}
              <span style={{ fontSize: 11, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{cve.daysOpen}d open</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: SEVERITY_COLORS[cve.severity], fontFamily: "'JetBrains Mono', monospace" }}>CVSS {cve.score}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#f8fafc', background: 'rgba(99,102,241,0.2)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace" }}>
                TD {Math.round(cve.trustDebt)}
              </span>
            </div>
          </div>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 20, fontSize: 12, color: '#94a3b8', lineHeight: 1.6 }}>
          {reportedDate && (
            <div style={{ marginBottom: 6, display: 'flex', gap: 16 }}>
              <span><span style={{ color: '#475569' }}>Reported:</span> <span style={{ color: '#cbd5e1', fontFamily: "'JetBrains Mono', monospace" }}>{reportedDate}</span></span>
              {isLateDisclosure && <span style={{ color: '#a78bfa' }}>Late disclosure — CVE assigned {cveIdYear}, published to NVD {reportedYear}</span>}
            </div>
          )}
          {cve.description.slice(0, 300)}{cve.description.length > 300 ? '...' : ''}
        </div>
      )}
    </div>
  )
}

function GradeBadge({ grade, size = 48 }: { grade: string; size?: number }) {
  const gradeColors: Record<string, string> = { 'A+': '#00c853', A: '#00c853', B: '#64dd17', C: '#ffc400', D: '#ff6d00', F: '#ff1744' }
  const color = gradeColors[grade] || '#78909c'
  return (
    <div style={{
      width: size, height: size, borderRadius: 12,
      background: `${color}18`,
      border: `2px solid ${color}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      overflow: 'hidden',
    }}>
      {grade === 'F' ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src="/images/fake-bobby-logo.png" alt="F" style={{ width: '85%', height: '85%', objectFit: 'contain', filter: 'drop-shadow(0 0 4px #ff174480)' }} />
      ) : (
        <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: size * 0.45, fontWeight: 800, color }}>{grade}</span>
      )}
    </div>
  )
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

const PRESETS = ['Microsoft', 'Apple', 'Google', 'Cisco', 'Adobe', 'Oracle', 'Fortinet', 'VMware', 'Samsung', 'Intel']

function HistoryCard({ entry, index, onClick }: { entry: HistoryEntry; index: number; onClick: () => void }) {
  const gradeColors: Record<string, string> = { 'A+': '#00c853', A: '#00c853', B: '#64dd17', C: '#ffc400', D: '#ff6d00', F: '#ff1744' }
  const gc = gradeColors[entry.grade] || '#78909c'
  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  }
  return (
    <button onClick={onClick} className="history-card" style={{
      background: 'rgba(15,23,42,0.8)', border: `1px solid ${gc}25`, borderRadius: 12, padding: 16,
      cursor: 'pointer', textAlign: 'left', width: '100%', transition: 'all 0.2s',
      animation: `fadeSlideIn 0.3s ease ${index * 0.05}s both`,
      display: 'flex', alignItems: 'center', gap: 14, fontFamily: "'Space Grotesk', sans-serif",
    }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, flexShrink: 0, background: `${gc}15`, border: `2px solid ${gc}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 800, color: gc }}>
        {entry.grade}
      </div>
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

const TRUST_DEBT_API = 'https://trust-debt-api.hogfillet.workers.dev'
const CVE_SEARCH_API = 'https://cve-search.hogfillet.workers.dev'

interface LeaderboardEntry {
  slug: string
  name: string
  grade: string
  trajectory: number
  cveCount: number
  percentileRank?: number | null
  breachCount?: number
}

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
}

// Filter CVEs to those where all query words appear as whole words in the description.
// Prevents "Epic" from matching Epicor, EpicGames, etc.
// Falls back to the unfiltered set if filtering would remove everything (graceful degradation).
function filterByVendorMatch(cves: CVE[], query: string): CVE[] {
  const words = query.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return cves
  const patterns = words.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'))
  const filtered = cves.filter(c => patterns.every(re => re.test(c.description || '')))
  return filtered.length > 0 ? filtered : cves
}

const GRADE_COLOR: Record<string, string> = {
  'A+': '#00c853', A: '#00c853', B: '#64dd17', C: '#ffc400', D: '#ff6d00', F: '#ff1744',
}

function PeerChart({ currentTrajectory, currentName, leaderboard }: {
  currentTrajectory: number
  currentName: string
  leaderboard: LeaderboardEntry[]
}) {
  if (leaderboard.length < 2) return null

  // Merge leaderboard with current company (may or may not be tracked)
  // Guard against null/undefined trajectories that can slip past the backend filter
  const slug = toSlug(currentName)
  const peers = leaderboard.filter(c => c.slug !== slug && c.trajectory != null && isFinite(c.trajectory))
  const allScores = [...peers.map(c => c.trajectory), currentTrajectory]

  const logMin = Math.log10(Math.max(1, Math.min(...allScores)))
  const logMax = Math.log10(Math.max(...allScores))
  const logRange = logMax - logMin || 1
  const toX = (v: number) => ((Math.log10(Math.max(1, v)) - logMin) / logRange) * 96 + 2

  const rank = peers.filter(c => c.trajectory < currentTrajectory).length + 1
  const total = peers.length + 1

  return (
    <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: '20px 24px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <span style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, fontFamily: "'JetBrains Mono', monospace" }}>Peer Comparison</span>
        <span style={{ fontSize: 12, color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace" }}>
          <span style={{ color: '#818cf8', fontWeight: 700 }}>#{rank}</span>
          <span style={{ color: '#475569' }}> of {total} tracked</span>
        </span>
      </div>

      {/* Log-scale dot plot */}
      <div style={{ position: 'relative', height: 56, marginBottom: 4 }}>
        {/* Track */}
        <div style={{ position: 'absolute', top: 20, left: '2%', right: '2%', height: 3, borderRadius: 2, background: 'rgba(148,163,184,0.1)' }} />

        {/* Grade zone markers */}
        {(['F', 'D', 'C', 'B', 'A'] as const).map((g) => {
          const thresholds: Record<string, number> = { F: 400, D: 180, C: 80, B: 30, A: 0 }
          const refScore = (thresholds[g] * (peers[0]?.cveCount || 100))
          if (refScore <= 0) return null
          const x = toX(refScore)
          if (x <= 2 || x >= 98) return null
          return (
            <div key={g} style={{ position: 'absolute', top: 13, left: `${x}%`, width: 1, height: 17, background: `${GRADE_COLOR[g]}30`, transform: 'translateX(-50%)' }} />
          )
        })}

        {/* Peer dots */}
        {peers.map(c => (
          <div key={c.slug} title={`${c.name}: ${c.trajectory.toLocaleString()}`} style={{
            position: 'absolute', top: 12, left: `${toX(c.trajectory)}%`,
            width: 13, height: 13, borderRadius: '50%',
            background: GRADE_COLOR[c.grade] ?? '#64748b',
            transform: 'translateX(-50%)',
            opacity: 0.65, cursor: 'default',
            boxShadow: `0 0 6px ${GRADE_COLOR[c.grade] ?? '#64748b'}50`,
          }} />
        ))}

        {/* Current company — larger, indigo */}
        <div style={{
          position: 'absolute', top: 7, left: `${toX(currentTrajectory)}%`,
          width: 22, height: 22, borderRadius: '50%',
          background: '#818cf8', border: '2px solid #6366f1',
          transform: 'translateX(-50%)', zIndex: 2,
          boxShadow: '0 0 12px #6366f160',
        }} title={`${currentName}: ${currentTrajectory.toLocaleString()}`} />

        {/* Current company label */}
        <div style={{
          position: 'absolute', top: 36,
          left: `clamp(10%, ${toX(currentTrajectory)}%, 90%)`,
          transform: 'translateX(-50%)',
          fontSize: 10, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace",
          whiteSpace: 'nowrap',
        }}>{currentName}</div>
      </div>

      {/* Axis labels: best → worst */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, paddingTop: 8, borderTop: '1px solid rgba(148,163,184,0.06)' }}>
        <span style={{ fontSize: 9, color: '#00c853', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1 }}>← better</span>
        <div style={{ display: 'flex', gap: 10 }}>
          {(['A', 'B', 'C', 'D', 'F'] as const).map(g => (
            <span key={g} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: GRADE_COLOR[g], display: 'inline-block', opacity: 0.8 }} />
              {g}
            </span>
          ))}
        </div>
        <span style={{ fontSize: 9, color: '#ff1744', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1 }}>worse →</span>
      </div>
    </div>
  )
}

export default function TrustDebtApp() {
  const [query, setQuery] = useState('')
  const [cves, setCves] = useState<CVEWithDebt[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [totalResults, setTotalResults] = useState(0)
  const [yearsBack, setYearsBack] = useState(5)
  const [searched, setSearched] = useState(false)
  const [companyName, setCompanyName] = useState('')
  const [sortBy, setSortBy] = useState('trustDebt')
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [dataSource, setDataSource] = useState<'cached' | 'live' | null>(null)
  const [fakeCharacter, setFakeCharacter] = useState<{ img: string; name: string; caption: string } | null>(null)
  const [searchHistory, setSearchHistory] = useState<HistoryEntry[]>([])
  const [viewMode, setViewMode] = useState('trajectory')
  const [currentSlug, setCurrentSlug] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [dbCounts, setDbCounts] = useState<{ cveCount: number; kevCount: number; epssCount: number; totalCompanies: number } | null>(null)
  const [sbdpSlugs, setSbdpSlugs] = useState<string[]>([])
  const [currentBreachCount, setCurrentBreachCount] = useState(0)
  const [currentBFactor, setCurrentBFactor] = useState(1.0)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('trust-debt-history')
      if (saved) setSearchHistory(JSON.parse(saved))
    } catch { /* no history yet */ }
  }, [])

  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/nvd/count`)
      .then(r => r.json())
      .then(d => { if (d.cveCount != null) setDbCounts(d) })
      .catch(() => {})
    fetch(`${TRUST_DEBT_API}/api/cisa/sbdp`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.slugs)) setSbdpSlugs(d.slugs) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/leaderboard`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setLeaderboard(data) })
      .catch(() => {})
  }, [])

  const saveToHistory = useCallback((company: string, years: number, cveList: CVEWithDebt[], debt: number, grade: string) => {
    const entry: HistoryEntry = {
      company, years, cveCount: cveList.length, totalDebt: Math.round(debt), grade, timestamp: Date.now(),
      severityCounts: {
        CRITICAL: cveList.filter(c => c.severity === 'CRITICAL').length,
        HIGH: cveList.filter(c => c.severity === 'HIGH').length,
        MEDIUM: cveList.filter(c => c.severity === 'MEDIUM').length,
        LOW: cveList.filter(c => c.severity === 'LOW').length,
      },
    }
    const updated = [entry, ...searchHistory.filter(h => h.company.toLowerCase() !== company.toLowerCase())].slice(0, 10)
    setSearchHistory(updated)
    try { localStorage.setItem('trust-debt-history', JSON.stringify(updated)) } catch { /* storage unavailable */ }
  }, [searchHistory])

  const fetchCVEs = useCallback(async (searchQuery: string, years: number) => {
    if (!searchQuery.trim()) return
    setLoading(true)
    setError('')
    setCves([])
    setFakeCharacter(null)
    setSearched(true)
    setCompanyName(searchQuery.trim())

    const now = new Date()
    const startYear = now.getFullYear() - years

    try {
      // Try cached trust-debt-api first
      const slug = toSlug(searchQuery.trim())
      setCurrentSlug(slug)
      const cachedRes = await fetch(`${TRUST_DEBT_API}/api/company/${slug}`)
      let rawCves: CVE[]

      const useLive = async () => {
        const response = await fetch(CVE_SEARCH_API, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: searchQuery.trim(), startYear, currentYear: now.getFullYear() }),
        })
        if (!response.ok) {
          const errBody = await response.json().catch(() => ({ error: 'Unknown error' }))
          throw new Error(errBody.error || `Request failed with status ${response.status}`)
        }
        setDataSource('live')
        return await response.json() as CVE[]
      }

      if (cachedRes.ok) {
        const cached = await cachedRes.json()
        const cachedCves = (cached.cves || []) as CVE[]
        setCurrentBreachCount(cached.company?.breachCount ?? 0)
        setCurrentBFactor(cached.company?.bFactor ?? 1.0)
        if (cachedCves.length > 0) {
          rawCves = cachedCves
          setDataSource('cached')
        } else {
          // Tracked but not yet synced — fall back to live
          rawCves = await useLive()
        }
      } else {
        setCurrentBreachCount(0)
        setCurrentBFactor(1.0)
        rawCves = await useLive()
      }

      if (!Array.isArray(rawCves) || rawCves.length === 0) {
        const fakes = [
          { img: '/images/fake-bobby.png', name: 'Fake Bobby', caption: `"${searchQuery.trim()}"? Never heard of 'em. Suspiciously clean record.` },
          { img: '/images/fake-david.png', name: 'Fake David', caption: `No vulnerabilities found. Either they're perfect... or they're not real.` },
          { img: '/images/fake-tommy.png', name: 'Fake Tommy', caption: `Our records show nothing. That's either impressive or suspicious.` },
        ]
        setFakeCharacter(fakes[Math.floor(Math.random() * fakes.length)])
        setLoading(false)
        return
      }

      const parsed: CVE[] = filterByVendorMatch(
        rawCves
          .filter((c) => c.id && c.severity)
          .map((c) => ({
            id: c.id, published: c.published || `${startYear}-06-01`,
            severity: (c.severity || 'NONE').toUpperCase(),
            score: typeof c.score === 'number' ? c.score : 0,
            description: c.description || 'No description available',
            kev: c.kev === true,
            epss: typeof c.epss === 'number' ? c.epss : undefined,
            epssPercentile: typeof c.epssPercentile === 'number' ? c.epssPercentile : undefined,
          })),
        searchQuery.trim()
      )

      const withDebt = calculateTrustDebt(parsed)
      setCves(withDebt)
      setTotalResults(parsed.length)

      // Auto-track companies discovered via live query, then immediately sync so they
      // appear in the leaderboard/VS page without waiting for the nightly cron.
      if (parsed.length >= 10 && !cachedRes.ok) {
        fetch(`${TRUST_DEBT_API}/api/companies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: searchQuery.trim(), keywords: [searchQuery.trim()], yearsBack: 3 }),
        })
          .then(() => fetch(`${TRUST_DEBT_API}/api/sync/${slug}`, { method: 'POST' }))
          .catch(() => {})
      }
      const t = withDebt.length > 0 ? calculateTrajectory(withDebt) : null
      const trajScore = t ? t.trajectory : 0
      const g = getGrade(trajScore, withDebt.length)
      saveToHistory(searchQuery.trim(), years, withDebt, trajScore, g)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [saveToHistory])

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault?.()
    fetchCVEs(query, yearsBack)
  }

  const isSBDP = (slug: string) => sbdpSlugs.some(s => s === slug || s.startsWith(slug + '-') || slug.startsWith(s + '-'))

  const severityCounts: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0 }
  cves.forEach((c) => severityCounts[c.severity]++)
  const totalDebt = cves.reduce((s, c) => s + c.trustDebt, 0)
  const traj = cves.length > 0 ? calculateTrajectory(cves) : null
  const trajectoryScore = traj ? traj.trajectory : 0
  const grade = getGrade(trajectoryScore, cves.length)

  const sorted = [...cves].sort((a, b) => {
    if (sortBy === 'trustDebt') return b.trustDebt - a.trustDebt
    if (sortBy === 'score') return b.score - a.score
    return b.daysOpen - a.daysOpen
  })

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
        .view-tab { transition: all 0.2s; cursor: pointer; border: none; font-family: 'JetBrains Mono', monospace; }
        .view-tab:hover { background: rgba(99,102,241,0.12) !important; }
        * { box-sizing: border-box; }
        .view-tab { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        @media (max-width: 600px) {
          .td-search-row { flex-wrap: wrap !important; }
          .td-search-row .td-input { min-width: 100% !important; order: -1; }
          .td-search-row select { flex: 1 !important; }
          .td-search-row .td-btn { flex: 1 !important; }
          .rw-cols { flex-direction: column !important; }
          .rw-divider { display: flex !important; flex-direction: row !important; align-items: center !important; justify-content: center !important; gap: 12px !important; padding: 4px 0 !important; }
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
              <li><a href="/trust/" style={{ color: '#818cf8', fontWeight: 700 }}>◆ Calculator</a></li>
              <li><a href="/trust/vs/">⚔ Compare</a></li>
            </ul>
          </nav>
          <button className="hamburger" onClick={() => setMenuOpen(v => !v)} aria-label="Toggle menu">
            <span /><span /><span />
          </button>
        </header>
        <div className={`mobile-menu${menuOpen ? ' open' : ''}`}>
          <ul>
            <li><a href="/" onClick={() => setMenuOpen(false)}>← Home</a></li>
            <li><a href="/trust/" onClick={() => setMenuOpen(false)} style={{ color: '#818cf8' }}>◆ Calculator</a></li>
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
              Every company accrues tech debt. Every company also accrues Trust Debt™ — but rarely is it taken into account when choosing a CSP or SaaS provider. Search any company to calculate theirs.
            </p>
            <p style={{ color: '#475569', fontSize: 13, marginTop: 10, maxWidth: 560, margin: '10px auto 0', lineHeight: 1.6, fontStyle: 'italic', fontFamily: "'JetBrains Mono', monospace" }}>
              Trust Debt measures how fast you&apos;re accumulating exploitable risk compared to how fast you&apos;re paying it down.
            </p>
          </div>

          {/* Search */}
          <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.1)', borderRadius: 16, padding: 24, marginBottom: 24, backdropFilter: 'blur(12px)' }}>
            <div className="td-search-row" style={{ display: 'flex', gap: 8 }}>
              <input
                className="td-input"
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                placeholder="Enter company name (e.g. Microsoft, Cisco, Adobe)..."
                style={{ flex: 1, height: 48, borderRadius: 10, border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(15,23,42,0.6)', color: '#e2e8f0', fontSize: 15, padding: '0 16px', fontFamily: "'Space Grotesk', sans-serif", transition: 'all 0.2s' }}
              />
              <select
                value={yearsBack}
                onChange={(e) => setYearsBack(Number(e.target.value))}
                style={{ height: 48, borderRadius: 10, border: '1px solid rgba(148,163,184,0.15)', background: 'rgba(15,23,42,0.6)', color: '#94a3b8', fontSize: 13, padding: '0 12px', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}
              >
                <option value={1}>1 year</option>
                <option value={3}>3 years</option>
                <option value={5}>5 years</option>
                <option value={10}>10 years</option>
              </select>
              <button className="td-btn" onClick={handleSubmit} disabled={loading} style={{ height: 48, padding: '0 24px', borderRadius: 10, border: 'none', background: '#6366f1', color: '#fff', fontWeight: 700, fontSize: 14, cursor: loading ? 'wait' : 'pointer', transition: 'all 0.2s', fontFamily: "'Space Grotesk', sans-serif", whiteSpace: 'nowrap' }}>
                {loading ? 'Scanning...' : 'Calculate'}
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 12 }}>
              {PRESETS.map((p) => (
                <button key={p} className="preset-btn" onClick={() => { setQuery(p); fetchCVEs(p, yearsBack) }} style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, border: '1px solid rgba(148,163,184,0.12)', background: 'rgba(99,102,241,0.06)', color: '#94a3b8', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.2s' }}>
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
              <p style={{ color: '#64748b', fontSize: 14 }}>{dataSource === 'cached' ? `Loading cached data for ${companyName}...` : `Searching NVD for ${companyName} vulnerabilities... this may take a moment.`}</p>
            </div>
          )}

          {/* No Results — Fake Character */}
          {fakeCharacter && !loading && (
            <div style={{ textAlign: 'center', padding: '40px 20px', animation: 'fadeSlideIn 0.4s ease' }}>
              <img src={fakeCharacter.img} alt={fakeCharacter.name} style={{ width: 180, height: 180, objectFit: 'contain', marginBottom: 20, filter: 'drop-shadow(0 8px 24px rgba(99,102,241,0.25))' }} />
              <p style={{ color: '#94a3b8', fontSize: 15, margin: '0 0 6px', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>{fakeCharacter.caption}</p>
              <p style={{ color: '#475569', fontSize: 12, margin: '0 0 24px', fontFamily: "'JetBrains Mono', monospace" }}>No CVEs found in NVD for &quot;{companyName}&quot;</p>
              <button onClick={() => { setFakeCharacter(null); setSearched(false) }} style={{ padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.1)', color: '#818cf8', fontSize: 13, cursor: 'pointer', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>
                Try another company
              </button>
            </div>
          )}

          {/* Error */}
          {error && (
            <div style={{ background: 'rgba(255,23,68,0.08)', border: '1px solid rgba(255,23,68,0.2)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
              <p style={{ color: '#ff5252', fontSize: 14, margin: 0, fontWeight: 600 }}>Search failed</p>
              <p style={{ color: '#94a3b8', fontSize: 12, margin: '8px 0 0', lineHeight: 1.6, wordBreak: 'break-word', fontFamily: "'JetBrains Mono', monospace" }}>{error}</p>
              <button onClick={() => { setError(''); fetchCVEs(companyName || query, yearsBack) }} style={{ marginTop: 12, padding: '8px 20px', borderRadius: 8, border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.1)', color: '#818cf8', fontSize: 13, cursor: 'pointer', fontFamily: "'Space Grotesk', sans-serif", fontWeight: 600 }}>
                Retry search
              </button>
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
                <a href={`/trust/vs/${currentSlug ? `?a=${currentSlug}` : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', padding: '3px 10px', borderRadius: 6, transition: 'all 0.15s' }}>
                  ⚔ Compare
                </a>
                {dataSource && (
                  <span style={{ marginLeft: 'auto', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", padding: '2px 8px', borderRadius: 4, background: dataSource === 'cached' ? 'rgba(0,200,83,0.1)' : 'rgba(99,102,241,0.1)', color: dataSource === 'cached' ? '#00c853' : '#818cf8', border: `1px solid ${dataSource === 'cached' ? '#00c85330' : '#6366f130'}` }}>
                    {dataSource === 'cached' ? '⚡ cached' : '🔍 live query'}
                  </span>
                )}
              </div>
              {dataSource === 'cached' && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 14px', borderRadius: 8, background: 'rgba(0,200,83,0.05)', border: '1px solid rgba(0,200,83,0.12)', marginBottom: 16, fontSize: 12, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.6 }}>
                  <span style={{ color: '#00c853', flexShrink: 0, marginTop: 1 }}>ⓘ</span>
                  <span><span style={{ color: '#94a3b8' }}>Showing pre-cached data (last 12 months, updated nightly).</span> The year range selector only applies to live queries — untracked companies are queried directly from NVD in real time.</span>
                </div>
              )}
              {/* View Mode Tabs */}
              <div className="view-tabs-bar" style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 10, padding: 4, border: '1px solid rgba(148,163,184,0.08)' }}>
                {[
                  { key: 'trajectory', label: 'Trajectory', icon: '◆' },
                  { key: 'window', label: 'Window', icon: '↔' },
                  { key: 'recurrence', label: 'Recurrence', icon: '⟳' },
                  { key: 'velocity', label: 'Velocity', icon: '⚡' },
                ].map((tab) => (
                  <button key={tab.key} className="view-tab" onClick={() => setViewMode(tab.key)} style={{ flex: 1, padding: '10px 8px', borderRadius: 8, background: viewMode === tab.key ? 'rgba(99,102,241,0.15)' : 'transparent', color: viewMode === tab.key ? '#818cf8' : '#64748b', fontSize: 11, fontWeight: viewMode === tab.key ? 700 : 500, letterSpacing: 0.3, borderBottom: viewMode === tab.key ? '2px solid #6366f1' : '2px solid transparent' }}>
                    {tab.icon} {tab.label}
                  </button>
                ))}
              </div>

              {/* Trust Trajectory View */}
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
                      {traj && traj.kevCount > 0 && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.1)', padding: '2px 10px', borderRadius: 20, border: '1px solid rgba(255,23,68,0.3)', fontFamily: "'JetBrains Mono', monospace" }}>
                          {traj.kevCount} KEV {traj.kevCount === 1 ? 'hit' : 'hits'}
                        </span>
                      )}
                      {isSBDP(currentSlug) && <span style={{ fontSize: 10, fontWeight: 700, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>CISA SBDP ✓</span>}
                      {currentBreachCount > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.25)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>HIBP{currentBreachCount > 1 ? ` ×${currentBreachCount}` : ''}</span>}
                    </div>
                  </div>

                  {/* Ingredient list */}
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
                        {row.status === 'NEW'
                          ? <span style={{ fontSize: 9, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.12)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,23,68,0.3)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>NEW</span>
                          : <span />}
                      </div>
                    )) : null}
                    <div style={{ height: 1, background: 'rgba(148,163,184,0.1)', margin: '4px 0' }} />
                    {[
                      { sym: 'D', name: 'Disclosure Lag', source: 'NVD' },
                      { sym: 'E', name: 'EOL Exposure', source: 'Vendor lifecycle' },
                      { sym: 'M', name: 'SEC 8-K', source: 'SEC EDGAR' },
                    ].map((row) => (
                      <div key={row.sym} style={{ display: 'grid', gridTemplateColumns: '36px 1fr 1fr auto 52px', alignItems: 'center', padding: '8px 16px', opacity: 0.3 }}>
                        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 800, color: '#64748b' }}>{row.sym}</span>
                        <span style={{ fontSize: 12, color: '#64748b' }}>{row.name}</span>
                        <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{row.source}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", textAlign: 'right', paddingRight: 16 }}>1.00×</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: '#64748b', background: 'rgba(100,116,139,0.1)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(100,116,139,0.2)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>TBD</span>
                      </div>
                    ))}
                  </div>

                  {leaderboard.length >= 2 && traj && (
                    <PeerChart
                      currentTrajectory={trajectoryScore}
                      currentName={companyName}
                      leaderboard={leaderboard}
                    />
                  )}
                </div>
              )}

              {/* Rolling Window View */}
              {viewMode === 'window' && traj && (
                <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 20, fontFamily: "'JetBrains Mono', monospace", textAlign: 'center' }}>12-Month Rolling Window Comparison</div>
                    <div className="rw-cols" style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div style={{ flex: 1, textAlign: 'center', padding: 20, borderRadius: 12, background: 'rgba(148,163,184,0.04)' }}>
                        <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>Previous 12 months</div>
                        <div style={{ fontSize: 36, fontWeight: 800, color: '#94a3b8' }}>{Math.round(traj.tdPrevious).toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{traj.previousWindow.length} CVEs</div>
                        <div style={{ marginTop: 12 }}>
                          <SeverityBar counts={{ CRITICAL: traj.previousWindow.filter(c => c.severity === 'CRITICAL').length, HIGH: traj.previousWindow.filter(c => c.severity === 'HIGH').length, MEDIUM: traj.previousWindow.filter(c => c.severity === 'MEDIUM').length, LOW: traj.previousWindow.filter(c => c.severity === 'LOW').length, NONE: traj.previousWindow.filter(c => c.severity === 'NONE').length }} total={traj.previousWindow.length} />
                        </div>
                      </div>
                      <div className="rw-divider" style={{ flexShrink: 0, textAlign: 'center' }}>
                        <TrendIndicator delta={traj.delta} />
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#818cf8', marginTop: 8, fontFamily: "'JetBrains Mono', monospace" }}>Δ {traj.delta.toFixed(2)}</div>
                      </div>
                      <div style={{ flex: 1, textAlign: 'center', padding: 20, borderRadius: 12, background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)' }}>
                        <div style={{ fontSize: 10, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>Current 12 months</div>
                        <div style={{ fontSize: 36, fontWeight: 800, color: '#e2e8f0' }}>{Math.round(traj.tdCurrent).toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{traj.currentWindow.length} CVEs</div>
                        <div style={{ marginTop: 12 }}>
                          <SeverityBar counts={{ CRITICAL: traj.currentWindow.filter(c => c.severity === 'CRITICAL').length, HIGH: traj.currentWindow.filter(c => c.severity === 'HIGH').length, MEDIUM: traj.currentWindow.filter(c => c.severity === 'MEDIUM').length, LOW: traj.currentWindow.filter(c => c.severity === 'LOW').length, NONE: traj.currentWindow.filter(c => c.severity === 'NONE').length }} total={traj.currentWindow.length} />
                        </div>
                        {(traj.kevCount > 0 || traj.epssHighCount > 0) && (
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                            {traj.kevCount > 0 && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.1)', padding: '2px 8px', borderRadius: 10, border: '1px solid rgba(255,23,68,0.25)', fontFamily: "'JetBrains Mono', monospace" }}>
                                {traj.kevCount} KEV
                              </span>
                            )}
                            {traj.epssHighCount > 0 && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: '#ff6d00', background: 'rgba(255,109,0,0.1)', padding: '2px 8px', borderRadius: 10, border: '1px solid rgba(255,109,0,0.25)', fontFamily: "'JetBrains Mono', monospace" }}>
                                {traj.epssHighCount} high EPSS
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>Quarterly Trust Debt</span>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>← older · newer →</span>
                    </div>
                    <QuarterlySparkline quarters={traj.quarters} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, marginBottom: 2 }}>
                      {traj.quarters.map((q, i) => <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{q.debt > 0 ? Math.round(q.debt) : ''}</div>)}
                    </div>
                    <span style={{ fontSize: 9, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 0.8 }}>Trust Debt / qtr</span>
                  </div>
                  <div style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                    <div style={{ fontSize: 12, color: '#818cf8', fontWeight: 600, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>HOW Δ WORKS</div>
                    <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>Δ = Current 12mo Trust Debt ÷ Previous 12mo Trust Debt, capped between 0.5–2.0. A value above 1.0 means the company is accumulating vulnerability debt faster than before. Below 1.0 means they&apos;re improving.</div>
                  </div>
                </div>
              )}

              {/* Recurrence View */}
              {viewMode === 'recurrence' && traj && (
                <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16, textAlign: 'center' }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>Recurrence Multiplier</div>
                    <div style={{ fontSize: 64, fontWeight: 800, color: traj.recurrence >= 2.5 ? '#ff1744' : traj.recurrence >= 1.5 ? '#ff6d00' : traj.recurrence > 1.0 ? '#ffc400' : '#00c853' }}>{traj.recurrence.toFixed(2)}×</div>
                    <div style={{ fontSize: 13, color: '#94a3b8', marginTop: 8 }}>
                      {traj.recurrence >= 2.5 ? 'Systemic failure pattern detected' : traj.recurrence >= 1.5 ? 'Repeated high-severity vulnerabilities' : traj.recurrence > 1.0 ? 'Some recurring issues' : 'Minimal recurrence'}
                    </div>
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

                  {/* KEV + EPSS exploitation context */}
                  {(traj.kevCount > 0 || traj.epssHighCount > 0) && (() => {
                    const kevInWindow = traj.currentWindow.filter(c => c.kev)
                    const epssHighInWindow = traj.currentWindow.filter(c => (c.epss ?? 0) > 0.10)
                    return (
                      <div style={{ display: 'grid', gridTemplateColumns: traj.kevCount > 0 && traj.epssHighCount > 0 ? '1fr 1fr' : '1fr', gap: 12, marginBottom: 12 }}>
                        {traj.kevCount > 0 && (
                          <div style={{ background: 'rgba(255,23,68,0.04)', border: '1px solid rgba(255,23,68,0.2)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: '#ff1744', fontWeight: 700, textTransform: 'uppercase', fontFamily: "'JetBrains Mono', monospace", marginBottom: 6, letterSpacing: 1 }}>CISA KEV</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: '#ff1744' }}>{traj.kevCount}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>actively exploited in wild</div>
                            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
                              {kevInWindow.slice(0, 3).map(c => (
                                <span key={c.id} style={{ fontSize: 9, color: '#ff5252', background: 'rgba(255,23,68,0.08)', padding: '1px 6px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace" }}>{c.id}</span>
                              ))}
                              {kevInWindow.length > 3 && <span style={{ fontSize: 9, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>+{kevInWindow.length - 3} more</span>}
                            </div>
                          </div>
                        )}
                        {traj.epssHighCount > 0 && (
                          <div style={{ background: 'rgba(255,109,0,0.04)', border: '1px solid rgba(255,109,0,0.2)', borderRadius: 12, padding: 16, textAlign: 'center' }}>
                            <div style={{ fontSize: 10, color: '#ff6d00', fontWeight: 700, textTransform: 'uppercase', fontFamily: "'JetBrains Mono', monospace", marginBottom: 6, letterSpacing: 1 }}>HIGH EPSS</div>
                            <div style={{ fontSize: 28, fontWeight: 800, color: '#ff6d00' }}>{traj.epssHighCount}</div>
                            <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>&gt;10% exploit probability</div>
                            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
                              {epssHighInWindow.sort((a, b) => (b.epss ?? 0) - (a.epss ?? 0)).slice(0, 3).map(c => (
                                <span key={c.id} style={{ fontSize: 9, color: '#ff9100', background: 'rgba(255,109,0,0.08)', padding: '1px 6px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace" }}>{((c.epss ?? 0) * 100).toFixed(0)}%</span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', marginBottom: 12 }}>R Calculation</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, lineHeight: 2.2, color: '#94a3b8' }}>
                      <span style={{ color: '#64748b' }}>Base:</span> <span style={{ color: '#e2e8f0' }}>1.00</span><br />
                      <span style={{ color: '#64748b' }}>Critical CVEs:</span> <span style={{ color: '#ff1744' }}>{traj.currentWindow.filter(c => c.severity === 'CRITICAL').length}</span> × 0.15 = <span style={{ color: '#e2e8f0' }}>+{(traj.currentWindow.filter(c => c.severity === 'CRITICAL').length * 0.15).toFixed(2)}</span><br />
                      <span style={{ color: '#64748b' }}>High CVEs:</span> <span style={{ color: '#ff6d00' }}>{traj.currentWindow.filter(c => c.severity === 'HIGH').length}</span> × 0.15 = <span style={{ color: '#e2e8f0' }}>+{(traj.currentWindow.filter(c => c.severity === 'HIGH').length * 0.15).toFixed(2)}</span><br />
                      {traj.kevCount > 0 && (
                        <><span style={{ color: '#64748b' }}>↳ of which:</span> <span style={{ color: '#ff1744' }}>{traj.kevCount} CISA KEV</span> <span style={{ color: '#475569', fontSize: 11 }}>(already exploited in wild)</span><br /></>
                      )}
                      <div style={{ borderTop: '1px solid rgba(148,163,184,0.1)', marginTop: 8, paddingTop: 8, fontSize: 15, color: '#818cf8', fontWeight: 700 }}>R = {traj.recurrence.toFixed(2)}</div>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                    <div style={{ fontSize: 12, color: '#818cf8', fontWeight: 600, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>HOW R WORKS</div>
                    <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>R = 1 + (critical + high CVEs in current 12mo × 0.15). A single critical CVE is a mistake. Ten critical CVEs in one year is a pattern — the multiplier compounds to penalize companies that repeatedly ship high-severity vulnerabilities. CISA KEV hits shown above are the worst offenders: vulnerabilities already confirmed exploited in the wild.</div>
                  </div>
                </div>
              )}

              {/* Trust Velocity View */}
              {viewMode === 'velocity' && traj && (() => {
                const tv = calculateTrustVelocity(traj.quarters)
                return (
                  <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                    <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16, textAlign: 'center' }}>
                      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 12, fontFamily: "'JetBrains Mono', monospace" }}>Trust Velocity</div>
                      {tv ? (
                        <>
                          <div style={{ fontSize: 64, fontWeight: 800, color: tv.color, lineHeight: 1 }}>{tv.grade}</div>
                          <div style={{ fontSize: 16, fontWeight: 600, color: tv.color, marginTop: 8 }}>{tv.label}</div>
                          <div style={{ fontSize: 13, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", marginTop: 6 }}>
                            {tv.avg >= 0 ? '+' : ''}{(tv.avg * 100).toFixed(1)}% avg quarterly change
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: 14, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>Not enough quarterly data yet</div>
                      )}
                    </div>

                    {/* Quarter-by-quarter breakdown — uses all quarters including empty ones */}
                    {tv && (
                      <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 16 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', marginBottom: 16 }}>Quarter-by-Quarter Velocity</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {traj.quarters.slice(1).map((q, i) => {
                            const prev = traj.quarters[i]
                            const { change, isNew } = qoqTransition(traj.quarters, i + 1)
                            const noActivity = prev.debt === 0 && q.debt === 0
                            const { grade, color } = isNew ? capGrade(debtGrade(q.debt), q.debt) : velGrade(change, q.debt)
                            const pct = (change * 100).toFixed(1)
                            const arrow = change < -0.02 ? '↓' : change > 0.02 ? '↑' : '→'
                            return (
                              <div key={q.label} style={{ display: 'grid', gridTemplateColumns: '60px 1fr 80px 36px', gap: 12, alignItems: 'center', padding: '10px 14px', background: 'rgba(148,163,184,0.03)', borderRadius: 8, opacity: noActivity ? 0.4 : 1 }}>
                                <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{prev.label} → {q.label}</span>
                                <div style={{ height: 6, borderRadius: 3, background: 'rgba(148,163,184,0.08)', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${Math.min(100, (isNew ? 0.5 : Math.abs(change)) * 200)}%`, background: color, borderRadius: 3 }} />
                                </div>
                                <span style={{ fontSize: 12, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}>
                                  {isNew ? '↑ new' : `${arrow} ${change >= 0 ? '+' : ''}${pct}%`}
                                </span>
                                <span style={{ fontSize: 13, fontWeight: 800, color, fontFamily: "'JetBrains Mono', monospace", textAlign: 'center' }}>{grade}</span>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}

                    <div style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                      <div style={{ fontSize: 12, color: '#818cf8', fontWeight: 600, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>HOW TRUST VELOCITY WORKS</div>
                      <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>Trust Velocity measures the quarter-over-quarter rate of change in Trust Debt accumulation. A company improving its security posture will have a negative velocity (debt shrinking). A debt spiral — where each quarter is worse than the last — grades as F. Each quarter is graded independently so you can see exactly when things started getting worse, or better.</div>
                    </div>
                  </div>
                )
              })()}

              {/* Severity Distribution */}
              <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>Severity Distribution</span>
                  <span style={{ fontSize: 12, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{totalResults > 200 ? `showing 200 of ${totalResults}` : `${cves.length} results`}</span>
                </div>
                <SeverityBar counts={severityCounts} total={cves.length} />
                <div style={{ display: 'flex', gap: 16, marginTop: 12, flexWrap: 'wrap' }}>
                  {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => (
                    <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: SEVERITY_COLORS[s] }} />
                      <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: "'JetBrains Mono', monospace" }}>{s} ({severityCounts[s]})</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Timeline */}
              {cves.length > 0 && (
                <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>Trust Debt Accumulation by Year</span>
                  <TimelineChart cves={cves} />
                </div>
              )}

              {/* CVE List */}
              {cves.length > 0 && (
                <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>Vulnerability Details</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[{ key: 'trustDebt', label: 'Trust Debt' }, { key: 'score', label: 'CVSS' }, { key: 'daysOpen', label: 'Age' }].map((s) => (
                        <button key={s.key} className="sort-btn" onClick={() => setSortBy(s.key)} style={{ padding: '4px 10px', borderRadius: 6, fontSize: 11, border: 'none', background: sortBy === s.key ? 'rgba(99,102,241,0.2)' : 'transparent', color: sortBy === s.key ? '#818cf8' : '#64748b', cursor: 'pointer', fontFamily: "'JetBrains Mono', monospace", fontWeight: sortBy === s.key ? 700 : 400, transition: 'all 0.15s' }}>
                          {s.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    {sorted.slice(0, 100).map((cve, i) => <CVERow key={cve.id} cve={cve} index={i} />)}
                  </div>
                  {sorted.length > 100 && <div style={{ textAlign: 'center', padding: 12, color: '#64748b', fontSize: 12 }}>Showing top 100 of {sorted.length} CVEs</div>}
                </div>
              )}

              {cves.length === 0 && !loading && searched && !error && (
                <div style={{ textAlign: 'center', padding: 60 }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>🛡️</div>
                  <p style={{ color: '#64748b', fontSize: 15 }}>No CVEs found for &ldquo;{companyName}&rdquo; in the last {yearsBack} years.</p>
                  <p style={{ color: '#475569', fontSize: 13 }}>Try a different company name or broader time range.</p>
                </div>
              )}
            </div>
          )}

          {/* History / Empty state */}
          {!searched && (
            <div style={{ animation: 'fadeSlideIn 0.4s ease' }}>
              {searchHistory.length > 0 ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: '#cbd5e1' }}>Recent Searches</span>
                      <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(99,102,241,0.08)', padding: '2px 8px', borderRadius: 4 }}>{searchHistory.length}</span>
                    </div>
                    <button className="clear-btn" onClick={() => { setSearchHistory([]); try { localStorage.removeItem('trust-debt-history') } catch { /* ok */ } }} style={{ fontSize: 11, color: '#64748b', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 10px', borderRadius: 6, fontFamily: "'JetBrains Mono', monospace", transition: 'all 0.15s' }}>
                      Clear all
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {searchHistory.map((entry, i) => (
                      <HistoryCard key={entry.company + entry.timestamp} entry={entry} index={i} onClick={() => { setQuery(entry.company); setYearsBack(entry.years); fetchCVEs(entry.company, entry.years) }} />
                    ))}
                  </div>
                  <p style={{ color: '#475569', fontSize: 12, marginTop: 16, textAlign: 'center', fontFamily: "'JetBrains Mono', monospace" }}>Click any card to re-run the search with fresh data</p>
                </div>
              ) : null}
              {leaderboard.length > 0 && (
                <div style={{ marginTop: searchHistory.length > 0 ? 32 : 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#cbd5e1' }}>Tracked Companies</span>
                    <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(99,102,241,0.08)', padding: '2px 8px', borderRadius: 4 }}>{dbCounts?.totalCompanies ?? leaderboard.length}</span>
                    <a href="/trust/vs/" style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none', background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)', padding: '3px 10px', borderRadius: 6, transition: 'all 0.15s' }}>
                      ⚔ Compare
                    </a>
                  </div>
                  {/* Quick insights strip */}
                  {(() => {
                    const sorted = [...leaderboard].sort((a, b) => a.trajectory - b.trajectory)
                    const best = sorted[0]
                    const worst = sorted[sorted.length - 1]
                    return (
                      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
                        {best && <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: '#00c853', background: 'rgba(0,200,83,0.07)', border: '1px solid rgba(0,200,83,0.15)', padding: '3px 8px', borderRadius: 6 }}>Most trusted: {best.name} ({best.grade})</span>}
                        {worst && <span style={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", color: '#ff6d00', background: 'rgba(255,109,0,0.07)', border: '1px solid rgba(255,109,0,0.15)', padding: '3px 8px', borderRadius: 6 }}>Least trusted: {worst.name} ({worst.grade})</span>}
                      </div>
                    )
                  })()}
                </div>
              )}
              {leaderboard.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {leaderboard.map((c) => {
                    const gc = c.grade === 'A+' || c.grade === 'A' ? '#00c853' : c.grade === 'B' ? '#64748b' : c.grade === 'C' ? '#ffc400' : c.grade === 'D' ? '#ff6d00' : '#ff1744'
                    return (
                      <button key={c.slug} onClick={() => { setQuery(c.name); fetchCVEs(c.name, yearsBack) }}
                        style={{ background: 'rgba(15,23,42,0.6)', border: `1px solid ${gc}30`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}
                        onMouseEnter={e => (e.currentTarget.style.borderColor = gc + '80')}
                        onMouseLeave={e => (e.currentTarget.style.borderColor = gc + '30')}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', lineHeight: 1.2 }}>{c.name}</span>
                          <span style={{ fontSize: 13, fontWeight: 800, color: gc, flexShrink: 0, marginLeft: 6 }}>{c.grade}</span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 10, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{c.cveCount} CVEs</span>
                          {isSBDP(c.slug) && <span style={{ fontSize: 9, fontWeight: 700, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', padding: '1px 5px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5, whiteSpace: 'nowrap' }}>CISA SBDP ✓</span>}
                          {(c.breachCount ?? 0) > 0 && <span style={{ fontSize: 9, fontWeight: 700, color: '#f97316', background: 'rgba(249,115,22,0.08)', border: '1px solid rgba(249,115,22,0.25)', padding: '1px 5px', borderRadius: 3, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5, whiteSpace: 'nowrap' }}>HIBP{(c.breachCount ?? 0) > 1 ? ` ×${c.breachCount}` : ''}</span>}
                        </div>
                      </button>
                    )
                  })}
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

        {/* Data source footnotes */}
        <div style={{ maxWidth: 900, margin: '40px auto 0', padding: '24px 20px 60px', borderTop: '1px solid rgba(148,163,184,0.08)' }}>
          <p style={{ fontSize: 10, fontWeight: 700, color: '#334155', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 2, textTransform: 'uppercase', marginBottom: 16 }}>Data Sources &amp; Disclaimers</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 16 }}>
            {[
              {
                label: 'NIST NVD — CVEs',
                body: 'Vulnerability data sourced from the National Institute of Standards and Technology National Vulnerability Database (NIST NVD). CVE counts and severity scores reflect publicly disclosed vulnerabilities. Trust Debt scores are a derived metric and not endorsed by NIST.',
              },
              {
                label: 'CISA KEV',
                body: 'Known Exploited Vulnerabilities catalog maintained by the Cybersecurity and Infrastructure Security Agency (CISA). KEV entries indicate vulnerabilities with confirmed active exploitation in the wild. Inclusion increases Trust Debt weighting.',
              },
              {
                label: 'FIRST EPSS',
                body: 'Exploit Prediction Scoring System (EPSS) scores provided by the Forum of Incident Response and Security Teams (FIRST). EPSS estimates the probability a CVE will be exploited within 30 days. Higher EPSS scores amplify Trust Debt trajectory.',
              },
              {
                label: 'CISA Secure by Design Pledge',
                body: 'The CISA SBDP ✓ badge indicates a software manufacturer has voluntarily signed the CISA Secure by Design pledge, committing to measurable progress on memory-safe languages, default security settings, and reducing CVE classes. Signatory list sourced from cisa.gov and refreshed monthly. Signing the pledge does not guarantee security.',
              },
              {
                label: 'Have I Been Pwned — Breaches',
                body: 'Breach data sourced from Have I Been Pwned (HIBP), a public service cataloging confirmed data breaches. The B factor in the Trust Trajectory formula is weighted by breach PwnCount (number of affected accounts) with a 12-month halflife decay — recent breaches carry full weight while older incidents diminish over time. Matching uses company name, domain, and configured aliases to capture parent/subsidiary relationships (e.g. Meta → Facebook). Breach data is informational and does not imply ongoing vulnerability.',
              },
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
