'use client'

import { useState, useEffect, Suspense } from 'react'

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
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [pairA, setPairA] = useState<LeaderboardEntry | null>(null)
  const [pairB, setPairB] = useState<LeaderboardEntry | null>(null)
  const [dataA, setDataA] = useState<CompanyDetail | null>(null)
  const [dataB, setDataB] = useState<CompanyDetail | null>(null)
  const [loadingA, setLoadingA] = useState(false)
  const [loadingB, setLoadingB] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [voteState, setVoteState] = useState<'idle' | 'submitting' | 'voted'>('idle')
  const [matchupVotes, setMatchupVotes] = useState<{ aWins: number; bWins: number; total: number } | null>(null)
  const [vendorVotesA, setVendorVotesA] = useState<{ wins: number; losses: number } | null>(null)
  const [vendorVotesB, setVendorVotesB] = useState<{ wins: number; losses: number } | null>(null)
  const [myVote, setMyVote] = useState<string | null>(null)
  const [sbdpSlugs, setSbdpSlugs] = useState<string[]>([])

  const slugA = pairA?.slug ?? ''
  const slugB = pairB?.slug ?? ''
  const revealed = voteState === 'voted'

  function pickNewMatchup(board: LeaderboardEntry[]) {
    if (board.length < 2) return
    setVoteState('idle')
    setMatchupVotes(null)
    setVendorVotesA(null)
    setVendorVotesB(null)
    setMyVote(null)
    // Try up to 10 times to find a pair the user hasn't voted on yet
    for (let i = 0; i < 10; i++) {
      const idx1 = Math.floor(Math.random() * board.length)
      let idx2 = Math.floor(Math.random() * (board.length - 1))
      if (idx2 >= idx1) idx2++
      const a = board[idx1], b = board[idx2]
      const [sA, sB] = [a.slug, b.slug].sort()
      if (!localStorage.getItem(`trust-vote-${sA}--${sB}`)) {
        setPairA(a); setPairB(b); return
      }
    }
    // All tries already voted — pick random anyway and show reveal
    const idx1 = Math.floor(Math.random() * board.length)
    let idx2 = Math.floor(Math.random() * (board.length - 1))
    if (idx2 >= idx1) idx2++
    setPairA(board[idx1]); setPairB(board[idx2])
  }

  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/cisa/sbdp`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.slugs)) setSbdpSlugs(d.slugs) })
      .catch(() => {})
  }, [])

  const isSBDP = (slug: string) => sbdpSlugs.some(s => s === slug || s.startsWith(slug + '-') || slug.startsWith(s + '-'))

  useEffect(() => {
    fetch(`${TRUST_DEBT_API}/api/leaderboard`)
      .then(r => r.json())
      .then(d => {
        if (Array.isArray(d)) {
          const board = d.filter((c: LeaderboardEntry) => c.trajectory != null && isFinite(c.trajectory))
          setLeaderboard(board)
          pickNewMatchup(board)
        }
      })
      .catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

  // Reset vote when either slug changes
  useEffect(() => {
    setVoteState('idle')
    setMatchupVotes(null)
    setVendorVotesA(null)
    setVendorVotesB(null)
    setMyVote(null)
  }, [slugA, slugB])

  // Load vote data once both companies are loaded
  useEffect(() => {
    if (!dataA || !dataB || !slugA || !slugB) return
    const [sA, sB] = [slugA, slugB].sort()
    const lsKey = `trust-vote-${sA}--${sB}`
    const stored = localStorage.getItem(lsKey)
    if (stored) { setMyVote(stored); setVoteState('voted') }
    fetch(`${TRUST_DEBT_API}/api/matchup/${slugA}/${slugB}`)
      .then(r => r.json()).then(setMatchupVotes).catch(() => {})
    Promise.all([
      fetch(`${TRUST_DEBT_API}/api/votes/${slugA}`).then(r => r.json()),
      fetch(`${TRUST_DEBT_API}/api/votes/${slugB}`).then(r => r.json()),
    ]).then(([a, b]) => { setVendorVotesA(a); setVendorVotesB(b) }).catch(() => {})
  }, [dataA, dataB, slugA, slugB])

  async function submitVote(side: 'a' | 'b') {
    if (voteState !== 'idle') return
    setVoteState('submitting')
    const winnerSlug = side === 'a' ? slugA : slugB
    const [sA, sB] = [slugA, slugB].sort()
    try {
      await fetch(`${TRUST_DEBT_API}/api/votes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ a: slugA, b: slugB, winner: winnerSlug }),
      })
      localStorage.setItem(`trust-vote-${sA}--${sB}`, winnerSlug)
      setMyVote(winnerSlug)
      setVoteState('voted')
      // Refresh both matchup and vendor tallies
      const [mv, va, vb] = await Promise.all([
        fetch(`${TRUST_DEBT_API}/api/matchup/${slugA}/${slugB}`).then(r => r.json()),
        fetch(`${TRUST_DEBT_API}/api/votes/${slugA}`).then(r => r.json()),
        fetch(`${TRUST_DEBT_API}/api/votes/${slugB}`).then(r => r.json()),
      ])
      setMatchupVotes(mv)
      setVendorVotesA(va)
      setVendorVotesB(vb)
    } catch { setVoteState('idle') }
  }

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

        <header className="site-header">
          <a href="/" className="site-logo" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <img src="/images/fake-bobby-logo.png" alt="Fake Bobby" style={{ width: 22, height: 22, objectFit: 'contain', filter: 'drop-shadow(0 0 4px #ff174460)' }} />
            Fake Healthcare Experts
          </a>
          <nav>
            <ul className="nav-links">
              <li><a href="/trust/">◆ Calculator</a></li>
              <li><a href="/trust/vs/" style={{ color: '#818cf8', fontWeight: 700 }}>⚔ Compare</a></li>
            </ul>
          </nav>
          <button className="hamburger" onClick={() => setMenuOpen(v => !v)} aria-label="Toggle menu">
            <span /><span /><span />
          </button>
        </header>
        <div className={`mobile-menu${menuOpen ? ' open' : ''}`}>
          <ul>
            <li><a href="/" onClick={() => setMenuOpen(false)}>← Home</a></li>
            <li><a href="/trust/" onClick={() => setMenuOpen(false)}>◆ Calculator</a></li>
            <li><a href="/trust/vs/" onClick={() => setMenuOpen(false)} style={{ color: '#818cf8' }}>⚔ Compare</a></li>
          </ul>
        </div>

        <div style={{ maxWidth: 840, margin: '0 auto', padding: '88px 20px 40px', position: 'relative' }}>

          {/* Page title */}
          <div style={{ textAlign: 'center', marginBottom: 40 }}>
            <h1 style={{ fontSize: 44, fontWeight: 800, margin: 0, background: 'linear-gradient(135deg, #e2e8f0, #6366f1)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', letterSpacing: -1.5 }}>
              Trust or Bust
            </h1>
            <p style={{ color: '#475569', fontSize: 13, marginTop: 10, fontFamily: "'JetBrains Mono', monospace" }}>
              Vote on gut instinct. The data reveals after.
            </p>
          </div>

          {/* Loading state */}
          {!pairA && (
            <div style={{ textAlign: 'center', color: '#334155', fontSize: 12, fontFamily: "'JetBrains Mono', monospace", padding: '60px 0', animation: 'pulse 1.5s infinite' }}>
              Loading matchups...
            </div>
          )}

          {/* Blind vote — shown before voting */}
          {pairA && pairB && !revealed && (
            <div style={{ marginBottom: 32, animation: 'fadeSlideIn 0.3s ease' }}>
              <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 2, textAlign: 'center', marginBottom: 28 }}>
                Random matchup · {leaderboard.length} companies tracked
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 48px 1fr', gap: 16, alignItems: 'stretch' }}>
                <button
                  onClick={() => submitVote('a')}
                  disabled={voteState === 'submitting'}
                  style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: 16, padding: '36px 24px', cursor: voteState === 'submitting' ? 'wait' : 'pointer', color: '#e2e8f0', transition: 'all 0.2s', textAlign: 'center', fontFamily: "'Space Grotesk', sans-serif", outline: 'none', display: 'block', width: '100%' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.12)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,102,241,0.4)'; (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.05)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,102,241,0.18)'; (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)' }}
                >
                  <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 14 }}>I trust</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#c7d2fe', marginBottom: 14, lineHeight: 1.2 }}>{pairA.name}</div>
                  <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace" }}>more with my data →</div>
                </button>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: '#1e293b', fontFamily: "'JetBrains Mono', monospace" }}>VS</div>
                <button
                  onClick={() => submitVote('b')}
                  disabled={voteState === 'submitting'}
                  style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.18)', borderRadius: 16, padding: '36px 24px', cursor: voteState === 'submitting' ? 'wait' : 'pointer', color: '#e2e8f0', transition: 'all 0.2s', textAlign: 'center', fontFamily: "'Space Grotesk', sans-serif", outline: 'none', display: 'block', width: '100%' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.12)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,102,241,0.4)'; (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.05)'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(99,102,241,0.18)'; (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)' }}
                >
                  <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 14 }}>I trust</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: '#c7d2fe', marginBottom: 14, lineHeight: 1.2 }}>{pairB.name}</div>
                  <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace" }}>← more with my data</div>
                </button>
              </div>
            </div>
          )}

          {/* Reveal — shown after voting */}
          {pairA && pairB && revealed && (
            <div style={{ animation: 'fadeSlideIn 0.4s ease', marginBottom: 32 }}>

              {/* Your choice */}
              <div style={{ textAlign: 'center', marginBottom: 28 }}>
                <div style={{ fontSize: 10, color: '#6366f1', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>You chose</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#818cf8' }}>{myVote === slugA ? pairA.name : pairB.name}</div>
              </div>

              {/* Grade + TT cards */}
              {(loadingA || loadingB) ? (
                <div style={{ textAlign: 'center', color: '#334155', fontSize: 11, fontFamily: "'JetBrains Mono', monospace", padding: '24px 0', animation: 'pulse 1.5s infinite' }}>Fetching comparison data...</div>
              ) : dataA && dataB ? (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 16 }}>
                    {([
                      { pair: pairA, data: dataA, tt: ttA, grade: gradeA, kev: kevA, epss: epssA, delta: deltaA, cveCount: cveCountA, rank: rankA, slug: slugA, gap: gapA, perc: percA, side: 'a' as Winner },
                      { pair: pairB, data: dataB, tt: ttB, grade: gradeB, kev: kevB, epss: epssB, delta: deltaB, cveCount: cveCountB, rank: rankB, slug: slugB, gap: gapB, perc: percB, side: 'b' as Winner },
                    ]).map(({ pair, tt, grade, kev, epss, delta, cveCount, rank, slug, gap, perc, side }) => {
                      const isWinner = verdict === side
                      const isMyPick = myVote === (side === 'a' ? slugA : slugB)
                      return (
                        <div key={side} style={{ background: isWinner ? 'rgba(99,102,241,0.07)' : 'rgba(15,23,42,0.8)', border: `1px solid ${isWinner ? 'rgba(99,102,241,0.3)' : 'rgba(148,163,184,0.08)'}`, borderRadius: 14, padding: 20, position: 'relative' }}>
                          {isWinner && <div style={{ position: 'absolute', top: -10, left: '50%', transform: 'translateX(-50%)', background: '#6366f1', color: '#fff', fontSize: 9, fontWeight: 700, padding: '3px 12px', borderRadius: 10, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, whiteSpace: 'nowrap' }}>DATA SAYS TRUST MORE</div>}
                          {isMyPick && <div style={{ position: 'absolute', top: -10, right: 16, background: '#334155', color: '#818cf8', fontSize: 9, fontWeight: 700, padding: '3px 10px', borderRadius: 10, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 1, whiteSpace: 'nowrap' }}>YOUR PICK</div>}
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 14, textAlign: 'center' }}>
                            <GradeBadge grade={grade ?? '?'} size={48} />
                            <div style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>{pair.name}</div>
                            <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{rank != null ? `#${rank} of ${leaderboard.length}` : `${leaderboard.length} tracked`}</div>
                            {isSBDP(slug) && <span style={{ fontSize: 9, fontWeight: 700, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.25)', padding: '2px 8px', borderRadius: 4, fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>CISA SBDP ✓</span>}
                          </div>
                          <div style={{ fontSize: 30, fontWeight: 800, color: '#e2e8f0', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", marginBottom: 3 }}>{(tt ?? 0).toLocaleString()}</div>
                          <div style={{ fontSize: 9, color: '#334155', textAlign: 'center', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 12 }}>Trust Trajectory</div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                            <Stat label="CVEs" value={(cveCount ?? 0).toLocaleString()} />
                            <Stat label="Trend Δ" value={delta != null ? `${delta.toFixed(2)}×` : '—'} color={delta != null && delta > 1.05 ? '#ff6d00' : delta != null && delta < 0.95 ? '#00c853' : undefined} />
                            <Stat label="KEV hits" value={String(kev)} color={kev > 0 ? '#ff1744' : '#475569'} />
                            <Stat label="High EPSS" value={String(epss)} color={epss > 0 ? '#ff6d00' : '#475569'} />
                          </div>
                          {gap && perc && (
                            <div style={{ marginTop: 10, padding: '6px 10px', borderRadius: 7, background: 'rgba(255,193,0,0.05)', border: '1px solid rgba(255,193,0,0.2)', display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontSize: 9, fontWeight: 700, color: '#ffc400', fontFamily: "'JetBrains Mono', monospace" }}>⚠ TRUST GAP</span>
                              <span style={{ fontSize: 9, color: '#64748b', fontFamily: "'JetBrains Mono', monospace" }}>{perc.reason}</span>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Data verdict */}
                  <div style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: 12, padding: '16px 20px', marginBottom: 14 }}>
                    <div style={{ fontSize: 10, color: '#6366f1', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 2, marginBottom: 8 }}>Data Says</div>
                    {verdict === 'tie' ? (
                      <div style={{ fontSize: 16, fontWeight: 700, color: '#94a3b8' }}>Equal risk — both carry the same Trust Debt</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 18, fontWeight: 800, color: '#e2e8f0' }}>Trust <span style={{ color: '#818cf8' }}>{winnerName}</span> more</div>
                        {pctBetter && <div style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{winnerName} carries {pctBetter}% less Trust Debt than {loserName}</div>}
                      </>
                    )}
                  </div>

                  {/* Head-to-head detail */}
                  <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.07)', borderRadius: 12, padding: '14px 18px', marginBottom: 14 }}>
                    <div style={{ fontSize: 9, color: '#334155', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, fontFamily: "'JetBrains Mono', monospace", marginBottom: 10 }}>
                      <span style={{ color: '#64748b' }}>{pairA.name}</span>
                      <span style={{ margin: '0 12px', color: '#1e293b' }}>vs</span>
                      <span style={{ color: '#64748b' }}>{pairB.name}</span>
                    </div>
                    <MetricRow label="Trust Trajectory" a={ttA} b={ttB} winner={winnerOf(ttA, ttB)} />
                    <MetricRow label="Grade" a={gradeA} b={gradeB} winner={null} fmt={v => String(v ?? '—')} />
                    <MetricRow label="Peer Rank" a={rankA != null ? `#${rankA}` : null} b={rankB != null ? `#${rankB}` : null} winner={winnerOf(rankA, rankB)} fmt={v => String(v ?? '—')} />
                    <MetricRow label="CVE Count" a={cveCountA} b={cveCountB} winner={winnerOf(cveCountA, cveCountB)} />
                    <MetricRow label="KEV Hits" a={kevA} b={kevB} winner={winnerOf(kevA, kevB)} />
                    <MetricRow label="High EPSS" a={epssA} b={epssB} winner={winnerOf(epssA, epssB)} />
                    <MetricRow label="Trend Δ" a={deltaA} b={deltaB} winner={winnerOf(deltaA, deltaB)} fmt={v => v != null ? `${(v as number).toFixed(2)}×` : '—'} />
                  </div>
                </>
              ) : null}

              {/* Crowd verdict */}
              <div style={{ background: 'rgba(15,23,42,0.8)', border: '1px solid rgba(148,163,184,0.08)', borderRadius: 12, padding: '18px 20px', marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: '#475569', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 2, marginBottom: 14 }}>Crowd Says</div>

                {/* This matchup */}
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>
                    This matchup{matchupVotes ? ` · ${matchupVotes.total.toLocaleString()} vote${matchupVotes.total !== 1 ? 's' : ''}` : ''}
                  </div>
                  {matchupVotes && matchupVotes.total > 0 ? (
                    [
                      { slug: slugA, name: pairA.name, wins: matchupVotes.aWins },
                      { slug: slugB, name: pairB.name, wins: matchupVotes.bWins },
                    ].map(({ slug, name, wins }) => {
                      const pct = Math.round((wins / matchupVotes.total) * 100)
                      const isMyVote = myVote === slug
                      return (
                        <div key={slug} style={{ marginBottom: 10 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                            <span style={{ fontSize: 12, color: isMyVote ? '#e2e8f0' : '#64748b', fontWeight: isMyVote ? 700 : 400 }}>{name}{isMyVote ? ' ← your pick' : ''}</span>
                            <span style={{ fontSize: 11, color: '#475569', fontFamily: "'JetBrains Mono', monospace" }}>{pct}%</span>
                          </div>
                          <div style={{ height: 5, background: 'rgba(148,163,184,0.07)', borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${pct}%`, background: isMyVote ? '#6366f1' : 'rgba(99,102,241,0.2)', borderRadius: 3, transition: 'width 0.7s ease' }} />
                          </div>
                        </div>
                      )
                    })
                  ) : (
                    <div style={{ fontSize: 11, color: '#334155', fontFamily: "'JetBrains Mono', monospace" }}>You&apos;re the first to vote on this matchup.</div>
                  )}
                </div>

                {/* Overall records */}
                {(vendorVotesA || vendorVotesB) && (
                  <div style={{ paddingTop: 14, borderTop: '1px solid rgba(148,163,184,0.05)' }}>
                    <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>All-time record (all matchups)</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      {[
                        { name: pairA.name, v: vendorVotesA },
                        { name: pairB.name, v: vendorVotesB },
                      ].map(({ name, v }) => {
                        const w = v?.wins ?? 0, l = v?.losses ?? 0, total = w + l
                        const winPct = total > 0 ? Math.round((w / total) * 100) : null
                        return (
                          <div key={name} style={{ background: 'rgba(148,163,184,0.03)', borderRadius: 8, padding: '10px 12px' }}>
                            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 6, fontWeight: 600 }}>{name}</div>
                            <div style={{ fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>
                              <span style={{ color: '#00c853' }}>{w.toLocaleString()}W</span>
                              <span style={{ color: '#1e293b', margin: '0 6px' }}>·</span>
                              <span style={{ color: '#ff4d4d' }}>{l.toLocaleString()}L</span>
                            </div>
                            {winPct !== null && (
                              <div style={{ fontSize: 10, color: '#334155', fontFamily: "'JetBrains Mono', monospace", marginTop: 3 }}>{winPct}% win rate · {total} matchup{total !== 1 ? 's' : ''}</div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Next matchup button */}
              <div style={{ textAlign: 'center' }}>
                <button
                  onClick={() => pickNewMatchup(leaderboard)}
                  style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.25)', borderRadius: 10, padding: '12px 28px', cursor: 'pointer', color: '#818cf8', fontSize: 14, fontWeight: 700, fontFamily: "'Space Grotesk', sans-serif", transition: 'all 0.2s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.18)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(99,102,241,0.1)' }}
                >
                  Next Matchup →
                </button>
              </div>

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
