const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

// ── Scraper Etsy direct ──
const {
  searchEtsyPages,
  getSecondShopImage,
  searchListingIds,
  getShopNameAndImage,
  getShopListings,
  getShopInfo,
  getListingDetail,
  handleEtsyError,
  isScraperAvailable,
} = require('../services/etsyScraper');

// DINOv2 : comparaison visuelle objet Etsy ↔ AliExpress (HuggingFace, gratuit)
const { compareImages, findBestAliMatch, extractAliImageUrls, isClipAvailable, isDinoReady } = require('../services/dinoCompare');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}

// ── Clé Serper unique ──
const SERPER_KEYS = [process.env.SERPER_API_KEY].filter(Boolean);
let _serperKeyIndex = 0;
function getSerperKey() {
  const key = SERPER_KEYS[_serperKeyIndex % SERPER_KEYS.length];
  _serperKeyIndex++;
  return key;
}

const activeSearches = new Map();

router.post('/stop-search', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && activeSearches.has(sessionId)) {
    activeSearches.set(sessionId, true);
  }
  res.json({ ok: true });
});

// ── NICHE KEYWORD (dice button) ──
router.post('/niche-keyword', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing' });
  try {
    const now = new Date();
    const month = now.toLocaleString('en', { month: 'long' });
    const year = now.getFullYear();
    const usedKeywords = req.body?.usedKeywords || [];
    const excludeList = usedKeywords.length > 0
      ? `\nDo NOT include any of these already-used keywords: ${usedKeywords.join(', ')}.`
      : '';

    const prompt = `It is ${month} ${year}. Generate a list of exactly 50 unique English niche keywords for Etsy product searches.\n\nRules:\n- Each keyword must be 2-4 words\n- ALL must be PHYSICAL products only (no digital, no printables, no SVG, no downloads, no templates)\n- All 50 must be DIFFERENT product types — no variations of the same product\n- Mix categories: home decor, jewelry, clothing, accessories, ceramics, candles, toys, stationery, wellness, outdoors, pets, baby, kitchen, garden, etc.\n- Each must be specific and searchable (not generic like \"handmade gift\")\n- Prioritize products trending in ${month} ${year}${excludeList}\n\nRespond with ONLY a JSON array of 50 strings, no explanation, no markdown, no numbering.\nExample format: [\"keyword one\",\"keyword two\",\"keyword three\"]`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const parts = r.data.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(p => p.text || '').join(' ').trim();
    const clean = rawText.replace(/```json|```/g, '').trim();
    let keywords = JSON.parse(clean);
    if (!Array.isArray(keywords)) throw new Error('Invalid response format');
    keywords = [...new Set(keywords.map(k => k.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()))].filter(k => k.length > 2).slice(0, 50);
    res.json({ keywords });
  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    res.status(500).json({ error: detail });
  }
});


/**
 * Récupère les listings Etsy en scrapant directement les pages de résultats Etsy.
 *
 * ÉTAPE 1 — Scrape des 7 pages Etsy pour le keyword.
 *   → 1 listing représentatif par boutique (déduplication par shopName).
 *   → Chaque listing a déjà : listingId, image, shopName, shopUrl.
 *
 * ÉTAPE 2 — Pour chaque boutique unique :
 *   → Visite la page boutique pour récupérer une 2ème image (listing différent).
 *   → Les boutiques déjà analysées (usedShops) sont ignorées.
 */
async function fetchListingsForDropship(keyword, onBatch, usedShops = [], isAborted = () => false) {
  const MAX_PAGES = 7;
  const shopsSeen = new Set(usedShops);
  const pageTimes = [];

  // ── ÉTAPE 1 : Scrape des pages de résultats Etsy ──────────────────────────
  const rawListings = [];
  const seenShopKeys = new Set(usedShops);

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (isAborted()) return [];

    const pageStart = Date.now();

    // Pause entre pages (respecte le rate limiter d'Etsy)
    if (page > 1) await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 1800)));

    const url = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}&explicit=1`;
    console.log(`[fetchListings] Scrape page ${page}/${MAX_PAGES}: ${url}`);

    let pageResults;
    try {
      pageResults = await searchListingIds(keyword, 64, (page - 1) * 64);
    } catch (e) {
      console.error(`[fetchListings] page ${page} échouée: ${e.message}`);
      if (e.message.includes('captcha')) break;
      continue;
    }

    let newThisPage = 0;
    for (const r of (pageResults || [])) {
      if (!r.listingId || !r.image) continue;
      const shopKey = r.shopName || r.listingId;
      if (seenShopKeys.has(shopKey)) continue;
      seenShopKeys.add(shopKey);
      rawListings.push({
        listingId:       r.listingId,
        shopName:        r.shopName || null,
        shopUrl:         r.shopUrl  || null,
        link:            r.link,
        title:           r.title,
        image:           r.image,
        hasRealShopName: !!r.shopName,
      });
      newThisPage++;
    }

    const elapsed = Date.now() - pageStart;
    pageTimes.push(elapsed);
    const avgPageMs = pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length;

    console.log(`[fetchListings] page ${page}: +${newThisPage} boutiques | total: ${rawListings.length}`);
    if (onBatch) onBatch(page, rawListings.length, avgPageMs, MAX_PAGES);

    if (!pageResults || pageResults.length === 0) break;
  }

  console.log(`[fetchListings] Scraping terminé: ${rawListings.length} boutiques uniques`);
  if (isAborted()) return [];

  // ── ÉTAPE 2 : Récupérer une 2ème image depuis la page de chaque boutique ──
  // On traite par lots de 5 pour ne pas surcharger Etsy
  const BATCH = 5;
  const listings = [];

  for (let i = 0; i < rawListings.length; i += BATCH) {
    if (isAborted()) return listings;

    const batch = rawListings.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(async (raw) => {
        // Récupère la 2ème image depuis la page boutique
        let image2 = null;
        if (raw.shopUrl && raw.hasRealShopName) {
          image2 = await getSecondShopImage(raw.shopUrl, raw.listingId);
        }

        return {
          listingId:      raw.listingId,
          listingUrl:     raw.link,
          link:           raw.link,
          title:          raw.title,
          image:          raw.image,
          image2:         image2 || raw.image, // fallback sur image1 si pas de 2ème
          shopName:       raw.shopName,
          shopUrl:        raw.shopUrl || raw.link,
          shopImage:      raw.image,
          shopAvatar:     raw.image,
          shopId:         null,
          hasRealShopName: raw.hasRealShopName,
          source:         'etsy',
        };
      })
    );

    for (const r of resolved) {
      if (r.status !== 'fulfilled') {
        console.warn('[fetchListings] resolve failed:', r.reason?.message);
        continue;
      }
      const l = r.value;
      // On garde même sans shopName — l'image est suffisante pour DINOv2
      if (!l.image) continue;
      if (l.shopName && shopsSeen.has(l.shopName)) continue;
      if (l.shopName) shopsSeen.add(l.shopName);
      listings.push(l);
    }
  }

  console.log(`fetchListingsForDropship done: ${listings.length} boutiques avec images`);
  return listings;
}


// ── SEARCH DROPSHIP ──
router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!SERPER_KEYS.length) return res.status(500).json({ error: 'SERPER_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  // ── Abort detection ──
  for (const [key, val] of activeSearches.entries()) {
    if (val === true) activeSearches.delete(key);
  }
  const sid = sessionId && sessionId.trim() ? sessionId.trim() : (Date.now() + Math.random()).toString(36);
  activeSearches.set(sid, false);
  const isAborted = () => activeSearches.get(sid) === true;

  try {

    // ── STEP 0 : Vérifier que le scraper est disponible ──
    // Le scraper utilise Etsy direct si possible, puis une source gratuite indexée en secours.
    const scraperOk = await isScraperAvailable();
    if (!scraperOk) {
      send({ step: 'error', message: '❌ Recherche Etsy temporairement indisponible. Réessayez dans quelques minutes.' });
      return res.end();
    }

    // ── STEP 1 : Récupérer les boutiques déjà analysées ──
    const AutoSearchState = require('../models/autoSearchModel');
    let usedShops = [];
    try {
      const { requireAuth } = require('./auth');
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET;
      const header = req.headers.authorization || '';
      const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        const state = await AutoSearchState.findOne({ userId: decoded.id });
        if (state?.usedShops?.length) {
          usedShops = state.usedShops;
          console.log('[search-dropship] Excluding', usedShops.length, 'already-seen shops');
        }
      }
    } catch(e) {
      console.warn('[search-dropship] Could not load usedShops:', e.message);
    }

    // ── STEP 2 & 3 : Warm-up DINOv2 + Scraping Etsy en parallèle ──
    send({ step: 'analyzing', message: '🤖 Vérification du service DINOv2...' });
    send({ step: 'scraping', message: '🔍 Recherche Etsy pour "' + keyword + '"...' });

    async function waitForDino(maxAttempts = 8, delayMs = 20000) {
      for (let i = 0; i < maxAttempts; i++) {
        const reachable = await isClipAvailable().catch(() => false);
        if (!reachable) continue;
        const ready = await isDinoReady().catch(() => false);
        if (ready) return true;
        if (i < maxAttempts - 1) {
          send({ step: 'analyzing', message: `⏳ DINOv2 en démarrage... (${i + 1}/${maxAttempts}) — nouvelle tentative dans ${delayMs / 1000}s` });
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      return false;
    }

    let listings = [];
    let dinoReady = false;

    try {
      [dinoReady, listings] = await Promise.all([
        waitForDino(),
        fetchListingsForDropship(
          keyword,
          (page, count, avgPageMs, maxPages) => send({ step: 'scraping', page, maxPages, avgPageMs, message: '📄 Page ' + page + '/7 — ' + count + ' boutiques...' }),
          usedShops,
          isAborted
        ),
      ]);
    } catch(e) {
      send({ step: 'error', message: '❌ Scraping Etsy échoué: ' + e.message }); return res.end();
    }

    if (!dinoReady) {
      send({
        step: 'error',
        message: '❌ Le service DINOv2 est indisponible après plusieurs tentatives. Veuillez réessayer dans 1-2 minutes (cold start HuggingFace ~60-90s).',
      });
      activeSearches.delete(sid);
      return res.end();
    }

    send({ step: 'analyzing', message: '✅ DINOv2 prêt — comparaison visuelle obligatoire activée' });
    console.log('[search-dropship] ✅ DINOv2 disponible — comparaison visuelle obligatoire');

    if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped by user.' }); activeSearches.delete(sid); return res.end(); }
    listings = listings.filter(l => l.shopName && l.image).slice(0, Number(process.env.MAX_ANALYZE_LISTINGS || 24));
    console.log('[search-dropship] listings found:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ Aucun résultat Etsy exploitable trouvé pour ce mot-clé' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques uniques. Analyse DINOv2...' });

    // ── STEP 4 : Google Lens + CLIP obligatoire ──
    const { uploadImageFree } = require('../services/freeImageUploader');

    async function lensMatchWithClip(etsyImageUrl) {
      if (isAborted()) return null;
      try {
        if (!etsyImageUrl || isAborted()) return null;

        const pub = await uploadImageFree(etsyImageUrl);
        if (!pub || isAborted()) return null;

        let r;
        const SERPER_RETRIES = 3;
        for (let attempt = 0; attempt < SERPER_RETRIES; attempt++) {
          try {
            r = await axios.post('https://google.serper.dev/lens',
              { url: pub, gl: 'us', hl: 'en' },
              { headers: { 'X-API-KEY': getSerperKey() }, timeout: 25000 }
            );
            break;
          } catch (serperErr) {
            const status = serperErr.response?.status;
            const detail = serperErr.response?.data;

            if (status === 400) {
              console.warn('[lensMatchWithClip] Serper 400 — détail:', JSON.stringify(detail));
              if (detail?.message?.toLowerCase().includes('not enough credits')) {
                throw new Error('serper_no_credits');
              }
              throw serperErr;
            }

            if (status === 429) {
              if (attempt < SERPER_RETRIES - 1) {
                const wait = 1500 * Math.pow(2, attempt);
                console.warn(`[lensMatchWithClip] Serper 429 — retry dans ${wait}ms`);
                await new Promise(res => setTimeout(res, wait));
                continue;
              }
              console.warn('[lensMatchWithClip] Serper 429 — skipping listing');
              return null;
            }

            throw serperErr;
          }
        }

        if (!r) return null;

        const visualMatches = r.data.visual_matches || [];
        const aliResults = visualMatches
          .filter(m => m.link && (m.link.includes('aliexpress.com') || m.link.includes('ali')))
          .slice(0, 5);

        if (!aliResults.length) return null;

        const aliUrls = await extractAliImageUrls(aliResults);
        if (!aliUrls.length || isAborted()) return null;

        const bestMatch = await findBestAliMatch(etsyImageUrl, aliUrls);
        if (!bestMatch || isAborted()) return null;

        return bestMatch;
      } catch (e) {
        if (e.message === 'serper_no_credits') throw e;
        console.warn('[lensMatchWithClip] erreur:', e.message);
        return null;
      }
    }

    // ── STEP 5 : Analyse de chaque boutique ──
    let found = 0;
    let skipped = 0;
    const total = listings.length;

    for (let idx = 0; idx < listings.length; idx++) {
      if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped.' }); activeSearches.delete(sid); return res.end(); }

      const listing = listings[idx];
      send({ step: 'progress', current: idx + 1, total, shopName: listing.shopName });

      try {
        const imagesToCheck = [listing.image, listing.image2].filter((url, pos, arr) => url && arr.indexOf(url) === pos);
        let bestMatch = null;
        for (const imageUrl of imagesToCheck) {
          bestMatch = await lensMatchWithClip(imageUrl);
          if (bestMatch) break;
        }

        if (bestMatch) {
          found++;
          send({
            step: 'result',
            listing: {
              ...listing,
              aliMatch: bestMatch,
            },
          });
        } else {
          skipped++;
        }
      } catch (e) {
        if (e.message === 'serper_no_credits') {
          send({ step: 'error', message: '❌ Serper : crédits épuisés. Rechargez votre compte Serper.' });
          activeSearches.delete(sid);
          return res.end();
        }
        console.warn('[search-dropship] analyze failed for', listing.shopName, ':', e.message);
        skipped++;
      }
    }

    activeSearches.delete(sid);
    send({ step: 'done', found, skipped, total });
    send({ step: 'complete', found, skipped, total });
    res.end();

  } catch (e) {
    console.error('[search-dropship] Fatal error:', e);
    send({ step: 'error', message: '❌ Erreur inattendue: ' + e.message });
    activeSearches.delete(sid);
    res.end();
  }
});


// ── GET SHOP INFO ──
router.post('/shop-info', async (req, res) => {
  const { shopIdOrName } = req.body;
  if (!shopIdOrName) return res.status(400).json({ error: 'shopIdOrName required' });
  try {
    const info = await getShopInfo(shopIdOrName);
    res.json(info);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET LISTING DETAIL ──
router.post('/listing-detail', async (req, res) => {
  const { listingId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'listingId required' });
  try {
    const detail = await getListingDetail(listingId);
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SCRAPER HEALTH ──
router.get('/scraper-health', async (req, res) => {
  const ok = await isScraperAvailable();
  const proxyConfigured = !!process.env.PROXY_URL;
  res.json({
    ok,
    message: ok
      ? (proxyConfigured ? 'Recherche Etsy ✅ + proxy configuré' : 'Recherche Etsy ✅ + secours gratuit actif')
      : 'Recherche Etsy indisponible ❌',
  });
});

module.exports = router;
