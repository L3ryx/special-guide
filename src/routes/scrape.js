const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListingIds, getShopNameAndImage, getShopListings, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');
const { compareImages, findBestAliMatch, extractAliImageUrls, isClipAvailable, isDinoReady } = require('../services/dinoCompare');

if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}

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


// ── MIN SALES FILTER ──
const MIN_SALES = 100;

/**
 * QUEUE 1 — Fetch metadata (shop name, image, numSales) : rapide
 * QUEUE 2 — lensMatch + DINO : lent
 *
 * Les deux queues tournent en parallèle :
 * Queue 1 alimente Queue 2 en temps réel.
 * Les images des boutiques en cours d'analyse Queue 2 sont pré-chargées
 * pendant que le worker Queue 1 précédent tourne encore.
 */
async function fetchListingsForDropship(keyword, numPages, onBatch, usedShops = [], isAborted = () => false) {
  const MAX_PAGES  = Math.min(Math.max(1, numPages || 5), 10);
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
        const { shopName, shopUrl, image, numSales } = await getShopNameAndImage(shopId, raw.listingId);
        return { shopId, shopName, shopUrl, image, numSales, listingId: raw.listingId, link: raw.link, title: raw.title };
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

      // ── FILTRE : ignorer les boutiques avec moins de MIN_SALES ventes ──
      // numSales === 0 peut signifier "API masquée" → on les garde par prudence
      // On filtre uniquement si la valeur est positive ET inférieure au seuil
      const sales = l.numSales || 0;
      if (sales > 0 && sales < MIN_SALES) {
        console.log(`[fetchListings] Skipping ${l.shopName} — only ${sales} sales (< ${MIN_SALES})`);
        continue;
      }

      shopsSeen.add(l.shopName);
      listings.push({
        listingId: l.listingId,
        link:      l.link,
        title:     l.title,
        image:     l.image,
        shopName:  l.shopName,
        shopUrl:   l.shopUrl,
        shopId:    l.shopId,
        numSales:  l.numSales || 0,
        source:    'etsy',
      });
    }
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('fetchListingsForDropship done:', listings.length, 'unique shops (>= ' + MIN_SALES + ' sales) with image');
  return listings;
}


// ── SEARCH DROPSHIP ──
router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId, numPages } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!process.env.ETSY_CLIENT_ID)   return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
  if (!SERPER_KEYS.length) return res.status(500).json({ error: 'SERPER_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  for (const [key, val] of activeSearches.entries()) {
    if (val === true) activeSearches.delete(key);
  }
  const sid = sessionId && sessionId.trim() ? sessionId.trim() : (Date.now() + Math.random()).toString(36);
  activeSearches.set(sid, false);
  const isAborted = () => activeSearches.get(sid) === true;

  try {
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
          numPages || 5,
          (page, count, avgPageMs, maxPages) => send({ step: 'scraping', page, maxPages, avgPageMs, message: '📄 Page ' + page + '/' + maxPages + ' — ' + count + ' boutiques (≥' + MIN_SALES + ' ventes)...' }),
          usedShops,
          isAborted
        ),
      ]);
    } catch(e) {
      send({ step: 'error', message: '❌ Etsy API failed: ' + e.message }); return res.end();
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

    if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped by user.' }); activeSearches.delete(sid); return res.end(); }
    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings found:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ Aucune boutique trouvée (toutes < ' + MIN_SALES + ' ventes ou déjà analysées)' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques (≥' + MIN_SALES + ' ventes). Analyse DINOv2...' });

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
              if (detail?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
              throw serperErr;
            }
            if (status === 429) {
              if (attempt < SERPER_RETRIES - 1) {
                const wait = 1500 * Math.pow(2, attempt);
                await new Promise(res => setTimeout(res, wait));
                continue;
              }
              return null;
            }
            throw serperErr;
          }
        }
        if (isAborted()) return null;

        const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
        const aliMatches = all.filter(x => {
          const u = x.link || x.url || '';
          return u.includes('aliexpress.com') && u.includes('/item/') &&
                 (x.imageUrl || x.thumbnailUrl);
        });

        if (!aliMatches.length) return null;

        const aliUrls = aliMatches
          .slice(0, 4)
          .flatMap(m => extractAliImageUrls(m))
          .filter(Boolean);

        if (!aliUrls.length) return null;

        const dinoResult = await findBestAliMatch(etsyImageUrl, aliUrls, {
          threshold: parseFloat(process.env.CLIP_THRESHOLD || '0.65'),
          hybrid: true,
        });

        if (dinoResult.fallback) return null;
        if (dinoResult.match) return { ...aliMatches[0], clipSimilarity: dinoResult.similarity };
        return null;

      } catch (e) {
        if (e.response?.status === 401) throw new Error('serper_401');
        if (e.message === 'serper_no_credits') throw e;
        console.warn('[lensMatchWithClip] erreur:', e.message);
        return null;
      }
    }

    const dropshippers = [];
    let analyzed = 0;

    // ── QUEUE 1 : Metadata (déjà récupérées) → alimente metaQueue ──
    // ── QUEUE 2 : lensMatch+DINO (lente) ──
    // Les deux queues tournent en parallèle via un canal partagé.
    // On pré-charge les images de la prochaine boutique pendant que le worker DINO tourne.

    const lensQueue = [];       // boutiques prêtes pour DINO
    let metaDone = true;        // toutes les métadonnées sont déjà disponibles

    // Pré-charger les images en avance (prefetch)
    const prefetchCache = new Map(); // imageUrl → Promise<void>
    function prefetchImage(url) {
      if (!url || prefetchCache.has(url)) return;
      prefetchCache.set(url, fetch ? undefined : undefined); // marque comme "en cours"
      // On lance un HEAD/GET silencieux pour chauffer le cache réseau côté upload
      uploadImageFree(url).then(pub => {
        if (pub) prefetchCache.set(url, pub);
      }).catch(() => {});
    }

    // Alimenter la lensQueue avec toutes les boutiques
    // et pré-charger les images en avance
    for (let i = 0; i < listings.length; i++) {
      lensQueue.push(listings[i]);
      // Pré-charger les 2 boutiques suivantes
      if (i + 1 < listings.length) prefetchImage(listings[i + 1].image);
      if (i + 2 < listings.length) prefetchImage(listings[i + 2].image);
    }

    // Worker DINO — 3 workers en parallèle (limite Serper 429)
    async function dinoWorker() {
      while (lensQueue.length > 0) {
        if (isAborted()) break;
        const listing = lensQueue.shift();
        if (!listing) continue;
        analyzed++;
        const shopStart = Date.now();
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: '\u{1F50E} ' + analyzed + '/' + listings.length + ' \u2014 ' + dropshippers.length + ' dropshippers' });

        // Pré-charger les prochaines images pendant que DINO tourne
        const nextIdx = analyzed + 2;
        if (nextIdx < listings.length) prefetchImage(listings[nextIdx].image);

        try {
          const img1 = listing.image;
          if (!img1) { console.warn('[dinoWorker] no img1 for', listing.shopName); continue; }

          const m1 = await lensMatchWithClip(img1);
          const shopElapsedMs = Date.now() - shopStart;
          send({ step: 'shop_done', done: analyzed, total: listings.length, elapsedMs: shopElapsedMs });
          if (isAborted()) break;

          if (m1) {
            const sim1 = m1?.clipSimilarity || null;
            dropshippers.push({
              shopName:        listing.shopName,
              shopUrl:         listing.shopUrl || 'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar:      null,
              shopImage:       img1,
              listingUrl:      listing.link,
              numSales:        listing.numSales || 0,
              clipSimilarity1: sim1,
            });
            send({
              step: 'match',
              message: '\u2705 ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers) | DINO: ' + sim1,
              shop: dropshippers[dropshippers.length - 1],
            });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
          if (e.message === 'serper_no_credits') { send({ step: 'error', message: '❌ Crédits Serper épuisés — recharge ton compte sur serper.dev' }); return; }
        }
      }
    }

    await Promise.all(Array.from({ length: 3 }, dinoWorker));
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


// ── CLIP WAKE-UP ──
router.get('/dino-warmup', async (req, res) => {
  try {
    const ready = await isClipAvailable();
    res.json({ ready });
  } catch {
    res.json({ ready: false });
  }
});

router.get('/health', (req, res) => {
  const keys = {
    ETSY_CLIENT_ID: !!process.env.ETSY_CLIENT_ID,
    SERPER_API_KEY:   !!process.env.SERPER_API_KEY,
    SERPER_API_KEY_2: !!process.env.SERPER_API_KEY_2,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

module.exports = router;
