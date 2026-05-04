const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListingIds, getShopNameAndImage, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');
const { ximilarRankImages } = require('../services/ximilarCompare');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}

// ── Clés Serper ──
const SERPER_KEYS = [
  process.env.SERPER_API_KEY,
  process.env.SERPER_API_KEY_2,
].filter(Boolean);
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

    const prompt = `It is ${month} ${year}. Generate a list of exactly 50 unique English niche keywords for Etsy product searches.\n\nRules:\n- Each keyword must be 2-4 words\n- ALL must be PHYSICAL products only (no digital, no printables, no SVG, no downloads, no templates)\n- All 50 must be DIFFERENT product types — no variations of the same product\n- Mix categories: home decor, jewelry, clothing, accessories, ceramics, candles, toys, stationery, wellness, outdoors, pets, baby, kitchen, garden, etc.\n- Each must be specific and searchable (not generic like "handmade gift")\n- Prioritize products trending in ${month} ${year}${excludeList}\n\nRespond with ONLY a JSON array of 50 strings, no explanation, no markdown, no numbering.\nExample format: ["keyword one","keyword two","keyword three"]`;

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
  const MAX_PAGES  = 5;
  const perPage    = 100;
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

    const pageElapsed = Date.now() - lastPageStart;
    pageTimes.push(pageElapsed);
    const avgPageMs = pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length;

    page++;
    console.log(`fetchListingsForDropship scan page ${page}/${MAX_PAGES}: ${shopIdToRaw.size} unique new shopIds`);
    if (onBatch) onBatch(page, shopIdToRaw.size, avgPageMs, MAX_PAGES);

    if (results.length < perPage) break;
    offset += perPage;
  }

  console.log('[fetchListings] Total unique shopIds to resolve:', shopIdToRaw.size);

  const BATCH = 12;
  const listings = [];
  const shopIdList = [...shopIdToRaw.entries()];

  for (let i = 0; i < shopIdList.length; i += BATCH) {
    if (isAborted()) return listings;
    const batch = shopIdList.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(
      batch.map(async ([shopId, raw]) => {
        const { shopName, shopUrl, image } = await getShopNameAndImage(shopId, raw.listingId);
        return { shopId, shopName, shopUrl, image, listingId: raw.listingId, link: raw.link, title: raw.title };
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
      listings.push({
        listingId: l.listingId,
        link:      l.link,
        title:     l.title,
        image:     l.image,
        shopName:  l.shopName,
        shopUrl:   l.shopUrl,
        shopId:    l.shopId,
        source:    'etsy',
      });
    }
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('fetchListingsForDropship done:', listings.length, 'unique shops with image');
  return listings;
}


// ── SEARCH DROPSHIP ──
router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!process.env.ETSY_CLIENT_ID) return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
  if (!SERPER_KEYS.length)         return res.status(500).json({ error: 'SERPER_API_KEY missing' });

  // Ximilar est optionnel — si la clé manque, on skippe la vérification visuelle
  const useXimilar = !!process.env.XIMILAR_API_KEY;

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

    // ── STEP 2 : Scraping Etsy ──
    send({ step: 'scraping', message: '🔍 Recherche Etsy pour "' + keyword + '"...' });

    let listings = [];
    try {
      listings = await fetchListingsForDropship(
        keyword,
        (page, count, avgPageMs, maxPages) => send({ step: 'scraping', page, maxPages, avgPageMs, message: '📄 Page ' + page + '/7 — ' + count + ' boutiques...' }),
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

    const modeLabel = useXimilar ? 'Google Lens + Ximilar' : 'Google Lens';
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques uniques. Analyse ' + modeLabel + '...' });

    // ── STEP 3 : Google Lens puis Ximilar ──
    const { uploadImageFree } = require('../services/freeImageUploader');

    /**
     * Étape Lens : retourne l'image Etsy uploadée (pubUrl) + les candidats AliExpress
     * @returns {{ pubUrl: string, aliMatches: object[] }|null}
     */
    async function lensSearch(etsyImageUrl) {
      if (!etsyImageUrl || isAborted()) return null;

      const pubUrl = await uploadImageFree(etsyImageUrl);
      if (!pubUrl || isAborted()) return null;

      let r;
      const SERPER_RETRIES = 3;
      for (let attempt = 0; attempt < SERPER_RETRIES; attempt++) {
        try {
          r = await axios.post('https://google.serper.dev/lens',
            { url: pubUrl, gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': getSerperKey() }, timeout: 25000 }
          );
          break;
        } catch (serperErr) {
          const status = serperErr.response?.status;
          const detail = serperErr.response?.data;

          if (status === 400) {
            console.warn('[lensSearch] Serper 400:', JSON.stringify(detail));
            if (detail?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
            throw serperErr;
          }
          if (status === 429) {
            if (attempt < SERPER_RETRIES - 1) {
              const wait = 1500 * Math.pow(2, attempt);
              console.warn(`[lensSearch] Serper 429 — retry dans ${wait}ms`);
              await new Promise(res => setTimeout(res, wait));
              continue;
            }
            console.warn('[lensSearch] Serper 429 — skip');
            return null;
          }
          throw serperErr;
        }
      }
      if (isAborted()) return null;

      const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
      const aliMatches = all.filter(x => {
        const u = x.link || x.url || '';
        return u.includes('aliexpress.com') && u.includes('/item/') && (x.imageUrl || x.thumbnailUrl);
      });

      if (!aliMatches.length) return null;

      console.log(`[Lens] ✅ ${aliMatches.length} candidats AliExpress`);
      return { pubUrl, aliMatches };
    }

    /**
     * Pipeline complet pour une image :
     *  1. Lens → candidats AliExpress
     *  2. Ximilar rank_images → confirmation visuelle (si clé dispo)
     *
     * @returns {{ aliMatch: object, ximilarDistance: number|null }|null}
     */
    async function analyzeImage(etsyImageUrl) {
      if (isAborted()) return null;
      try {
        const lensResult = await lensSearch(etsyImageUrl);
        if (!lensResult) return null;

        const { pubUrl, aliMatches } = lensResult;

        // Sans Ximilar → on accepte le premier match Lens directement
        if (!useXimilar) {
          return { aliMatch: aliMatches[0], ximilarDistance: null };
        }

        // Avec Ximilar → vérification visuelle sur les images AliExpress
        const aliImageUrls = aliMatches
          .slice(0, 10)
          .map(m => m.imageUrl || m.thumbnailUrl)
          .filter(Boolean);

        if (!aliImageUrls.length) return null;

        const xResult = await ximilarRankImages(pubUrl, aliImageUrls);

        if (xResult.fallback) {
          // Service indisponible → on accepte le match Lens sans confirmation
          console.warn('[analyzeImage] Ximilar fallback — match Lens accepté sans confirmation visuelle');
          return { aliMatch: aliMatches[0], ximilarDistance: null };
        }

        if (!xResult.match) {
          console.log(`[analyzeImage] ❌ Ximilar rejette (distance=${xResult.distance})`);
          return null;
        }

        console.log(`[analyzeImage] ✅ Ximilar confirme (distance=${xResult.distance})`);
        return { aliMatch: aliMatches[0], ximilarDistance: xResult.distance };

      } catch (e) {
        if (e.message === 'serper_401') throw e;
        if (e.message === 'serper_no_credits') throw e;
        if (e.message === 'ximilar_401') throw e;
        if (e.message === 'ximilar_no_credits') throw e;
        console.warn('[analyzeImage] erreur:', e.message);
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
        const shopStart = Date.now();
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: '\u{1F50E} ' + analyzed + '/' + listings.length + ' \u2014 ' + dropshippers.length + ' dropshippers' });

        try {
          const img1 = listing.image;
          if (!img1) { console.warn('[worker] no img1 for', listing.shopName); continue; }

          console.log('[worker] analyse', listing.shopName);
          const r1 = await analyzeImage(img1);

          const shopElapsedMs = Date.now() - shopStart;
          send({ step: 'shop_done', done: analyzed, total: listings.length, elapsedMs: shopElapsedMs });
          if (isAborted()) break;

          console.log('[worker]', listing.shopName,
            '| img1:', r1 ? `✅ (dist=${r1.ximilarDistance ?? 'lens'})` : '❌'
          );

          if (r1) {
            dropshippers.push({
              shopName:        listing.shopName,
              shopUrl:         listing.shopUrl || 'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar:      null,
              shopImage:       img1,
              listingUrl:      listing.link,
              ximilarDistance: r1.ximilarDistance,
            });
            const distLabel = r1.ximilarDistance !== null
              ? ` | Ximilar: ${r1.ximilarDistance}`
              : '';
            send({
              step:    'match',
              message: '\u2705 ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers)' + distLabel,
              shop:    dropshippers[dropshippers.length - 1],
            });
          }

        } catch (e) {
          if (e.message === 'serper_401')       { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
          if (e.message === 'serper_no_credits') { send({ step: 'error', message: '❌ Crédits Serper épuisés — recharge ton compte sur serper.dev' }); return; }
          if (e.message === 'ximilar_401')       { send({ step: 'error', message: '❌ Ximilar API key invalide' }); return; }
          if (e.message === 'ximilar_no_credits'){ send({ step: 'error', message: '❌ Crédits Ximilar épuisés — vérifie ton plan sur ximilar.com' }); return; }
        }
      }
    }

    // 3 workers max — au-delà, Serper retourne 429
    await Promise.all(Array.from({ length: 3 }, worker));
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
    ETSY_CLIENT_ID:   !!process.env.ETSY_CLIENT_ID,
    SERPER_API_KEY:   !!process.env.SERPER_API_KEY,
    SERPER_API_KEY_2: !!process.env.SERPER_API_KEY_2,
    XIMILAR_API_KEY:  !!process.env.XIMILAR_API_KEY,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

module.exports = router;
