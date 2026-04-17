const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

// ── Scraper botasaurus (remplace l'API officielle Etsy) ──
const {
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
 * Récupère les listings Etsy via le scraper botasaurus pour la détection de dropship.
 */
async function fetchListingsForDropship(keyword, onBatch, usedShops = [], isAborted = () => false) {
  const MAX_PAGES  = 7;
  const perPage    = 48;
  const shopsSeen  = new Set(usedShops);
  const shopIdToRaw = new Map();
  let offset = 0;
  let page   = 0;
  const pageTimes = [];
  let lastPageStart = Date.now();

  while (page < MAX_PAGES) {
    if (isAborted()) return [];
    lastPageStart = Date.now();
    let results;
    try {
      results = await searchListingIds(keyword, perPage, offset);
    } catch (e) {
      handleEtsyError(e);
    }

    if (!results || results.length === 0) break;

    for (const r of results) {
      // Le scraper peut retourner shopId null — on utilise shopName/listingId comme clé de déduplication
      const uniqueKey = r.shopId ? String(r.shopId) : (r.shopName || r.listingId);
      if (!uniqueKey) continue;
      if (shopsSeen.has(uniqueKey)) continue;

      if (!shopIdToRaw.has(uniqueKey)) {
        shopIdToRaw.set(uniqueKey, {
          shopId: r.shopId || null,
          shopName: r.shopName || null,
          shopUrl: r.shopUrl || null,
          listingId: r.listingId,
          listingId2: null,
          link: r.link,
          title: r.title,
          image: r.image || null,
        });
      } else {
        const existing = shopIdToRaw.get(uniqueKey);
        if (!existing.listingId2 && r.listingId !== existing.listingId) {
          existing.listingId2 = r.listingId;
        }
      }
    }

    const pageElapsed = Date.now() - lastPageStart;
    pageTimes.push(pageElapsed);
    const avgPageMs = pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length;

    page++;
    console.log(`fetchListingsForDropship scan page ${page}/${MAX_PAGES}: ${shopIdToRaw.size} unique boutiques`);
    if (onBatch) onBatch(page, shopIdToRaw.size, avgPageMs, MAX_PAGES);

    if (results.length < perPage) break;
    offset += perPage;
  }

  console.log('[fetchListings] Total unique boutiques à résoudre:', shopIdToRaw.size);

  const BATCH = 8;
  const listings = [];
  const shopList = [...shopIdToRaw.entries()];

  for (let i = 0; i < shopList.length; i += BATCH) {
    if (isAborted()) return listings;
    const batch = shopList.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(async ([uniqueKey, raw]) => {
        // Si on a déjà les infos boutique depuis le scraping de la page de résultats,
        // on peut parfois éviter des requêtes supplémentaires.
        let shopName = raw.shopName;
        let shopUrl  = raw.shopUrl;
        let image    = raw.image;
        let image2   = raw.image2 || null;

        // Chercher un 2ème listing dans la boutique pour avoir une 2ème image
        let listingId2 = raw.listingId2;
        if (!listingId2 && shopName && !String(shopName).startsWith('listing-')) {
          try {
            const shopListings = await getShopListings(shopName, 5);
            const other = shopListings.find(l => l.listingId && String(l.listingId) !== String(raw.listingId));
            if (other) {
              listingId2 = other.listingId;
              if (!image && other.image) image = other.image;
            }
          } catch (e) {
            console.warn('[fetchListings] getShopListings failed for', shopName, ':', e.message);
          }
        }

        // Si on a un shopId numérique et pas encore d'images, utiliser shop-name-and-image
        if (raw.shopId && (!image || !image2)) {
          try {
            const info = await getShopNameAndImage(raw.shopId, raw.listingId, listingId2);
            if (!shopName && info.shopName) shopName = info.shopName;
            if (!shopUrl  && info.shopUrl)  shopUrl  = info.shopUrl;
            if (!image    && info.image)    image    = info.image;
            if (!image2   && info.image2)   image2   = info.image2;
          } catch (e) {
            console.warn('[fetchListings] getShopNameAndImage failed for shopId', raw.shopId, ':', e.message);
          }
        }

        // Récupérer image2 depuis le 2ème listing si pas encore disponible
        if (!image2 && listingId2) {
          try {
            const detail = await getListingDetail(listingId2);
            if (detail.images?.[0]) image2 = detail.images[0];
          } catch (e) {
            console.warn('[fetchListings] getListingDetail failed for listing2:', e.message);
          }
        }

        return {
          listingId: raw.listingId,
          listingUrl: raw.link,
          link:      raw.link,
          title:     raw.title,
          image,
          image2: image2 || image,
          shopName,
          shopUrl: shopUrl || raw.link,
          shopImage: image,
          shopAvatar: image,
          shopId: raw.shopId,
          source: 'etsy',
        };
      })
    );

    for (const r of resolved) {
      if (r.status !== 'fulfilled') {
        console.warn('[fetchListings] resolve failed:', r.reason?.message);
        continue;
      }
      const l = r.value;
      if (!l.shopName || !l.image) continue;
      if (shopsSeen.has(l.shopName)) continue;
      shopsSeen.add(l.shopName);
      listings.push(l);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('fetchListingsForDropship done:', listings.length, 'boutiques uniques avec images');
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
    listings = listings.filter(l => l.shopName);
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
        const match1 = await lensMatchWithClip(listing.image);
        const match2 = listing.image2 ? await lensMatchWithClip(listing.image2) : null;
        const bestMatch = match1 || match2;

        if (bestMatch) {
          found++;
          send({
            step: 'result',
            listing: {
              ...listing,
              aliMatch: bestMatch,
            },
          });
          send({
            step: 'match',
            shop: {
              ...listing,
              aliMatch: bestMatch,
            },
            message: 'Match AliExpress trouvé pour ' + listing.shopName,
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
