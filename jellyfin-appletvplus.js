/**
 * jellyfin-appletvplus.js
 * Apple TV+ UI Engine for Jellyfin
 * By mfaizanatiq — MIT License
 *
 * Injects Apple TV+ style enhancements:
 *   - Full-bleed cinematic hero with auto-rotation
 *   - "Continue Watching" row with progress overlays
 *   - Numbered "Top 10" rank overlays on cards
 *   - Dynamic backdrop backdrop extraction
 *   - Row section labels
 *   - Card metadata overlays (episode info, duration)
 *   - Season selector pills on detail pages
 *
 * INSTALL: Paste in Jellyfin Admin > Branding > Custom JS
 * OR: loaded automatically via Source.css @import chain
 */

(function AppleTVPlusTheme() {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────
  const CFG = {
    heroRotateMs: 8000,       // milliseconds between hero slides
    heroFadeMs: 800,          // fade transition duration
    maxHeroItems: 8,          // how many items to rotate in hero
    top10RowLabel: 'Top Picks', // label shown on numbered row
    continueWatchingLabel: 'Continue Watching',
    enableParallax: true,
    enableBackdropBlur: true,
    apiBase: window.location.origin,  // auto-detect Jellyfin server
    backdropQuality: 90,
    backdropTag: '0',
  };

  // ── State ────────────────────────────────────────────────────────────────
  let heroItems = [];
  let heroIndex = 0;
  let heroTimer = null;
  let heroEl = null;
  let initialized = false;
  let apiKey = null;
  let userId = null;
  let currentPath = '';

  // ── Utilities ────────────────────────────────────────────────────────────
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function log(...args) {
    console.log('%c[AppleTV+]', 'color:#0071e3;font-weight:bold', ...args);
  }

  // Get Jellyfin auth from ApiClient
  function getAuth() {
    try {
      const client = window.ApiClient || (window.Emby && window.Emby.ApiClient);
      if (client) {
        userId = client.getCurrentUserId();
        apiKey = client.accessToken();
        return true;
      }
      // Fallback: parse from localStorage
      const keys = Object.keys(localStorage).filter(k => k.includes('_token') || k.includes('AccessToken'));
      for (const k of keys) {
        try {
          const v = JSON.parse(localStorage[k]);
          if (v && v.AccessToken) { apiKey = v.AccessToken; userId = v.User && v.User.Id; return true; }
          if (v && typeof v === 'string' && v.length === 32) { apiKey = v; return !!apiKey; }
        } catch(e) {}
      }
    } catch(e) {}
    return false;
  }

  function apiUrl(path, params = {}) {
    const base = CFG.apiBase + path;
    const qs = Object.entries({ ...params, api_key: apiKey }).filter(([,v]) => v != null).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');
    return qs ? base + '?' + qs : base;
  }

  async function apiFetch(path, params = {}) {
    try {
      const url = apiUrl(path, params);
      const r = await fetch(url, { headers: { 'X-Emby-Token': apiKey } });
      if (!r.ok) return null;
      return r.json();
    } catch(e) { return null; }
  }

  function backdropUrl(itemId, width = 1920) {
    return apiUrl('/Items/' + itemId + '/Images/Backdrop', {
      quality: CFG.backdropQuality,
      maxWidth: width,
      tag: undefined,
    });
  }

  function thumbUrl(itemId, width = 400) {
    return apiUrl('/Items/' + itemId + '/Images/Primary', {
      quality: 90,
      maxWidth: width,
    });
  }

  function logoUrl(itemId) {
    return apiUrl('/Items/' + itemId + '/Images/Logo', {
      quality: 90,
      maxWidth: 600,
    });
  }

  // ── Page Detection ───────────────────────────────────────────────────────
  function getPage() {
    const hash = window.location.hash || '';
    if (hash.includes('home.html') || hash === '#/' || hash === '') return 'home';
    if (hash.includes('details')) return 'detail';
    if (hash.includes('itemdetails')) return 'detail';
    if (hash.includes('mypreferences')) return 'settings';
    if (hash.includes('search')) return 'search';
    return 'other';
  }

  // ── Hero Section ─────────────────────────────────────────────────────────
  async function buildHero() {
    if (!userId) return;

    // Fetch resume + latest items for hero rotation
    const [resume, latest, recommended] = await Promise.all([
      apiFetch('/Users/' + userId + '/Items/Resume', {
        Limit: 4, MediaTypes: 'Video', Fields: 'BackdropImageTags,Overview,Genres,ProductionYear',
        EnableImages: true, ImageTypeLimit: 1,
      }),
      apiFetch('/Users/' + userId + '/Items/Latest', {
        Limit: 6, Fields: 'BackdropImageTags,Overview,Genres,ProductionYear',
        EnableImages: true, ImageTypeLimit: 1, IncludeItemTypes: 'Movie,Series',
      }),
      apiFetch('/Users/' + userId + '/Items', {
        Limit: 4, SortBy: 'DateCreated,SortName', SortOrder: 'Descending',
        IncludeItemTypes: 'Movie,Series', Fields: 'BackdropImageTags,Overview,Genres,ProductionYear',
        Recursive: true, ImageTypeLimit: 1,
      }),
    ]);

    const items = [
      ...(resume && resume.Items ? resume.Items : []),
      ...(latest ? latest : []),
      ...(recommended && recommended.Items ? recommended.Items : []),
    ].filter((item, i, arr) => arr.findIndex(x => x.Id === item.Id) === i)
     .filter(item => item.BackdropImageTags && item.BackdropImageTags.length > 0)
     .slice(0, CFG.maxHeroItems);

    if (!items.length) return;
    heroItems = items;

    // Remove any existing hero
    $$('.atv-hero').forEach(el => el.remove());

    heroEl = document.createElement('div');
    heroEl.className = 'atv-hero';
    heroEl.setAttribute('role', 'banner');

    // Build slide for each item
    heroItems.forEach((item, idx) => {
      const slide = document.createElement('div');
      slide.className = 'atv-hero-slide' + (idx === 0 ? ' atv-hero-slide--active' : '');
      slide.dataset.index = idx;

      const bg = document.createElement('div');
      bg.className = 'atv-hero-bg';
      bg.style.backgroundImage = 'url(' + backdropUrl(item.Id, 1920) + ')';
      slide.appendChild(bg);

      const content = document.createElement('div');
      content.className = 'atv-hero-content';

      // Status badge
      if (item.UserData && item.UserData.PlayedPercentage > 0) {
        const badge = document.createElement('div');
        badge.className = 'atv-badge';
        badge.textContent = 'Continue Watching';
        content.appendChild(badge);
      } else {
        const badge = document.createElement('div');
        badge.className = 'atv-badge';
        badge.textContent = item.Status === 'Continuing' ? 'New Episodes Available' : (item.IsNew ? 'New' : item.Type === 'Movie' ? 'Movie' : 'Series');
        content.appendChild(badge);
      }

      // Logo or Title
      const titleEl = document.createElement('div');
      titleEl.className = 'atv-hero-title';
      titleEl.textContent = item.Name || '';
      content.appendChild(titleEl);

      // Meta row: type · genres · year
      const meta = document.createElement('div');
      meta.className = 'atv-hero-meta';
      const parts = [];
      if (item.Type) parts.push(item.Type === 'Series' ? 'TV Show' : item.Type);
      if (item.Genres) parts.push(...item.Genres.slice(0, 2));
      if (item.ProductionYear) parts.push(item.ProductionYear);
      meta.textContent = parts.join(' · ');
      content.appendChild(meta);

      // Overview
      if (item.Overview) {
        const overview = document.createElement('p');
        overview.className = 'atv-hero-overview';
        overview.textContent = item.Overview.length > 160 ? item.Overview.substring(0, 157) + '…' : item.Overview;
        content.appendChild(overview);
      }

      // Buttons
      const btns = document.createElement('div');
      btns.className = 'atv-hero-buttons';

      const playBtn = document.createElement('button');
      playBtn.className = 'atv-btn-play';
      playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M3 1.5l9 5.5-9 5.5V1.5z"/></svg> Play';
      playBtn.addEventListener('click', () => navigateToItem(item));
      btns.appendChild(playBtn);

      const addBtn = document.createElement('button');
      addBtn.className = 'atv-btn-icon';
      addBtn.title = 'Add to Watchlist';
      addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 2v12M2 8h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      btns.appendChild(addBtn);

      const infoBtn = document.createElement('button');
      infoBtn.className = 'atv-btn-icon';
      infoBtn.title = 'More Info';
      infoBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5" fill="none"/><text x="8" y="12" text-anchor="middle" font-size="9" font-weight="bold" fill="currentColor">i</text></svg>';
      infoBtn.addEventListener('click', () => navigateToItem(item));
      btns.appendChild(infoBtn);

      content.appendChild(btns);

      // Progress bar if in progress
      if (item.UserData && item.UserData.PlayedPercentage > 0) {
        const prog = document.createElement('div');
        prog.className = 'atv-progress-bar';
        const fill = document.createElement('div');
        fill.className = 'atv-progress-fill';
        fill.style.width = item.UserData.PlayedPercentage + '%';
        prog.appendChild(fill);
        content.appendChild(prog);
      }

      slide.appendChild(content);
      heroEl.appendChild(slide);
    });

    // Dot indicators
    const dots = document.createElement('div');
    dots.className = 'atv-hero-dots';
    heroItems.forEach((_, idx) => {
      const dot = document.createElement('button');
      dot.className = 'atv-hero-dot' + (idx === 0 ? ' atv-hero-dot--active' : '');
      dot.addEventListener('click', () => goToSlide(idx));
      dots.appendChild(dot);
    });
    heroEl.appendChild(dots);

    // Inject before the main content
    const mainSection = document.querySelector('.homeSectionsContainer, .sections, [data-role="page"] .padded-left');
    if (mainSection) {
      mainSection.parentNode.insertBefore(heroEl, mainSection);
    } else {
      const page = document.querySelector('[data-role="page"]');
      if (page) page.prepend(heroEl);
    }

    // Start auto-rotation
    startHeroRotation();
    log('Hero built with', heroItems.length, 'items');
  }

  function goToSlide(index) {
    if (!heroEl) return;
    const slides = $$('.atv-hero-slide', heroEl);
    const dots = $$('.atv-hero-dot', heroEl);
    slides.forEach((s, i) => s.classList.toggle('atv-hero-slide--active', i === index));
    dots.forEach((d, i) => d.classList.toggle('atv-hero-dot--active', i === index));
    heroIndex = index;
  }

  function startHeroRotation() {
    if (heroTimer) clearInterval(heroTimer);
    heroTimer = setInterval(() => {
      heroIndex = (heroIndex + 1) % heroItems.length;
      goToSlide(heroIndex);
    }, CFG.heroRotateMs);
  }

  function navigateToItem(item) {
    const id = item.Id;
    window.location.hash = '/details?id=' + id + '&context=home';
  }

  // ── Top 10 Rank Numbers ──────────────────────────────────────────────────
  function addRankNumbers() {
    // Find rows that look like "Top" sections
    const rowHeaders = $$('.sectionTitle, .homeSectionHeader');
    rowHeaders.forEach(header => {
      const text = (header.textContent || '').toLowerCase();
      if (!text.includes('top') && !text.includes('popular') && !text.includes('trending')) return;

      const row = header.closest('.homeSection, .verticalSection') || header.nextElementSibling;
      if (!row) return;

      const cards = $$('.card', row);
      cards.forEach((card, idx) => {
        if (idx >= 10) return;
        if (card.querySelector('.atv-rank')) return;

        const rank = document.createElement('div');
        rank.className = 'atv-rank';
        rank.textContent = idx + 1;
        rank.setAttribute('aria-label', 'Rank ' + (idx + 1));
        card.style.position = 'relative';
        card.insertBefore(rank, card.firstChild);
      });
    });
  }

  // ── Card Progress Bars ───────────────────────────────────────────────────
  function enhanceCards() {
    // Add progress bars to cards that are in-progress
    const cards = $$('.card:not([data-atv-enhanced])');
    cards.forEach(card => {
      card.dataset.atvEnhanced = '1';

      // Look for the jellyfin progress indicator and style it
      const prog = card.querySelector('.cardIndicator, .playedIndicatorFilter');
      if (prog) {
        prog.classList.add('atv-card-progress');
      }

      // Add overlay gradient on hover for better text readability
      const imgContainer = card.querySelector('.cardImageContainer');
      if (imgContainer && !imgContainer.querySelector('.atv-card-gradient')) {
        const grad = document.createElement('div');
        grad.className = 'atv-card-gradient';
        imgContainer.appendChild(grad);
      }
    });
  }

  // ── Section Label Enhancement ────────────────────────────────────────────
  function enhanceSectionHeaders() {
    const headers = $$('.sectionTitle:not([data-atv-styled]), .homeSectionHeader:not([data-atv-styled])');
    headers.forEach(h => {
      h.dataset.atvStyled = '1';
      h.classList.add('atv-section-header');
    });
  }

  // ── Inject Dynamic CSS ───────────────────────────────────────────────────
  function injectStyles() {
    if ($('#atv-dynamic-styles')) return;
    const style = document.createElement('style');
    style.id = 'atv-dynamic-styles';
    style.textContent = `
/* ── Hero Component ── */
.atv-hero {
  position: relative;
  width: 100%;
  height: 75vh;
  min-height: 520px;
  max-height: 820px;
  overflow: hidden;
  background: #000;
  margin-bottom: -60px;
  z-index: 0;
}

.atv-hero-slide {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 0.8s ease;
  pointer-events: none;
}

.atv-hero-slide--active {
  opacity: 1;
  pointer-events: auto;
}

.atv-hero-bg {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center 20%;
  transform: scale(1.04);
  transition: transform 8s ease;
  filter: brightness(0.6) saturate(1.1);
}

.atv-hero-slide--active .atv-hero-bg {
  transform: scale(1.0);
}

/* Multi-layer gradient */
.atv-hero-slide::after {
  content: '';
  position: absolute;
  inset: 0;
  background:
    linear-gradient(to right, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.3) 50%, transparent 75%),
    linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.4) 30%, transparent 60%);
  z-index: 1;
}

.atv-hero-content {
  position: absolute;
  bottom: 100px;
  left: 5%;
  max-width: 520px;
  z-index: 2;
  padding: 20px;
}

.atv-badge {
  display: inline-block;
  background: rgba(255,255,255,0.16);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.2);
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #fff;
  margin-bottom: 14px;
}

.atv-hero-title {
  font-family: -apple-system, 'SF Pro Display', BlinkMacSystemFont, 'Helvetica Neue', sans-serif;
  font-size: clamp(2.4rem, 5vw, 4.8rem);
  font-weight: 700;
  letter-spacing: -0.03em;
  line-height: 1.0;
  color: #fff;
  text-shadow: 0 2px 24px rgba(0,0,0,0.4);
  margin-bottom: 10px;
}

.atv-hero-meta {
  font-size: 0.82rem;
  color: rgba(255,255,255,0.75);
  font-weight: 500;
  margin-bottom: 10px;
  letter-spacing: 0.01em;
}

.atv-hero-overview {
  font-size: 0.88rem;
  line-height: 1.5;
  color: rgba(255,255,255,0.8);
  margin: 0 0 18px;
  font-weight: 400;
}

.atv-hero-buttons {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.atv-btn-play {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #fff;
  color: #000;
  border: none;
  border-radius: 22px;
  padding: 10px 24px;
  font-size: 0.9rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s, transform 0.15s;
  letter-spacing: 0.01em;
}

.atv-btn-play:hover {
  background: rgba(255,255,255,0.85);
  transform: scale(1.03);
}

.atv-btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255,255,255,0.15);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1.5px solid rgba(255,255,255,0.3);
  color: #fff;
  cursor: pointer;
  transition: background 0.2s, transform 0.15s;
}

.atv-btn-icon:hover {
  background: rgba(255,255,255,0.28);
  transform: scale(1.08);
}

/* Progress bar in hero */
.atv-progress-bar {
  width: 100%;
  height: 3px;
  background: rgba(255,255,255,0.2);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 14px;
}

.atv-progress-fill {
  height: 100%;
  background: #fff;
  border-radius: 2px;
  transition: width 0.3s;
}

/* Dot indicators */
.atv-hero-dots {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  z-index: 3;
}

.atv-hero-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255,255,255,0.4);
  border: none;
  cursor: pointer;
  transition: all 0.25s;
  padding: 0;
}

.atv-hero-dot--active {
  width: 20px;
  border-radius: 3px;
  background: rgba(255,255,255,0.95);
}

/* ── Top 10 Rank Numbers ── */
.atv-rank {
  position: absolute;
  bottom: -8px;
  left: -10px;
  font-family: -apple-system, 'SF Pro Display', BlinkMacSystemFont, sans-serif;
  font-size: clamp(4rem, 8vw, 7.5rem);
  font-weight: 800;
  line-height: 1;
  color: transparent;
  -webkit-text-stroke: 3px rgba(255,255,255,0.85);
  text-stroke: 3px rgba(255,255,255,0.85);
  z-index: 3;
  pointer-events: none;
  text-shadow: 0 2px 12px rgba(0,0,0,0.5);
  letter-spacing: -0.04em;
}

/* ── Card Enhancements ── */
.atv-card-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 0.3s;
  pointer-events: none;
  z-index: 1;
}

.card:hover .atv-card-gradient {
  opacity: 1;
}

/* ── Section Headers ── */
.atv-section-header {
  font-family: -apple-system, 'SF Pro Display', BlinkMacSystemFont, sans-serif !important;
  font-size: 1.25rem !important;
  font-weight: 700 !important;
  color: #fff !important;
  letter-spacing: -0.02em !important;
  margin: 1.5em 0 0.6em !important;
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.35); }
`;
    document.head.appendChild(style);
    log('Dynamic styles injected');
  }

  // ── Main Init ────────────────────────────────────────────────────────────
  async function init() {
    if (!getAuth()) {
      // Retry auth after a delay (user might not be logged in yet)
      await wait(2000);
      if (!getAuth()) {
        log('Auth not available, waiting for login...');
        return;
      }
    }

    log('Initialized — userId:', userId);
    injectStyles();

    const page = getPage();
    log('Page type:', page);

    if (page === 'home') {
      await wait(500); // let Jellyfin render first
      await buildHero();
      addRankNumbers();
      enhanceSectionHeaders();
      enhanceCards();
    } else {
      enhanceCards();
      enhanceSectionHeaders();
    }

    initialized = true;
  }

  // ── Route Change Observer ─────────────────────────────────────────────────
  function watchRoute() {
    let lastHash = window.location.hash;

    const checkRoute = async () => {
      const hash = window.location.hash;
      if (hash !== lastHash) {
        lastHash = hash;
        if (heroTimer) clearInterval(heroTimer);
        heroEl = null;
        heroItems = [];
        initialized = false;

        await wait(800);
        await init();
      }
    };

    window.addEventListener('hashchange', checkRoute);
    window.addEventListener('popstate', checkRoute);

    // Also observe DOM changes for SPA navigation
    const observer = new MutationObserver(() => {
      if (!initialized) return;
      addRankNumbers();
      enhanceCards();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Entry Point ───────────────────────────────────────────────────────────
  async function main() {
    log('Apple TV+ Theme Engine starting...');

    // Wait for Jellyfin to be ready
    let attempts = 0;
    while (!window.ApiClient && attempts < 20) {
      await wait(500);
      attempts++;
    }

    await init();
    watchRoute();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', main);
  } else {
    main();
  }

})();
