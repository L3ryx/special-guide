const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListingIds, getShopNameAndImage, getShopListings, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');
// ScraperAPI conservé UNIQUEMENT pour AliExpress
const { scraperApiFetch } = require('../services/scrapingFetch');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}

// ── Active searches registry (sessionId → aborted) ──
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
 * Récupère les listings Etsy via l'API officielle pour la détection de dropship.
 *
 * Stratégie :
 *  1. Collecter tous les shop_id uniques via /listings/active (8 pages x 100)
 *  2. Pour chaque shop_id nouveau : appeler getShopNameAndImage() en parallèle (batch de 5)
 *     → /shops/{id} pour le nom + /shops/{id}/listings?includes=images pour l'image
 *
 * Retourne un tableau de { listingId, link, image, shopName, shopUrl }.
 */
async function fetchListingsForDropship(keyword, onBatch, usedShops = [], isAborted = () => false) {
  const MAX_PAGES  = 10;
  const perPage    = 100;
  // usedShops contient des shopNames (strings) — utilisé pour exclure les boutiques déjà traitées
  const usedShopNames = new Set(usedShops.map(s => String(s).toLowerCase()));
  const shopIdsSeen  = new Set(); // dédup par shopId en phase 1
  const shopIdToRaw = new Map(); // shopId → { listingId, link, title }
  let offset = 0;
  let page   = 0;

  // ── PHASE 1 : collecter tous les shop_id uniques ──
  while (page < MAX_PAGES) {
    if (isAborted()) return [];
    let results;
    try {
      results = await searchListingIds(keyword, perPage, offset);
    } catch (e) {
      handleEtsyError(e);
    }

    if (!results || results.length === 0) break;

    for (const r of results) {
      if (!r.shopId) continue;
      const sid = String(r.shopId);
      if (shopIdsSeen.has(sid)) continue;
      shopIdsSeen.add(sid);
      if (!shopIdToRaw.has(sid)) {
        shopIdToRaw.set(sid, { listingId: r.listingId, link: r.link, title: r.title });
      }
    }

    page++;
    console.log(`fetchListingsForDropship scan page ${page}/${MAX_PAGES}: ${shopIdToRaw.size} unique new shopIds`);
    if (onBatch) onBatch(page, shopIdToRaw.size);

    if (results.length < perPage) break;
    offset += perPage;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('[fetchListings] Total unique shopIds to resolve:', shopIdToRaw.size);

  // ── PHASE 2 : résoudre shopName + image par batch de 5 ──
  const BATCH = 5;
  const listings = [];
  const shopIdList = [...shopIdToRaw.entries()];

  for (let i = 0; i < shopIdList.length; i += BATCH) {
    if (isAborted()) return listings;
    const batch = shopIdList.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(([shopId, raw]) =>
        getShopNameAndImage(shopId, raw.listingId).then(({ shopName, shopUrl, image, images }) => ({
          shopId, shopName, shopUrl, image, images: images || (image ? [image] : []),
          listingId: raw.listingId,
          link:      raw.link,
          title:     raw.title,
        }))
      )
    );

    for (const r of resolved) {
      if (r.status !== 'fulfilled') {
        console.warn('[fetchListings] resolve failed:', r.reason?.message);
        continue;
      }
      const l = r.value;
      if (!l.shopName || !l.image) continue;
      // Exclure les boutiques déjà traitées (par shopName, insensible à la casse)
      if (usedShopNames.has(l.shopName.toLowerCase())) continue;
      if (shopIdsSeen.has('name:' + l.shopName.toLowerCase())) continue;
      shopIdsSeen.add('name:' + l.shopName.toLowerCase());
      listings.push({
        listingId: l.listingId,
        link:      l.link,
        title:     l.title,
        image:     l.image,
        images:    l.images || [l.image],
        shopName:  l.shopName,
        shopUrl:   l.shopUrl,
        shopId:    l.shopId,
        source:    'etsy',
      });
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('fetchListingsForDropship done:', listings.length, 'unique shops with image');
  return listings;
}


// ── SEARCH DROPSHIP ──
router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!process.env.ETSY_CLIENT_ID)   return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  if (!process.env.IMGBB_API_KEY)  return res.status(500).json({ error: 'IMGBB_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  // ── Abort detection ──
  // Nettoyer les anciennes sessions terminées pour éviter les faux positifs
  for (const [key, val] of activeSearches.entries()) {
    if (val === true) activeSearches.delete(key);
  }
  const sid = sessionId && sessionId.trim() ? sessionId.trim() : (Date.now() + Math.random()).toString(36);
  activeSearches.set(sid, false);   // false = en cours
  const isAborted = () => activeSearches.get(sid) === true;

  try {
    const { uploadToImgBB } = require('../services/imgbbUploader');

    // ── STEP 1 : Récupérer les boutiques déjà analysées pour les exclure ──
    const AutoSearchState = require('../models/autoSearchModel');
    let usedShops = [];
    try {
      const { requireAuth } = require('./auth');
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || 'Bretignydu91';
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

    // ── STEP 2 : Récupérer les listings Etsy ──
    send({ step: 'scraping', message: '🔍 Recherche Etsy pour "' + keyword + '"...' });

    let listings = [];
    try {
      listings = await fetchListingsForDropship(
        keyword,
        (page, count) => send({ step: 'scraping', message: '📄 Page ' + page + '/10 — ' + count + ' boutiques...' }),
        usedShops,
        isAborted
      );
    } catch(e) {
      send({ step: 'error', message: '❌ Etsy API failed: ' + e.message }); return res.end();
    }

    if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped by user.' }); activeSearches.delete(sid); return res.end(); }
    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings found:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ Aucune boutique trouvée dans les résultats Etsy' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques uniques. Analyse...' });

    // ── STEP 3 : Google Lens via Serper ──
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const r = await uploadToImgBB(url);
      imgbbCache.set(url, r);
      return r;
    }

    async function lensMatch(imageUrl) {
      if (isAborted()) return null;
      try {
        const pub = await uploadCached(imageUrl);
        if (!pub || isAborted()) return null;
        const r = await axios.post('https://google.serper.dev/lens',
          { url: pub, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );
        if (isAborted()) return null;
        const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
        return all.find(x => { const u = x.link || x.url || ''; return u.includes('aliexpress.com') && u.includes('/item/') && (x.imageUrl || x.thumbnailUrl); }) || null;
      } catch (e) {
        if (e.response?.status === 401) throw new Error('serper_401');
        return null;
      }
    }

    const dropshippers = [];
    let analyzed = 0;
    const queue = [...listings];

    async function worker() {
      while (queue.length > 0) {
        if (isAborted()) break;
        const listing = queue.shift();
        if (!listing) continue;
        analyzed++;
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: '\u{1F50E} ' + analyzed + '/' + listings.length + ' \u2014 ' + dropshippers.length + ' dropshippers' });
        try {
          const shopImages = listing.images || (listing.image ? [listing.image] : []);
          if (!shopImages.length) { console.warn('[worker] no images for', listing.shopName); continue; }

          console.log('[worker] testing', shopImages.length, 'images for', listing.shopName);

          // Tester les 3 images — TOUTES doivent matcher AliExpress pour confirmer le dropshipping
          let matchCount = 0;
          for (const imgUrl of shopImages) {
            if (isAborted()) break;
            const m = await lensMatch(imgUrl);
            console.log('[worker]', listing.shopName, '| img match:', !!m);
            if (m) matchCount++; else break; // dès qu'une image ne matche pas, on arrête
          }

          if (isAborted()) break;
          const allMatch = matchCount === shopImages.length && shopImages.length > 0;
          console.log('[worker]', listing.shopName, '| matched:', matchCount + '/' + shopImages.length);
          if (allMatch) {
            dropshippers.push({
              shopName:   listing.shopName,
              shopUrl:    listing.shopUrl || 'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar: null,
              shopImage:  shopImages[0],
              listingUrl: listing.link,
            });
            send({ step: 'match', message: '\u2705 ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers)', shop: dropshippers[dropshippers.length - 1] });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '\u274C Serper key invalid' }); return; }
        }
      }
    }

    await Promise.all([worker(), worker(), worker(), worker()]);
    activeSearches.delete(sid);
    if (isAborted()) {
      send({ step: 'stopped', message: '🛑 Search stopped by user.' });
    } else {
      send({ step: 'complete', dropshippers, total: listings.length });
    }
    res.end();

  } catch (err) {
    activeSearches.delete(sid);
    send({ step: 'error', message: '❌ ' + err.message });
    res.end();
  }
});


router.get('/health', (req, res) => {
  const keys = {
    ETSY_CLIENT_ID: !!process.env.ETSY_CLIENT_ID,
    SERPER_API_KEY: !!process.env.SERPER_API_KEY,
    IMGBB_API_KEY:  !!process.env.IMGBB_API_KEY,
    // SCRAPEAPI_KEY uniquement pour AliExpress dans CloneRoutes
    SCRAPEAPI_KEY:  !!process.env.SCRAPEAPI_KEY,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

// ── AUTH + SHOPS ──
const { router: authRouter } = require('./auth');
const shopRouter              = require('./shopRoutes');
router.use('/auth',  authRouter);
router.use('/shops', shopRouter);

module.exports = router;







