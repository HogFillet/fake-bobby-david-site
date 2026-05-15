'use client'

import { useState, useEffect, Suspense } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

const TRUST_DEBT_API = 'https://trust-debt-api.hogfillet.workers.dev'

const GRADE_COLOR: Record<string, string> = {
  'A+': '#00c853', A: '#00c853', B: '#64dd17', C: '#ffc400', D: '#ff6d00', F: '#ff1744',
}

// Public perception vs actual Trust Debt
const PERCEIVED_TRUST: Record<string, { level: 'Very High' | 'High' | 'Medium'; reason: string }> = {
  'crowdstrike': { level: 'Very High', reason: 'cybersecurity vendor' },
  'okta': { level: 'Very High', reason: 'identity security vendor' },
  'palo-alto-networks': { level: 'Very High', reason: 'cybersecurity vendor' },
  'apple': { level: 'High', reason: 'privacy-first branding' },
  'microsoft': { level: 'High', reason: 'enterprise security leader' },
  'google': { level: 'High', reason: 'cloud / infrastructure' },
  'cisco': { level: 'High', reason: 'network security vendor' },
  'fortinet': { level: 'High', reason: 'firewall / network security' },
  'vmware': { level: 'High', reason: 'enterprise virtualization' },
  'intel': { level: 'High', reason: 'hardware / trusted platform' },
  'amazon': { level: 'High', reason: 'cloud infrastructure (AWS)' },
}

interface LeaderboardEntry {
  slug: string
  name: string
  grade: string
  trajectory: number
  cveCount: number
  percentileRank?: number | null
}

interface Snapshot {
  trajectory?: number
  grade?: string
  kevCount?: number
  epssHighCount?: number
  kFactor?: number
  pFactor?: number
  delta?: number
  recurrence?: number
  tdCurrent?: number
  tdPrevious?: number
  critHigh?: number
  cveCount?: number
}

interface CompanyDetail {
  company: {
    slug: string
    name: string
    latestGrade: string
    latestTrajectory: number
    cveCount: number
    percentileRank?: number | null
  }
  latestSnapshot: Snapshot | null
}

function GradeBadge({ grade, size = 48 }: { grade: string; size?: number }) {
  const color = GRADE_COLOR[grade] ?? '#64748b'
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.22,
      background: `${color}18`, border: `2px solid ${color}55`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.44, fontWeight: 800, color,
      fontFamily: "'JetBrains Mono', monospace",
    }}>{grade}</div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: 'rgba(148,163,184,0.04)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: color ?? '#94a3b8', fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
    </div>
  )
}

type Winner = 'a' | 'b' | 'tie'

function winnerOf(a: number | null, b: number | null, lowerIsBetter = true): Winner | null {
  if (a == null || b == null) return null
  if (a === b) return 'tie'
  return lowerIsBetter ? (a < b ? 'a' : 'b') : (a > b ? 'a' : 'b')
}

function MetricRow({
  label, a, b, winner, fmt,
}: {
  label: string
  a: string | number | null
  b: string | number | null
  winner: Winner | null
  fmt?: (v: string | number | null) => string
}) {
  const f = fmt ?? ((v) => v == null ? '—' : typeof v === 'number' ? v.toLocaleString() : String(v))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 1fr', gap: 4, padding: '9px 0', borderBottom: '1px solid rgba(148,163,184,0.05)', alignItems: 'center' }}>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: winner === 'a' ? '#818cf8' : '#64748b', fontWeight: winner === 'a' ? 700 : 400, textAlign: 'right', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5 }}>
        {winner === 'a' && <span style={{ color: '#818cf8', fontSize: 10 }}>✓</span>}
        {f(a)}
      </div>
      <div style={{ textAlign: 'center', fontSize: 9, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 0.8 }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: winner === 'b' ? '#818cf8' : '#64748b', fontWeight: winner === 'b' ? 700 : 400, display: 'flex', alignItems: 'center', gap: 5 }}>
        {winner === 'b' && <span style={{ color: '#818cf8', fontSize: 10 }}>✓</span>}
        {f(b)}
      </div>
    </div>
  )
}

function VSPageInner() {
  const searchParams = useSearchParams()
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [stats, setStats] = useState<{ count?: number; median?: number; min?: number; max?: number } | null>(null)
  const [slugA, setSlugA] = useState(searchParams.get('a') ?? '')
  const [slugB, setSlugB] = useState(searchParams.get('b') ?? '')
  const [dataA, setDataA] = useState<CompanyDetail | null>(null)
  const [dataB, setDataB] = useState<CompanyDetail | null>(null)
  const [loadingA, setLoadingA] = useState(false)
  const [loadingB, setLoadingB] = useState(false)

  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/leaderboard`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setLeaderboard(d.filter(c => c.trajectory != null && isFinite(c.trajectory))) })
      .catch(() => {})
    fetch(`${TRUST_DEBT_API}/api/stats`)
      .then(r => r.json())
      .then(d => setStats(d?.latest ?? null))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!slugA) { setDataA(null); return }
    setLoadingA(true)
    fetch(`${TRUST_DEBT_API}/api/company/${slugA}`)
      .then(r => r.json()).then(setDataA).catch(() => {}).finally(() => setLoadingA(false))
  }, [slugA])

  useEffect(() => {
    if (!slugB) { setDataB(null); return }
    setLoadingB(true)
    fetch(`${TRUST_DEBT_API}/api/company/${slugB}`)
      .then(r => r.json()).then(setDataB).catch(() => {}).finally(() => setLoadingB(false))
  }, [slugB])

  const snap = (d: CompanyDetail | null): Snapshot => d?.latestSnapshot ?? {}

  const ttA = snap(dataA).trajectory ?? dataA?.company?.latestTrajectory ?? null
  const ttB = snap(dataB).trajectory ?? dataB?.company?.latestTrajectory ?? null
  const gradeA = dataA?.company?.latestGrade ?? null
  const gradeB = dataB?.company?.latestGrade ?? null
  const kevA = snap(dataA).kevCount ?? 0
  const kevB = snap(dataB).kevCount ?? 0
  const epssA = snap(dataA).epssHighCount ?? 0
  const epssB = snap(dataB).epssHighCount ?? 0
  const deltaA = snap(dataA).delta ?? null
  const deltaB = snap(dataB).delta ?? null
  const cveCountA = dataA?.company?.cveCount ?? null
  const cveCountB = dataB?.company?.cveCount ?? null
  const rankA = dataA?.company?.percentileRank ?? null
  const rankB = dataB?.company?.percentileRank ?? null

  const bothLoaded = !!(dataA && dataB && ttA != null && ttB != null)
  const verdict: Winner | null = bothLoaded ? winnerOf(ttA, ttB) : null
  const winnerName = verdict === 'a' ? dataA?.company.name : verdict === 'b' ? dataB?.company.name : null
  const loserName = verdict === 'a' ? dataB?.company.name : verdict === 'b' ? dataA?.company.name : null
  const pctBetter = bothLoaded && verdict !== 'tie' && ttA != null && ttB != null
    ? Math.round(Math.abs(ttA - ttB) / Math.max(ttA, ttB) * 100) : null

  const percA = PERCEIVED_TRUST[slugA]
  const percB = PERCEIVED_TRUST[slugB]
  const gapA = percA && gradeA && (gradeA === 'F' || gradeA === 'D')
  const gapB = percB && gradeB && (gradeB === 'F' || gradeB === 'D')

  const sorted = [...leaderboard].sort((a, b) => a.trajectory - b.trajectory)
  const best = sorted[0]
  const worst = sorted[sorted.length - 1]
  const trustGapCompanies = leaderboard.filter(c => {
    const p = PERCEIVED_TRUST[c.slug]
    return p && (p.level === 'Very High' || p.level === 'High') && (c.grade === 'F' || c.grade === 'D')
  })

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
        * { box-sizing: border-box; }
        select option { background: #1e293b; }
      `}</style>

      <div style={{ minHeight: '100vh', background: '#0b0f1a', color: '#e2e8f0', fontFamily: "'Space Grotesk', sans-serif" }}>
        <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', opacity: 0.03, backgroundImage: `linear-gradient(rgba(99,102,241,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(99,102,241,0.5) 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />

        <div style={{ maxWidth: 840, margin: '0 auto', padding: '40px 20px', position: 'relative' }}>

          {/* Nav */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginBottom: 24 }}>
            <Link href="/trust/" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 500, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none', background: 'transparent', border: '1px solid rgba(148,163,184,0.15)', padding: '5px 14px', borderRadius: 20, transition: 'all 0.15s' }}>
              ◆ Calculator
            </Link>
            <Link href="/trust/vs/" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: '#818cf8', fontFamily: "'JetBrains Mono', monospace", textDecoration: 'none', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.35)', padding: '5px 14px', borderRadius: 20 }}>
              ⚔ Compare
            </Link>
          </div>

          {/* Header */}
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h1 style={{ fontSize: 44, fontWeight: 800, margin: 0, background: 'linear-gradient(135deg, #e2e8f0, #6366f1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: -1.5 }}>
              Who Do You Trust More?
            </h1>
            <p style={{ color: '#475569', fontSize: 13, marginTop: 10, fontStyle: 'italic', fontFamily: "'JetBrains Mono', monospace" }}>
              Trust Debt head-to-head — pick two companies to compare
            </p>
          </div>

          {/* Company selectors */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 56px 1fr', gap: 12, marginBottom: 32, alignItems: 'end' }}>
            {/* Company A */}
            <div>
              <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Company A</div>
              <select
                value={slugA}
                onChange={e => setSlugA(e.target.value)}
                style={{ width: '100%', height: 48, borderRadius: 10, border: `1px solid ${slugA ? 'rgba(99,102,241,0.3)' : 'rgba(148,163,184,0.15)'}`, background: 'rgba(15,23,42,0.8)', color: slugA ? '#e2e8f0' : '#64748b', fontSize: 14, padding: '0 14px', fontFamily: "'Space Grotesk', sans-serif", cursor: 'pointer', outline: 'none' }}
              >
                <option value="">Select company...</option>
                {leaderboard.map(c => (
                  <option key={c.slug} value={c.slug} disabled={c.slug === slugB}>{c.name} — Grade {c.grade}</option>
                ))}
              </select>
            </div>
            {/* VS divider */}
            <div style={{ textAlign: 'center', fontSize: 15, fontWeight: 800, color: '#334155', fontFamily: "'JetBrains Mono', monospace", paddingBottom: 12 }}>VS</div>
            {/* Company B */}
            <div>
              <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>Company B</div>
              <select
                value={slugB}
                onChange={e => setSlugB(e.target.value)}
                style={{ width: '100%', height: 48, borderRadius: 10, border: `1px solid ${slugB ? 'rgba(99,102,241,0.3)' : 'rgba(148,163,184,0.15)'}`, background: 'rgba(15,23,42,0.8)', color: slugB ? '#e2e8f0' : '#64748b', fontSize: 14, padding: '0 14px', fontFamily: "'Space Grotesk', sans-serif", cursor: 'pointer', outline: 'none' }}
              >
                <option value="">Select company...</option>
                {leaderboard.map(c => (
                  <option key={c.slug} value={c.slug} disabled={c.slug === slugA}>{c.name} — Grade {c.grade}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Loading indicator */}
          {(loadingA || loadingB) && (
            <div style={{ textAlign: 'center', color: '#475569', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", marginBottom: 24 }}>
              Loading...
            </div>
          )}

          {/* Verdict + comparison */}
          {bothLoaded && (
            <div style={{ animation: 'fadeSlideIn 0.35s ease' }}>

              {/* Verdict banner */}
              <div style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 16, padding: '22px 28px', marginBottom: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#6366f1', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 2, marginBottom: 10 }}>Trust Verdict</div>
                {verdict === 'tie' ? (
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#94a3b8' }}>It&apos;s a tie — both carry equal risk</div>
                ) : (
                  <>
                    <div style={{ fontSize: 26, fontWeight: 800, color: '#e2e8f0' }}>
                      Trust <span style={{ color: '#818cf8' }}>{winnerName}</span> more
                    </div>
                    <div style={{ fontSize: 13, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", marginTop: 6 }}>
                      {pctBetter}% less Trust Debt than {loserName}
                    </div>
                  </>
                )}
              </div>

              {/* Side-by-side cards */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                {([dataA, dataB] as const).map((data, idx) => {
                  const side: Winner = idx === 0 ? 'a' : 'b'
                  const tt = idx === 0 ? ttA : ttB
                  const grade = idx === 0 ? gradeA : gradeB
                  const kev = idx === 0 ? kevA : kevB
                  const epss = idx === 0 ? epssA : epssB
                  const delta = idx === 0 ? deltaA : deltaB
                  const cveCount = idx === 0 ? cveCountA : cveCountB
                  const rank = idx === 0 ? rankA : rankB
                  const gap = idx === 0 ? gapA : gapB
                  const perc = idx === 0 ? percA : percB
                  const isWinner = verdict === side
                  return (
                    <div key={side} style={{ background: isWinner ? 'rgba(99,102,241,0.06)' : 'rgba(15,23,42,0.8)', border: isWinner ? '1px solid rgba(99,102,241,0.3)' : '1px solid rgba(148,163,184,0.08)', borderRadius: 16, padding: 22, position: 'relative' }}>
                      {isWinner && (
                        <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: '#6366f1', color: '#fff', fontSize: 9, fontWeight: 700, padding: '3px 12px', borderRadius: 10, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, whiteSpace: 'nowrap' }}>MORE TRUSTED</div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                        <GradeBadge grade={grade ?? '?'} size={50} />
                        <div>
                          <div style={{ fontSize: 17, fontWeight: 700, color: '#e2e8f0' }}>{data?.company.name}</div>
                          <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
                            {rank != null ? `#${rank} of ${leaderboard.length} tracked` : `${leaderboard.length} tracked`}
                          </div>
                        </div>
                      </div>
                      <div style={{ fontSize: 34, fontWeight: 800, color: '#e2e8f0', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", marginBottom: 4 }}>
                        {(tt ?? 0).toLocaleString()}
                      </div>
                      <div style={{ fontSize: 9, color: '#334155', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 14 }}>Trust Trajectory</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                        <Stat label="CVEs" value={(cveCount ?? 0).toLocaleString()} />
                        <Stat label="Trend Δ" value={delta != null ? `${delta.toFixed(2)}×` : '—'} color={delta != null && delta > 1.05 ? '#ff6d00' : delta != null && delta < 0.95 ? '#00c853' : undefined} />
                        <Stat label="KEV hits" value={String(kev)} color={kev > 0 ? '#ff1744' : '#475569'} />
                        <Stat label="High EPSS" value={String(epss)} color={epss > 0 ? '#ff6d00' : '#475569'} />
                      </div>
                      {gap && perc && (
                        <div style={{ marginTop: 12, padding: '7px 10px', borderRadius: 8, background: 'rgba(255,193,0,0.05)', border: '1px solid rgba(255,193,0,0.2)', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#ffc400', fontFamily: "'JetBrains Mono', monospace" }}>⚠ TRUST GAP</span>
                          <span style={{ fontSize: 10, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{perc.reason} · Grade {grade}</span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Head-to-head table */}
              <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: '16px 20px', marginBottom: 28 }}>
                <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>Head-to-Head</div>
                <MetricRow label="Trust Trajectory" a={ttA} b={ttB} winner={winnerOf(ttA, ttB)} />
                <MetricRow label="Grade" a={gradeA} b={gradeB} winner={null} fmt={v => String(v ?? '—')} />
                <MetricRow label="Peer Rank" a={rankA != null ? `#${rankA}` : null} b={rankB != null ? `#${rankB}` : null} winner={winnerOf(rankA, rankB)} fmt={v => String(v ?? '—')} />
                <MetricRow label="CVE Count" a={cveCountA} b={cveCountB} winner={winnerOf(cveCountA, cveCountB)} />
                <MetricRow label="KEV Hits" a={kevA} b={kevB} winner={winnerOf(kevA, kevB)} />
                <MetricRow label="High EPSS" a={epssA} b={epssB} winner={winnerOf(epssA, epssB)} />
                <MetricRow label="Trend Δ" a={deltaA} b={deltaB} winner={winnerOf(deltaA, deltaB)} fmt={v => v != null ? `${(v as number).toFixed(2)}×` : '—'} />
              </div>
            </div>
          )}

          {/* Insights panel — always visible */}
          <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: '20px 24px', marginBottom: 24 }}>
            <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, fontFamily: "'JetBrains Mono', monospace", marginBottom: 16 }}>Leaderboard Insights</div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: trustGapCompanies.length > 0 ? 20 : 0 }}>
              {[
                { label: 'Most Trusted', value: best?.name ?? '—', sub: `Grade ${best?.grade ?? '—'}`, color: GRADE_COLOR[best?.grade ?? ''] ?? '#64748b' },
                { label: 'Least Trusted', value: worst?.name ?? '—', sub: `Grade ${worst?.grade ?? '—'}`, color: GRADE_COLOR[worst?.grade ?? ''] ?? '#64748b' },
                { label: 'Median TT Score', value: stats?.median != null ? stats.median.toLocaleString() : '—', sub: `${stats?.count ?? 0} companies`, color: '#818cf8' },
              ].map(({ label, value, sub, color }) => (
                <div key={label} style={{ background: 'rgba(148,163,184,0.03)', borderRadius: 8, padding: '14px 16px', textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1, marginBottom: 6 }}>{label}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color }}>{value}</div>
                  <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{sub}</div>
                </div>
              ))}
            </div>

            {trustGapCompanies.length > 0 && (
              <>
                <div style={{ fontSize: 10, color: '#ffc400', fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
                  ⚠ Trust Gap — widely trusted, but their data says otherwise
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {trustGapCompanies.map(c => {
                    const p = PERCEIVED_TRUST[c.slug]
                    return (
                      <div key={c.slug} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'rgba(255,193,0,0.04)', border: '1px solid rgba(255,193,0,0.15)', borderRadius: 8, padding: '6px 12px' }}>
                        <span style={{ fontSize: 11, color: '#94a3b8' }}>{c.name}</span>
                        <span style={{ fontSize: 9, color: '#ffc400', fontFamily: "'JetBrains Mono', monospace" }}>{p?.reason}</span>
                        <span style={{ fontSize: 9, fontWeight: 700, color: GRADE_COLOR[c.grade], background: `${GRADE_COLOR[c.grade]}15`, padding: '1px 6px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace" }}>{c.grade}</span>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Full ranked leaderboard */}
          {leaderboard.length > 0 && (
            <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: '20px 24px' }}>
              <div style={{ fontSize: 10, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, fontFamily: "'JetBrains Mono', monospace", marginBottom: 14 }}>All Tracked Companies</div>
              <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 54px 100px 60px', gap: 8, padding: '0 0 8px', borderBottom: '1px solid rgba(148,163,184,0.08)', marginBottom: 4 }}>
                {['#', 'Company', 'Grade', 'TT Score', 'Pct'].map((h, i) => (
                  <span key={i} style={{ fontSize: 9, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 0.8, textAlign: i >= 2 ? 'right' : 'left' }}>{h}</span>
                ))}
              </div>
              {sorted.map((c, i) => (
                <div key={c.slug} style={{ display: 'grid', gridTemplateColumns: '28px 1fr 54px 100px 60px', gap: 8, padding: '8px 0', borderBottom: '1px solid rgba(148,163,184,0.04)', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#334155', fontFamily: "'JetBrains Mono', monospace" }}>#{i + 1}</span>
                  <span style={{ fontSize: 13, color: '#cbd5e1', fontWeight: 500 }}>{c.name}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: GRADE_COLOR[c.grade] ?? '#64748b', fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}>{c.grade}</span>
                  <span style={{ fontSize: 11, color: '#64748b', fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}>{c.trajectory.toLocaleString()}</span>
                  <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}>{c.percentileRank != null ? `p${c.percentileRank}` : '—'}</span>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
    </>
  )
}

export default function VSPage() {
  return (
    <Suspense>
      <VSPageInner />
    </Suspense>
  )
}
