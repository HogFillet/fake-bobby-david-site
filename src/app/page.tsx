'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import SplashOverlay from './components/SplashOverlay'

// ── Firebase analytics (fire-and-forget) ─────────────────────────────────────
async function initFirebase(setCount: (n: number) => void) {
  try {
    const { initializeApp, getApps } = await import('firebase/app')
    const { getDatabase, ref, runTransaction } = await import('firebase/database')

    const pid = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    const config = {
      apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
      authDomain: `${pid}.firebaseapp.com`,
      databaseURL: `https://${pid}-default-rtdb.firebaseio.com`,
      projectId: pid,
      storageBucket: `${pid}.appspot.com`,
      messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    }

    // Avoid double-init in dev HMR
    const app = getApps().length ? getApps()[0] : initializeApp(config)
    const db = getDatabase(app)
    const inc = (path: string) =>
      runTransaction(ref(db, path), (n) => (n || 0) + 1).catch(() => {})

    // Total visitor count
    const result = await runTransaction(ref(db, 'visitors/count'), (n) => (n || 0) + 1)
    setCount(result.snapshot.val() ?? 1)

    // Unique visitors
    if (!localStorage.getItem('_fbuniq')) {
      localStorage.setItem('_fbuniq', '1')
      inc('visitors/unique')
    }

    inc('pages/home')
    inc(/Mobi|Android/i.test(navigator.userAgent) ? 'devices/mobile' : 'devices/desktop')

    const referrer = (() => {
      if (!document.referrer) return 'direct'
      try {
        const h = new URL(document.referrer).hostname
        if (h.includes('google')) return 'google'
        if (h.includes('github')) return 'github'
        if (h.includes('twitter') || h.includes('x.com')) return 'twitter'
        return 'other'
      } catch {
        return 'other'
      }
    })()
    inc('referrers/' + referrer)
  } catch {
    // Firebase unavailable (env vars not set locally) — silent fail
  }
}

// ── Animated counter hook ─────────────────────────────────────────────────────
function useCountUp(target: number | null, active: boolean) {
  const [display, setDisplay] = useState('0')
  useEffect(() => {
    if (target === null || !active) return
    let n = 0
    const step = target / (2000 / 16)
    const id = setInterval(() => {
      n += step
      if (n < target) {
        setDisplay(Math.floor(n).toLocaleString())
      } else {
        setDisplay(Math.floor(target).toLocaleString())
        clearInterval(id)
      }
    }, 16)
    return () => clearInterval(id)
  }, [target, active])
  return display
}

export default function HomePage() {
  const [visitorCount, setVisitorCount] = useState<number | null>(null)
  const [statsVisible, setStatsVisible] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const statsRef = useRef<HTMLElement>(null)

  const visitorDisplay = useCountUp(visitorCount, statsVisible)

  // Firebase init on mount
  useEffect(() => {
    initFirebase(setVisitorCount)
  }, [])

  // Intersection observer for stats counter + reveal animations
  useEffect(() => {
    // Stats section visibility
    const statsObs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setStatsVisible(true)
          statsObs.disconnect()
        }
      },
      { threshold: 0.3 },
    )
    if (statsRef.current) statsObs.observe(statsRef.current)

    // Reveal animations
    const revealObs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add('active')
        })
      },
      { threshold: 0.15 },
    )
    document.querySelectorAll('.reveal').forEach((el) => revealObs.observe(el))

    return () => {
      statsObs.disconnect()
      revealObs.disconnect()
    }
  }, [])

  const handleStoreClick = useCallback(
    async (product: string) => {
      try {
        const { getApps } = await import('firebase/app')
        const { getDatabase, ref, runTransaction } = await import('firebase/database')
        if (!getApps().length) return
        const db = getDatabase(getApps()[0])
        runTransaction(ref(db, 'store/' + product), (n) => (n || 0) + 1).catch(() => {})
      } catch {}
    },
    [],
  )

  return (
    <>
      <SplashOverlay />

      {/* ── Navigation ──────────────────────────────────────────────────── */}
      <header className="site-header">
        <a href="#home" className="site-logo">Fake Healthcare Experts</a>
        <nav>
          <ul className="nav-links">
            <li><a href="#home">Home</a></li>
            <li><a href="#characters">Meet The Fakes</a></li>
            <li><a href="#stats">Stats</a></li>
            <li><a href="#store">Store</a></li>
            <li><a href="#contact">Contact</a></li>
            <li className="nav-external"><a href="/blog.html">Journal</a></li>
          </ul>
        </nav>
        <button
          className="hamburger"
          aria-label="Toggle menu"
          onClick={() => setMobileMenuOpen((v) => !v)}
        >
          <span /><span /><span />
        </button>
      </header>

      <div className={`mobile-menu${mobileMenuOpen ? ' open' : ''}`}>
        <ul>
          {['#home', '#characters', '#stats', '#store', '#contact'].map((href) => (
            <li key={href}>
              <a href={href} onClick={() => setMobileMenuOpen(false)}>
                {href.replace('#', '').replace(/^\w/, (c) => c.toUpperCase())}
              </a>
            </li>
          ))}
          <li><a href="/blog.html" onClick={() => setMobileMenuOpen(false)}>Journal</a></li>
        </ul>
      </div>

      <main>
        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <div className="hero" id="home">
          <div className="comic-background">
            <div className="comic-overlay" />
            <div className="comic-speech-bubble speech-bubble-1">
              <p>&ldquo;Trust me, I&apos;m a statue!&rdquo;</p>
            </div>
            <div className="comic-speech-bubble speech-bubble-2">
              <p>&ldquo;I&apos;m clearly labeled FAKE!&rdquo;</p>
            </div>
            <div className="comic-speech-bubble speech-bubble-3">
              <p>&ldquo;I&apos;m a puppet with strings!&rdquo;</p>
            </div>
          </div>
          <div className="container">
            <div className="hero-content">
              <h1>Meet Your &ldquo;Healthcare Experts&rdquo;</h1>
              <p>Where statues, cartoons, and puppets give questionable health advice!</p>
              <div className="thank-you">
                <p><strong>Thank you for visiting our parody site!</strong></p>
                <p>Remember: This is satire. Don&apos;t fall for phishing or fake health advice online.</p>
                <p className="phishing-warning">
                  ⚠️ BEWARE: Real phishing sites don&apos;t announce they&apos;re fake. Always verify
                  healthcare information with legitimate sources!
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Characters ────────────────────────────────────────────────── */}
        <section className="section characters" id="characters">
          <div className="section-content">
            <div className="character-grid">
              {[
                {
                  img: '/images/fake-david.png',
                  alt: 'Fake David Statue',
                  name: 'Fake David',
                  desc: 'Our marble statue expert on ancient medical practices. He\'s been practicing medicine since the Renaissance, which might explain his outdated advice.',
                },
                {
                  img: '/images/fake-bobby.png',
                  alt: 'Fake Bobby Cartoon',
                  name: 'Fake Bobby',
                  desc: 'Not a real doctor, but plays one on our website. His medical license is about as authentic as his drawn-on stethoscope.',
                },
                {
                  img: '/images/fake-tommy.png',
                  alt: 'Fake Tommy Puppet',
                  name: 'Fake Tommy',
                  desc: 'Our newest team member! A puppet who claims to have studied at "Stringology University." His medical advice is controlled by invisible hands (literally).',
                },
              ].map((char, i) => (
                <div key={char.name} className={`character-card reveal${i > 0 ? ` reveal-delay-${i}` : ''}`}>
                  <div className="character-img-container">
                    <Image
                      src={char.img}
                      alt={char.alt}
                      width={300}
                      height={280}
                      className="character-img"
                      style={{ objectFit: 'contain' }}
                    />
                  </div>
                  <div className="character-info">
                    <h2 className="character-name">{char.name}</h2>
                    <p className="character-description">{char.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Stats ─────────────────────────────────────────────────────── */}
        <section className="section stats" id="stats" ref={statsRef}>
          <div className="section-content">
            <div className="stats-grid">
              <div className="stat-card reveal">
                <div className="stat-number">{visitorCount !== null ? visitorDisplay : '—'}</div>
                <div className="stat-label">Actual Visitors To This Page</div>
              </div>
              <div className="stat-card reveal reveal-delay-1">
                <div className="stat-number">514</div>
                <div className="stat-label">Years Since Fake David Went to Medical School</div>
              </div>
              <div className="stat-card reveal reveal-delay-2">
                <div className="stat-number">0</div>
                <div className="stat-label">Actual Medical Qualifications</div>
              </div>
              <div className="stat-card reveal reveal-delay-3">
                <div className="stat-number">3</div>
                <div className="stat-label">Fake &ldquo;Experts&rdquo; On This Site</div>
              </div>
            </div>
          </div>
        </section>

        {/* ── Store ─────────────────────────────────────────────────────── */}
        <section className="section store" id="store">
          <div className="section-content">
            <h2 className="store-title reveal">SWAG — Fake Bobby — Fake David — Fake Tommy — SWAG</h2>
            <div className="store-grid">
              {[
                { img: '/images/products/product_bobby_tshirt.png', name: 'Fake Bobby T-Shirt', price: '$SOLD OUT', key: 'tshirt', action: null },
                { img: '/images/products/product_david_hoodie.png', name: 'Fake David Marble-Print Hoodie', price: '$LIMITED EDITION', key: 'hoodie', action: null },
                { img: '/images/products/product_tommy_mug.png', name: 'Fake Bobby "Not A Doctor" Mug', price: '$PRICELESS', key: 'mug', action: null },
                { img: '/images/products/product_stickers.png', name: 'Fake Experts Sticker Pack', price: '$TAKING ORDERS', key: 'stickers', action: '/order.html' },
              ].map((p, i) => (
                <div key={p.key} className={`product-card reveal${i > 0 ? ` reveal-delay-${i}` : ''}`}>
                  <div className="product-img-container">
                    <Image
                      src={p.img}
                      alt={p.name}
                      width={260}
                      height={240}
                      className="product-img"
                      style={{ objectFit: 'contain' }}
                    />
                  </div>
                  <div className="product-info">
                    <h3 className="product-name">{p.name}</h3>
                    <div className="product-price">{p.price}</div>
                    <button
                      className="buy-btn"
                      onClick={() => {
                        handleStoreClick(p.key)
                        if (p.action) window.location.href = p.action
                      }}
                    >
                      {p.action ? 'Order Stickers' : 'Add to Cart'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Contact ───────────────────────────────────────────────────── */}
        <section className="section contact" id="contact">
          <div className="section-content contact-content">
            <h2 className="contact-title reveal">Get In Touch</h2>
            <form
              className="contact-form reveal reveal-delay-1"
              action="https://formspree.io/f/mbdokowg"
              method="POST"
            >
              <div className="form-group">
                <label htmlFor="contact-name" className="form-label">Your Name</label>
                <input
                  type="text"
                  id="contact-name"
                  name="name"
                  className="form-input"
                  placeholder="Enter your name"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="contact-email" className="form-label">Your Email</label>
                <input
                  type="email"
                  id="contact-email"
                  name="email"
                  className="form-input"
                  placeholder="Enter your email"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="contact-message" className="form-label">Your Message</label>
                <textarea
                  id="contact-message"
                  name="message"
                  className="form-textarea"
                  placeholder="What would you like to say?"
                  required
                />
              </div>
              <button type="submit" className="submit-btn">Send Message</button>
            </form>
          </div>
        </section>
      </main>
    </>
  )
}
