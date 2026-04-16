const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListingIds, getShopNameAndImage, getShopListings, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');
// ScraperAPI conservé UNIQUEMENT pour AliExpress
const { scraperApiFetch } = require('../services/scrapingFetch');
// CLIP : comparaison visuelle objet Etsy ↔ AliExpress (HuggingFace, gratuit)
const { compareImages, findBestAliMatch, extractAliImageUrls, isClipAvailable } = require('../services/clipCompare');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
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
 * Récupère les listings Etsy via l'API officielle pour la détection de dropship.
 */
async function fetchListingsForDropship(keyword, onBatch, usedShops = [], isAborted = () => false) {
  const MAX_PAGES  = 8;
  const perPage    = 100;
  const shopsSeen  = new Set(usedShops);
  const shopIdToRaw = new Map();
  let offset = 0;
  let page   = 0;

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
      if (shopsSeen.has(sid)) continue;
      if (!shopIdToRaw.has(sid)) {
        shopIdToRaw.set(sid, { listingId: r.listingId, listingId2: null, link: r.link, title: r.title });
      } else {
        const existing = shopIdToRaw.get(sid);
        if (!existing.listingId2 && r.listingId !== existing.listingId) {
          existing.listingId2 = r.listingId;
        }
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

  const BATCH = 12;
  const listings = [];
  const shopIdList = [...shopIdToRaw.entries()];

  for (let i = 0; i < shopIdList.length; i += BATCH) {
    if (isAborted()) return listings;
    const batch = shopIdList.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(([shopId, raw]) =>
        getShopNameAndImage(shopId, raw.listingId, raw.listingId2).then(({ shopName, shopUrl, image, image2 }) => ({
          shopId, shopName, shopUrl, image, image2,
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
      if (!l.shopName || !l.image || !l.image2) continue;
      if (shopsSeen.has(l.shopName)) continue;
      shopsSeen.add(l.shopName);
      listings.push({
        listingId: l.listingId,
        link:      l.link,
        title:     l.title,
        image:     l.image,
        image2:    l.image2,
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
  for (const [key, val] of activeSearches.entries()) {
    if (val === true) activeSearches.delete(key);
  }
  const sid = sessionId && sessionId.trim() ? sessionId.trim() : (Date.now() + Math.random()).toString(36);
  activeSearches.set(sid, false);
  const isAborted = () => activeSearches.get(sid) === true;

  try {

    // ── STEP 1 : Récupérer les boutiques déjà analysées ──
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

    // ── STEP 2 & 3 : Warm-up CLIP + Scraping Etsy en parallèle ──
    send({ step: 'analyzing', message: '🤖 Vérification du service CLIP...' });
    send({ step: 'scraping', message: '🔍 Recherche Etsy pour "' + keyword + '"...' });

    async function waitForClip(maxAttempts = 5, delayMs = 15000) {
      for (let i = 0; i < maxAttempts; i++) {
        const ready = await isClipAvailable().catch(() => false);
        if (ready) return true;
        if (i < maxAttempts - 1) {
          send({ step: 'analyzing', message: `⏳ CLIP en démarrage... (${i + 1}/${maxAttempts}) — nouvelle tentative dans ${delayMs / 1000}s` });
          await new Promise(r => setTimeout(r, delayMs));
        }
      }
      return false;
    }

    let listings = [];
    let clipReady = false;

    try {
      [clipReady, listings] = await Promise.all([
        waitForClip(),
        fetchListingsForDropship(
          keyword,
          (page, count) => send({ step: 'scraping', message: '📄 Page ' + page + '/8 — ' + count + ' boutiques...' }),
          usedShops,
          isAborted
        ),
      ]);
    } catch(e) {
      send({ step: 'error', message: '❌ Etsy API failed: ' + e.message }); return res.end();
    }

    if (!clipReady) {
      send({
        step: 'error',
        message: '❌ Le service CLIP est indisponible après plusieurs tentatives. Veuillez réessayer dans 1-2 minutes (cold start HuggingFace ~60-90s).',
      });
      activeSearches.delete(sid);
      return res.end();
    }

    send({ step: 'analyzing', message: '✅ CLIP prêt — comparaison visuelle obligatoire activée' });
    console.log('[search-dropship] ✅ CLIP disponible — comparaison visuelle obligatoire');

    if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped by user.' }); activeSearches.delete(sid); return res.end(); }
    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings found:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ Aucune boutique trouvée dans les résultats Etsy' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques uniques. Analyse CLIP...' });

    // ── STEP 4 : Google Lens + CLIP obligatoire ──

    /**
     * Vérifie si une image Etsy trouve son objet sur AliExpress.
     *
     * CLIP est OBLIGATOIRE :
     *  - Si CLIP rejette l'objet → null (pas de match)
     *  - Si CLIP est en erreur   → null (pas de match, on ne fait pas confiance à Serper seul)
     *  - Aucun fallback pHash, aucun fallback Serper seul
     *
     * @returns {object|null} Le match AliExpress confirmé par CLIP, ou null
     */
    async function lensMatchWithClip(etsyImageUrl) {
      if (isAborted()) return null;
      try {
        const pub = etsyImageUrl;
        if (!pub || isAborted()) return null;

        // Étape 1 : Google Lens pour trouver des candidats AliExpress
        const r = await axios.post('https://google.serper.dev/lens',
          { url: pub, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );
        if (isAborted()) return null;

        const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
        const aliMatches = all.filter(x => {
          const u = x.link || x.url || '';
          return u.includes('aliexpress.com') && u.includes('/item/') &&
                 (x.imageUrl || x.thumbnailUrl);
        });

        // Pas de candidat AliExpress trouvé par Serper → pas de match
        if (!aliMatches.length) return null;

        // Étape 2 : CLIP — vérification visuelle OBLIGATOIRE
        const aliUrls = aliMatches
          .slice(0, 5) // on teste jusqu'à 5 candidats pour maximiser les chances
          .flatMap(m => extractAliImageUrls(m))
          .filter(Boolean);

        if (!aliUrls.length) {
          // Serper n'a retourné aucune image AliExpress utilisable → refus
          console.log(`[CLIP] ❌ Aucune image AliExpress exploitable pour CLIP`);
          return null;
        }

        const clipResult = await findBestAliMatch(etsyImageUrl, aliUrls, {
          threshold: parseFloat(process.env.CLIP_THRESHOLD || '0.78'),
        });

        console.log(`[CLIP] sim=${clipResult.similarity} match=${clipResult.match} fallback=${clipResult.fallback}`);

        // Si le service CLIP a planté pendant la requête → refus (pas de fallback)
        if (clipResult.fallback) {
          console.log(`[CLIP] ⚠️ Service CLIP down en cours de requête — résultat ignoré`);
          return null;
        }

        // CLIP confirme l'objet → match validé
        if (clipResult.match) {
          return { ...aliMatches[0], clipSimilarity: clipResult.similarity };
        }

        // CLIP rejette l'objet → pas de match même si Serper avait trouvé quelque chose
        console.log(`[CLIP] ❌ Objet non confirmé (sim=${clipResult.similarity} < seuil)`);
        return null;

      } catch (e) {
        if (e.response?.status === 401) throw new Error('serper_401');
        console.warn('[lensMatchWithClip] erreur:', e.message);
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
          const img1 = listing.image;
          const img2 = listing.image2;
          if (!img1) { console.warn('[worker] no img1 for', listing.shopName); continue; }
          if (!img2) { console.warn('[worker] no img2 for', listing.shopName); continue; }

          console.log('[worker] running lensMatch+CLIP pour', listing.shopName);
          const [m1, m2] = await Promise.all([lensMatchWithClip(img1), lensMatchWithClip(img2)]);
          if (isAborted()) break;

          console.log('[worker]', listing.shopName, '| m1:', !!m1, m1?.clipSimilarity || '', '| m2:', !!m2, m2?.clipSimilarity || '');

          // Les deux images doivent être confirmées par CLIP pour valider le dropshipper
          if (m1 && m2) {
            dropshippers.push({
              shopName:        listing.shopName,
              shopUrl:         listing.shopUrl || 'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar:      null,
              shopImage:       img1,
              listingUrl:      listing.link,
              clipSimilarity1: m1.clipSimilarity || null,
              clipSimilarity2: m2.clipSimilarity || null,
            });
            send({
              step: 'match',
              message: '\u2705 ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers) | CLIP: ' + m1.clipSimilarity,
              shop: dropshippers[dropshippers.length - 1],
            });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '\u274C Serper key invalid' }); return; }
        }
      }
    }

    await Promise.all(Array.from({ length: 6 }, worker));
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
    SCRAPEAPI_KEY:  !!process.env.SCRAPEAPI_KEY,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

module.exports = router;
