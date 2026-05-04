const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListingIds, getShopNameAndImage, getShopListings, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');
// DINOv2 : comparaison visuelle objet Etsy ↔ AliExpress (HuggingFace, gratuit)
const { compareImages, findBestAliMatch, extractAliImageUrls, isClipAvailable, isDinoReady } = require('../services/dinoCompare');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}


// ── Clé Serper unique ──
const SERPER_KEYS = [
  process.env.SERPER_API_KEY,
  process.env.SERPER_API_KEY_2,
].filter(Boolean); // FIX : support 2ème clé de backup (SERPER_API_KEY_2)
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

// ── NICHE KEYWORD — génère 1 keyword tendance avant chaque recherche ──
router.post('/niche-keyword', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing' });
  try {
    const now = new Date();
    const month = now.toLocaleString('en', { month: 'long' });
    const year = now.getFullYear();
    const usedKeywords = req.body?.usedKeywords || [];
    const excludeList = usedKeywords.length > 0
      ? `\nDo NOT suggest any of these already-used keywords: ${usedKeywords.slice(-100).join(', ')}.`
      : '';

    const prompt = `It is ${month} ${year}. Suggest ONE trending Etsy search keyword for physical products.

Rules:
- Physical products only (no digital, no printables, no SVG, no downloads, no templates)
- 2-4 words maximum
- Specific and searchable on Etsy right now
- Trending or seasonal for ${month} ${year}
- Vary the category each time (home decor, jewelry, clothing, accessories, candles, toys, wellness, pets, kitchen, garden, etc.)${excludeList}

Respond with ONLY the keyword, no explanation, no punctuation, no quotes.
Example: resin ocean lamp`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const parts = r.data.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(p => p.text || '').join(' ').trim();
    const keyword = rawText
      .replace(/```.*?```/gs, '')
      .replace(/[^a-z0-9 ]/gi, '')
      .trim()
      .toLowerCase()
      .slice(0, 60);

    if (!keyword || keyword.length < 2) throw new Error('Empty keyword returned');
    res.json({ keyword });
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
        // Toujours aller chercher un 2ème listing directement dans la boutique,
        // indépendamment de ce qu'on a trouvé dans les résultats de recherche.
        let listingId2 = null;
        try {
          const shopListings = await getShopListings(shopId, 5);
          const other = shopListings.find(l => l.listingId && String(l.listingId) !== String(raw.listingId));
          if (other) listingId2 = other.listingId;
        } catch (e) {
          console.warn('[fetchListings] getShopListings failed for shop', shopId, ':', e.message);
        }

        const { shopName, shopUrl, image, image2 } = await getShopNameAndImage(shopId, raw.listingId, listingId2);
        return { shopId, shopName, shopUrl, image, image2, listingId: raw.listingId, link: raw.link, title: raw.title };
      })
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
    await new Promise(r => setTimeout(r, 50));
  }

  console.log('fetchListingsForDropship done:', listings.length, 'unique shops with image');
  return listings;
}


// ── SEARCH DROPSHIP ──
router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!process.env.ETSY_CLIENT_ID)   return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
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
        // First check: is the service reachable at all (ready OR loading)?
        const reachable = await isClipAvailable().catch(() => false);
        if (!reachable) continue;
        // Second check: is the model fully loaded?
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
    console.log('[search-dropship] ✅ DINOv2 disponible — comparaison visuelle obligatoire');

    if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped by user.' }); activeSearches.delete(sid); return res.end(); }
    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings found:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ Aucune boutique trouvée dans les résultats Etsy' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques uniques. Analyse DINOv2...' });

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
    const { uploadImageFree } = require('../services/freeImageUploader');

    async function lensMatchWithClip(etsyImageUrl) {
      if (isAborted()) return null;
      try {
        if (!etsyImageUrl || isAborted()) return null;

        // ── Étape 0 : upload vers un hébergeur public gratuit ──
        // Serper Lens nécessite une URL publique (les URLs i.etsystatic.com sont rejetées).
        // On utilise 0x0.st avec fallback sur litterbox — sans clé API.
        const pub = await uploadImageFree(etsyImageUrl);
        if (!pub || isAborted()) return null;

        // ── Étape 1 : Google Lens pour trouver des candidats AliExpress ──
        // Retry automatique sur 429 (rate limit Serper) avec backoff exponentiel
        let r;
        const SERPER_RETRIES = 3;
        for (let attempt = 0; attempt < SERPER_RETRIES; attempt++) {
          try {
            r = await axios.post('https://google.serper.dev/lens',
              { url: pub, gl: 'us', hl: 'en' },
              { headers: { 'X-API-KEY': getSerperKey() }, timeout: 25000 }
            );
            break; // succès → sort du loop
          } catch (serperErr) {
            const status = serperErr.response?.status;
            const detail = serperErr.response?.data;

            if (status === 400) {
              console.warn('[lensMatchWithClip] Serper 400 — détail:', JSON.stringify(detail));
              if (detail?.message?.toLowerCase().includes('not enough credits')) {
                throw new Error('serper_no_credits');
              }
              throw serperErr; // autre 400 non récupérable
            }

            if (status === 429) {
              if (attempt < SERPER_RETRIES - 1) {
                const wait = 1500 * Math.pow(2, attempt); // 1.5s, 3s
                console.warn(`[lensMatchWithClip] Serper 429 — rate limit, retry dans ${wait}ms`);
                await new Promise(res => setTimeout(res, wait));
                continue;
              }
              // Dernier essai épuisé → on skip silencieusement (pas un crash)
              console.warn('[lensMatchWithClip] Serper 429 — skip après', SERPER_RETRIES, 'tentatives');
              return null;
            }

            throw serperErr; // autre erreur (réseau, 5xx…)
          }
        }
        if (isAborted()) return null;

        const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
        const aliMatches = all.filter(x => {
          const u = x.link || x.url || '';
          return u.includes('aliexpress.com') && u.includes('/item/') &&
                 (x.imageUrl || x.thumbnailUrl);
        });

        // Pas de candidat AliExpress trouvé par Serper → pas de match
        if (!aliMatches.length) return null;

        // Étape 2 : DINOv2 — vérification visuelle OBLIGATOIRE
        const aliUrls = aliMatches
          .slice(0, 4) // augmenté à 4 candidats pour plus de chances de match
          .flatMap(m => extractAliImageUrls(m))
          .filter(Boolean);

        if (!aliUrls.length) {
          // Serper n'a retourné aucune image AliExpress utilisable → refus
          console.log(`[DINO] ❌ Aucune image AliExpress exploitable pour DINOv2`);
          return null;
        }

        const dinoResult = await findBestAliMatch(etsyImageUrl, aliUrls, {
          threshold: parseFloat(process.env.CLIP_THRESHOLD || '0.65'),
          hybrid: true,
        });

        console.log(`[DINO] sim=${dinoResult.similarity} match=${dinoResult.match} fallback=${dinoResult.fallback}`);

        // Si le service DINOv2 est en 500 (fallback=true) → on skip ce shop et on log
        if (dinoResult.fallback) {
          console.warn(`[DINO] ⚠️ Service DINOv2 retourne 500/indisponible — shop ignoré (${etsyImageUrl?.slice(-30)})`);
          return null;
        }

        // DINOv2 confirme l'objet → match validé
        if (dinoResult.match) {
          return { ...aliMatches[0], clipSimilarity: dinoResult.similarity };
        }

        // DINOv2 rejette l'objet → pas de match même si Serper avait trouvé quelque chose
        console.log(`[DINO] ❌ Objet non confirmé (sim=${dinoResult.similarity} < seuil)`);
        return null;

      } catch (e) {
        if (e.response?.status === 401) throw new Error('serper_401');
        if (e.message === 'serper_no_credits') throw e; // remonte pour stopper la recherche
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
        const shopStart = Date.now();
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: '\u{1F50E} ' + analyzed + '/' + listings.length + ' \u2014 ' + dropshippers.length + ' dropshippers' });
        try {
          const img1 = listing.image;
          const img2 = listing.image2;
          if (!img1) { console.warn('[worker] no img1 for', listing.shopName); continue; }
          if (!img2) { console.warn('[worker] no img2 for', listing.shopName); continue; }

          console.log('[worker] running lensMatch+CLIP pour', listing.shopName);
          const [m1, m2] = await Promise.all([lensMatchWithClip(img1), lensMatchWithClip(img2)]);
          const shopElapsedMs = Date.now() - shopStart;
          send({ step: 'shop_done', done: analyzed, total: listings.length, elapsedMs: shopElapsedMs });
          if (isAborted()) break;

          console.log('[worker]', listing.shopName, '| m1:', !!m1, m1?.clipSimilarity || '', '| m2:', !!m2, m2?.clipSimilarity || '');

          // Au moins une image confirmée par DINOv2 suffit pour valider le dropshipper
          if (m1 && m2) {
            const sim1 = m1?.clipSimilarity || null;
            const sim2 = m2?.clipSimilarity || null;

            // ── Récupérer numSales + date création pour calculer salesPerYear ──
            let numSales = null;
            let salesPerYear = null;
            try {
              const info = await getShopInfo(listing.shopId || listing.shopName);
              numSales = info.numSales || 0;
              if (info.createdAt) {
                const ageMs    = Date.now() - info.createdAt * 1000;
                const ageYears = Math.max(ageMs / (1000 * 60 * 60 * 24 * 365.25), 0.083);
                salesPerYear = Math.round(numSales / ageYears);
              }
            } catch(e) {
              console.warn('[worker] getShopInfo failed for', listing.shopName, ':', e.message);
            }

            dropshippers.push({
              shopName:        listing.shopName,
              shopUrl:         listing.shopUrl || 'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar:      null,
              shopImage:       img1,
              listingUrl:      listing.link,
              clipSimilarity1: sim1,
              clipSimilarity2: sim2,
              numSales,
              salesPerYear,
            });
            send({
              step: 'match',
              message: '\u2705 ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers) | DINO: ' + (sim1 || sim2),
              shop: dropshippers[dropshippers.length - 1],
            });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
          if (e.message === 'serper_no_credits') { send({ step: 'error', message: '❌ Crédits Serper épuisés — recharge ton compte sur serper.dev' }); return; }
        }
      }
    }

    // 3 workers max — au-delà, Serper retourne 429 (rate limit)
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


// ── CLIP WAKE-UP ──
// Appelé au chargement de la page pour réveiller HuggingFace avant la recherche
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
