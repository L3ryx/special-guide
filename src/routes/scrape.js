const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListingIds, getShopNameAndImage, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');

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
async function fetchListingsForDropship(keyword, onBatch, usedShops = [], isAborted = () => false, maxPages = 5) {
  const MAX_PAGES  = maxPages;
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
        const { shopName, shopUrl, image, image2 } = await getShopNameAndImage(shopId, raw.listingId, raw.listingId2 || null);
        return { shopId, shopName, shopUrl, image, image2: image2 || null, listingId: raw.listingId, link: raw.link, title: raw.title };
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
        image2:    l.image2 || null,
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
  const { keyword, sessionId, pages } = req.body;
  const maxPages = Math.min(Math.max(parseInt(pages) || 5, 1), 10);
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!process.env.ETSY_CLIENT_ID) return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
  if (!SERPER_KEYS.length)         return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  if (!process.env.VISUAL_API_URL) return res.status(500).json({ error: 'VISUAL_API_URL missing — pipeline DINOv2 requis' });

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
        (page, count, avgPageMs, maxPages) => send({ step: 'scraping', page, maxPages, avgPageMs, message: '📄 Page ' + page + '/' + maxPages + ' — ' + count + ' boutiques...' }),
        usedShops,
        isAborted,
        maxPages
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

    send({ step: 'analyzing', message: '✅ ' + listings.length + ' boutiques uniques. Analyse Google Lens...' });

    // ── STEP 3 : Google Lens ──
    const { uploadImageFree } = require('../services/freeImageUploader');

    /**
     * Lance Google Lens sur UNE image Etsy et retourne les top 2 candidats AliExpress.
     * @returns {Array} aliMatches (max 2)
     */
    async function lensSearch(etsyImageUrl) {
      if (!etsyImageUrl || isAborted()) return [];

      const pubUrl = await uploadImageFree(etsyImageUrl);
      if (!pubUrl || isAborted()) return [];

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
            return [];
          }
          throw serperErr;
        }
      }
      if (isAborted()) return [];

      const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
      return all.filter(x => {
        const u = x.link || x.url || '';
        return u.includes('aliexpress.com') && u.includes('/item/') && (x.imageUrl || x.thumbnailUrl);
      }).slice(0, 2);  // top 2 AliExpress
    }

    /**
     * Lance le pipeline SAM + DINOv2 pour comparer une image Etsy avec une image AliExpress.
     * Fond blanc forcé pour normaliser le style des deux images.
     * @returns {number|null} visualSimilarity
     */
    async function runVisualPipeline(etsyImageUrl, aliImageUrl) {
      // VISUAL_API_URL est garanti présent (vérifié en entrée de route)
      try {
        console.log('[visualPipeline] Lancement SAM + DINOv2 (fond blanc)...');

        // STEP 1 — Segmentation SAM
        const samRes = await axios.post(
          `${process.env.VISUAL_API_URL}/segment`,
          { images: [etsyImageUrl, aliImageUrl] },
          { timeout: 30000 }
        );
        const masks = samRes.data?.masks || [];

        // STEP 2 — Extraction objet, fond blanc normalisé
        const extractRes = await axios.post(
          `${process.env.VISUAL_API_URL}/extract`,
          { images: [etsyImageUrl, aliImageUrl], masks, background: 'white' },
          { timeout: 30000 }
        );
        const croppedImages = extractRes.data?.croppedImages || [];

        // STEP 3 — Features DINOv2
        const dinoRes = await axios.post(
          `${process.env.VISUAL_API_URL}/features`,
          { images: croppedImages },
          { timeout: 30000 }
        );
        const features = dinoRes.data?.features || [];

        // STEP 4 — Patch filtering
        const patchRes = await axios.post(
          `${process.env.VISUAL_API_URL}/filter-patches`,
          { features, masks },
          { timeout: 30000 }
        );
        const filteredPatches = patchRes.data?.filteredPatches || [];

        // STEP 5 — Score similarité
        if (features.length >= 2 && filteredPatches.length >= 2) {
          const scoreRes = await axios.post(
            `${process.env.VISUAL_API_URL}/similarity`,
            {
              featuresA: { cls_embedding: features[0]?.cls_embedding, patch_tokens: filteredPatches[0] },
              featuresB: { cls_embedding: features[1]?.cls_embedding, patch_tokens: filteredPatches[1] },
            },
            { timeout: 15000 }
          );
          const sim = scoreRes.data?.similarity ?? null;
          console.log(`[visualPipeline] ✅ Score : ${sim} | is_dropship: ${scoreRes.data?.is_dropship}`);
          return scoreRes.data;  // { similarity, is_dropship, threshold, ... }
        }
        return null;
      } catch (e) {
        const status = e.response?.status;
        const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error(`[visualPipeline] ❌ Erreur DINOv2 — HTTP ${status || 'réseau'} : ${detail}`);
        throw new Error('dinov2_unavailable');
      }
    }

    /**
     * Analyse une boutique Etsy :
     * - Lance Lens sur image1 ET image2 du listing
     * - Pour chaque image Etsy, teste les top 2 candidats AliExpress
     * - Retourne dès le premier match (1 seul match suffit)
     */
    async function analyzeImage(img1, img2) {
      const etsyImages = [img1, img2].filter(Boolean);

      for (const etsyImg of etsyImages) {
        if (isAborted()) return null;
        console.log(`[analyzeImage] Lens sur image Etsy: ${etsyImg.slice(0, 60)}`);

        let aliCandidates;
        try {
          aliCandidates = await lensSearch(etsyImg);
        } catch(e) {
          throw e;  // remonte serper_no_credits etc.
        }

        if (!aliCandidates.length) {
          console.log('[analyzeImage] ❌ Aucun candidat AliExpress pour cette image');
          continue;
        }

        console.log(`[analyzeImage] ${aliCandidates.length} candidats AliExpress trouvés`);

        // Tester top 2 AliExpress — retourner dès le 1er match
        for (const aliMatch of aliCandidates) {
          if (isAborted()) return null;
          const aliImageUrl = aliMatch.imageUrl || aliMatch.thumbnailUrl || null;
          if (!aliImageUrl) continue;

          const pipelineResult = await runVisualPipeline(etsyImg, aliImageUrl);

          // DINOv2 obligatoire — si le pipeline ne répond pas, on arrête
          if (!pipelineResult) {
            console.error(`[analyzeImage] ❌ Pipeline DINOv2 sans résultat — arrêt`);
            throw new Error('dinov2_unavailable');
          }

          if (pipelineResult.is_dropship) {
            console.log(`[analyzeImage] ✅ Match DINOv2 — sim: ${pipelineResult.similarity} — ${(aliMatch.link || '').slice(0, 60)}`);
            return { aliMatch, visualSimilarity: pipelineResult.similarity };
          }

          console.log(`[analyzeImage] ❌ Similarité insuffisante (${pipelineResult.similarity}) — candidat suivant`);
        }
      }

      console.log('[analyzeImage] ❌ Aucun match après toutes les combinaisons');
      return null;
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
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: `🔎 ${analyzed}/${listings.length} — ${dropshippers.length} dropshippers` });

        try {
          const img1 = listing.image;
          const img2 = listing.image2 || null;
          if (!img1) { console.warn('[worker] no img1 for', listing.shopName); continue; }

          console.log('[worker] analyse', listing.shopName, '| images:', img1 ? 1 : 0, img2 ? '+1' : '');
          const r1 = await analyzeImage(img1, img2);

          const shopElapsedMs = Date.now() - shopStart;
          send({ step: 'shop_done', done: analyzed, total: listings.length, elapsedMs: shopElapsedMs });
          if (isAborted()) break;

          console.log('[worker]', listing.shopName, '| Lens:', r1 ? '✅' : '❌');

          if (r1) {
            dropshippers.push({
              shopName:         listing.shopName,
              shopUrl:          listing.shopUrl || 'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar:       null,
              shopImage:        img1,
              listingUrl:       listing.link,
              aliUrl:           r1.aliMatch.link || r1.aliMatch.url || null,
              aliImage:         r1.aliMatch.imageUrl || r1.aliMatch.thumbnailUrl || null,
              visualSimilarity: r1.visualSimilarity ?? null,
            });
            const simLabel = r1.visualSimilarity !== null
              ? ` | Similarité DINOv2 : ${(r1.visualSimilarity * 100).toFixed(1)}%`
              : '';
            send({
              step:    'match',
              message: `✅ ${listing.shopName} (${dropshippers.length} dropshippers) | Lens match${simLabel}`,
              shop:    dropshippers[dropshippers.length - 1],
            });
          }

        } catch (e) {
          if (e.message === 'serper_401')         { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
          if (e.message === 'serper_no_credits')  { send({ step: 'error', message: '❌ Crédits Serper épuisés — recharge sur serper.dev' }); return; }
          if (e.message === 'dinov2_unavailable') { send({ step: 'error', message: '❌ Pipeline DINOv2 indisponible — vérifier VISUAL_API_URL et le serveur Python' }); return; }
          // Toute erreur non identifiée : logger + stopper (ne jamais avaler silencieusement)
          console.error('[worker] ❌ Erreur inattendue sur', listing?.shopName, ':', e.message, e.stack);
          send({ step: 'error', message: '❌ Erreur inattendue : ' + e.message });
          return;
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
    VISUAL_API_URL:   !!process.env.VISUAL_API_URL,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

module.exports = router;
