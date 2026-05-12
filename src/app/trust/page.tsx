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
  const trajectory = tdCurrent * delta * recurrence * kFactor

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
    quarters.push({ label: `Q${8 - q}`, debt: qDebt, count: qCves.length, critHigh: qCritHigh })
  }

  return { tdCurrent, tdPrevious, delta, recurrence, kevCount, kFactor, trajectory, currentWindow, previousWindow, critHighCurrent, quarters }
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
  return (
    <div
      style={{ borderBottom: '1px solid rgba(148,163,184,0.1)', padding: '12px 0', cursor: 'pointer', animation: `fadeSlideIn 0.3s ease ${index * 0.03}s both` }}
      onClick={() => setExpanded(!expanded)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: SEVERITY_COLORS[cve.severity], flexShrink: 0, boxShadow: `0 0 6px ${SEVERITY_COLORS[cve.severity]}60` }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: '#e2e8f0', fontWeight: 600 }}>{cve.id}</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
              {cve.kev && (
                <span style={{ fontSize: 10, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.12)', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(255,23,68,0.35)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>KEV</span>
              )}
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
}

function toSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
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

  useEffect(() => {
    try {
      const saved = localStorage.getItem('trust-debt-history')
      if (saved) setSearchHistory(JSON.parse(saved))
    } catch { /* no history yet */ }
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
        if (cachedCves.length > 0) {
          rawCves = cachedCves
          setDataSource('cached')
        } else {
          // Tracked but not yet synced — fall back to live
          rawCves = await useLive()
        }
      } else {
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

      const parsed: CVE[] = rawCves
        .filter((c) => c.id && c.severity)
        .map((c) => ({
          id: c.id, published: c.published || `${startYear}-06-01`,
          severity: (c.severity || 'NONE').toUpperCase(),
          score: typeof c.score === 'number' ? c.score : 0,
          description: c.description || 'No description available',
        }))

      const withDebt = calculateTrustDebt(parsed)
      setCves(withDebt)
      setTotalResults(parsed.length)

      // Auto-track companies discovered via live query (fire-and-forget, only if results exist)
      if (parsed.length > 0 && !cachedRes.ok) {
        fetch(`${TRUST_DEBT_API}/api/companies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: searchQuery.trim(), keywords: [searchQuery.trim()], yearsBack: 3 }),
        }).catch(() => {})
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
      `}</style>

      <div style={{ minHeight: '100vh', background: '#0b0f1a', color: '#e2e8f0', fontFamily: "'Space Grotesk', sans-serif", position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', opacity: 0.03, backgroundImage: `linear-gradient(rgba(99,102,241,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.5) 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />

        <div style={{ maxWidth: 900, margin: '0 auto', padding: '40px 20px', position: 'relative' }}>
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
          </div>

          {/* Search */}
          <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.1)', borderRadius: 16, padding: 24, marginBottom: 24, backdropFilter: 'blur(12px)' }}>
            <div style={{ display: 'flex', gap: 8 }}>
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
              <div style={{ display: 'flex', gap: 4, marginBottom: 20, background: 'rgba(15,23,42,0.6)', borderRadius: 10, padding: 4, border: '1px solid rgba(148,163,184,0.08)' }}>
                {[
                  { key: 'trajectory', label: 'Trust Trajectory™', icon: '◆' },
                  { key: 'window', label: 'Rolling Window (Δ)', icon: '↔' },
                  { key: 'recurrence', label: 'Recurrence (R)', icon: '⟳' },
                ].map((tab) => (
                  <button key={tab.key} className="view-tab" onClick={() => setViewMode(tab.key)} style={{ flex: 1, padding: '10px 12px', borderRadius: 8, background: viewMode === tab.key ? 'rgba(99,102,241,0.15)' : 'transparent', color: viewMode === tab.key ? '#818cf8' : '#64748b', fontSize: 12, fontWeight: viewMode === tab.key ? 700 : 500, letterSpacing: 0.3, borderBottom: viewMode === tab.key ? '2px solid #6366f1' : '2px solid transparent' }}>
                    <span style={{ marginRight: 6 }}>{tab.icon}</span>{tab.label}
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
                    <div style={{ fontSize: 12, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", marginTop: 12 }}>TT = TD × Δ × R × K</div>
                    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 10, marginTop: 6 }}>
                      <span style={{ fontSize: 12, color: '#475569' }}>{cves.length} CVEs analyzed</span>
                      {traj && traj.kevCount > 0 && (
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#ff1744', background: 'rgba(255,23,68,0.1)', padding: '2px 10px', borderRadius: 20, border: '1px solid rgba(255,23,68,0.3)', fontFamily: "'JetBrains Mono', monospace" }}>
                          {traj.kevCount} KEV {traj.kevCount === 1 ? 'hit' : 'hits'}
                        </span>
                      )}
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
                      { sym: 'P', name: 'EPSS Score', source: 'FIRST.org' },
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
                </div>
              )}

              {/* Rolling Window View */}
              {viewMode === 'window' && traj && (
                <div style={{ animation: 'fadeSlideIn 0.3s ease' }}>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 28, marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, marginBottom: 20, fontFamily: "'JetBrains Mono', monospace", textAlign: 'center' }}>12-Month Rolling Window Comparison</div>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      <div style={{ flex: 1, textAlign: 'center', padding: 20, borderRadius: 12, background: 'rgba(148,163,184,0.04)' }}>
                        <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', marginBottom: 8, letterSpacing: 1 }}>Previous 12 months</div>
                        <div style={{ fontSize: 36, fontWeight: 800, color: '#94a3b8' }}>{Math.round(traj.tdPrevious).toLocaleString()}</div>
                        <div style={{ fontSize: 13, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{traj.previousWindow.length} CVEs</div>
                        <div style={{ marginTop: 12 }}>
                          <SeverityBar counts={{ CRITICAL: traj.previousWindow.filter(c => c.severity === 'CRITICAL').length, HIGH: traj.previousWindow.filter(c => c.severity === 'HIGH').length, MEDIUM: traj.previousWindow.filter(c => c.severity === 'MEDIUM').length, LOW: traj.previousWindow.filter(c => c.severity === 'LOW').length, NONE: traj.previousWindow.filter(c => c.severity === 'NONE').length }} total={traj.previousWindow.length} />
                        </div>
                      </div>
                      <div style={{ flexShrink: 0, textAlign: 'center' }}>
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
                      </div>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <span style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1' }}>Quarterly Trust Debt</span>
                      <span style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>← older · newer →</span>
                    </div>
                    <QuarterlySparkline quarters={traj.quarters} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                      {traj.quarters.map((q, i) => <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{q.debt > 0 ? Math.round(q.debt) : ''}</div>)}
                    </div>
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
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
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
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', marginBottom: 12 }}>R Calculation</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, lineHeight: 2.2, color: '#94a3b8' }}>
                      <span style={{ color: '#64748b' }}>Base:</span> <span style={{ color: '#e2e8f0' }}>1.00</span><br />
                      <span style={{ color: '#64748b' }}>Critical CVEs:</span> <span style={{ color: '#ff1744' }}>{traj.currentWindow.filter(c => c.severity === 'CRITICAL').length}</span> × 0.15 = <span style={{ color: '#e2e8f0' }}>+{(traj.currentWindow.filter(c => c.severity === 'CRITICAL').length * 0.15).toFixed(2)}</span><br />
                      <span style={{ color: '#64748b' }}>High CVEs:</span> <span style={{ color: '#ff6d00' }}>{traj.currentWindow.filter(c => c.severity === 'HIGH').length}</span> × 0.15 = <span style={{ color: '#e2e8f0' }}>+{(traj.currentWindow.filter(c => c.severity === 'HIGH').length * 0.15).toFixed(2)}</span><br />
                      <div style={{ borderTop: '1px solid rgba(148,163,184,0.1)', marginTop: 8, paddingTop: 8, fontSize: 15, color: '#818cf8', fontWeight: 700 }}>R = {traj.recurrence.toFixed(2)}</div>
                    </div>
                  </div>
                  <div style={{ background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.12)', borderRadius: 12, padding: 16, marginBottom: 24 }}>
                    <div style={{ fontSize: 12, color: '#818cf8', fontWeight: 600, marginBottom: 6, fontFamily: "'JetBrains Mono', monospace" }}>HOW R WORKS</div>
                    <div style={{ fontSize: 12, color: '#64748b', lineHeight: 1.8 }}>R = 1 + (critical + high CVEs in current 12mo × 0.15). A single critical CVE is a mistake. Ten critical CVEs in one year is a pattern — the multiplier compounds to penalize companies that repeatedly ship high-severity vulnerabilities.</div>
                  </div>
                </div>
              )}

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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#cbd5e1' }}>Tracked Companies</span>
                    <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", background: 'rgba(99,102,241,0.08)', padding: '2px 8px', borderRadius: 4 }}>{leaderboard.length}</span>
                    <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginLeft: 'auto' }}>updated nightly</span>
                  </div>
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
                          <span style={{ fontSize: 10, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{c.cveCount} CVEs</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              {leaderboard.length === 0 && searchHistory.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px 0' }}>
                  <p style={{ color: '#64748b', fontSize: 16, margin: 0 }}>Search a company to see their Trust Debt score</p>
                  <p style={{ color: '#475569', fontSize: 13, marginTop: 8 }}>Powered by NIST NVD data</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
