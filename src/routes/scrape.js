'use strict';

const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

const {
  searchListingIds,
  getSecondShopImage,
  getShopInfo,
  getListingDetail,
  isScraperAvailable,
} = require('../services/etsyScraper');

const {
  findBestAliMatch,
  extractAliImageUrls,
  isClipAvailable,
  isDinoReady,
} = require('../services/dinoCompare');

if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}

// ── Serper key pool ───────────────────────────────────────────────────────────

const SERPER_KEYS = [process.env.SERPER_API_KEY].filter(Boolean);
let _serperKeyIndex = 0;
function getSerperKey() {
  const key = SERPER_KEYS[_serperKeyIndex % SERPER_KEYS.length];
  _serperKeyIndex++;
  return key;
}

// ── Sessions actives (pour arrêt recherche) ───────────────────────────────────

const activeSearches = new Map();

router.post('/stop-search', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && activeSearches.has(sessionId)) activeSearches.set(sessionId, true);
  res.json({ ok: true });
});

// ── Niche Keyword (Gemini) ────────────────────────────────────────────────────

router.post('/niche-keyword', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing' });
  try {
    const now          = new Date();
    const month        = now.toLocaleString('en', { month: 'long' });
    const year         = now.getFullYear();
    const usedKeywords = req.body?.usedKeywords || [];
    const excludeList  = usedKeywords.length
      ? `\nDo NOT include any of these already-used keywords: ${usedKeywords.join(', ')}.`
      : '';

    const prompt = `It is ${month} ${year}. Generate a list of exactly 50 unique English niche keywords for Etsy product searches.\n\nRules:\n- Each keyword must be 2-4 words\n- ALL must be PHYSICAL products only (no digital, no printables, no SVG, no downloads, no templates)\n- All 50 must be DIFFERENT product types\n- Mix categories: home decor, jewelry, clothing, accessories, ceramics, candles, toys, stationery, wellness, outdoors, pets, baby, kitchen, garden, etc.\n- Each must be specific and searchable\n- Prioritize products trending in ${month} ${year}${excludeList}\n\nRespond with ONLY a JSON array of 50 strings, no explanation, no markdown.\nExample: [\"keyword one\",\"keyword two\"]`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const parts   = r.data.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(p => p.text || '').join(' ').trim();
    const clean   = rawText.replace(/```json|```/g, '').trim();
    let keywords  = JSON.parse(clean);
    if (!Array.isArray(keywords)) throw new Error('Invalid response format');
    keywords = [...new Set(keywords.map(k => k.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()))].filter(k => k.length > 2).slice(0, 50);
    res.json({ keywords });
  } catch (e) {
    res.status(500).json({ error: e.response?.data ? JSON.stringify(e.response.data) : e.message });
  }
});

// ── fetchListingsForDropship ──────────────────────────────────────────────────
//
// 1. Scrape les pages de résultats Etsy via etsyScraper (Playwright + stealth).
//    → 1 listing par boutique, dédupliqué.
//    → Chaque listing : listingId, image, shopName (si trouvé), shopUrl, title.
//
// 2. Pour chaque boutique : visite la page boutique pour obtenir une 2ème image
//    (listing différent) → améliore les chances de match AliExpress.
//
// Note : shopName peut être null si Etsy ne l'expose pas dans la page.
//        On garde le listing quand même — l'image suffit pour la comparaison.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchListingsForDropship(keyword, onBatch, usedShops, isAborted) {
  usedShops = usedShops || [];
  isAborted = isAborted || (() => false);

  const MAX_PAGES    = 7;
  const shopsSeen    = new Set(usedShops);
  const seenShopKeys = new Set(usedShops);
  const rawListings  = [];
  const pageTimes    = [];

  // ── Étape 1 : Scraping des pages Etsy ────────────────────────────────────

  for (let page = 1; page <= MAX_PAGES; page++) {
    if (isAborted()) return [];

    const pageStart = Date.now();
    if (page > 1) await new Promise(r => setTimeout(r, 1200 + Math.floor(Math.random() * 1800)));

    console.log(`[fetchListings] Page ${page}/${MAX_PAGES} | keyword="${keyword}"`);

    let pageResults;
    try {
      pageResults = await searchListingIds(keyword, 64, (page - 1) * 64);
    } catch (e) {
      console.error(`[fetchListings] Page ${page} erreur: ${e.message}`);
      if (e.message.includes('captcha') || e.message.includes('403')) break;
      continue;
    }

    if (!pageResults || pageResults.length === 0) {
      console.log(`[fetchListings] Page ${page} vide — arrêt`);
      break;
    }

    let newThisPage = 0;
    for (const r of pageResults) {
      if (!r.listingId || !r.image) continue;

      // Déduplication par shopName si dispo, sinon par listingId
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

    console.log(`[fetchListings] Page ${page}: +${newThisPage} nouvelles | total=${rawListings.length}`);
    if (onBatch) onBatch(page, rawListings.length, avgPageMs, MAX_PAGES);
  }

  console.log(`[fetchListings] Scraping terminé: ${rawListings.length} boutiques`);
  if (isAborted() || rawListings.length === 0) return rawListings.length === 0 ? [] : [];

  // ── Étape 2 : 2ème image par boutique ────────────────────────────────────
  // Visite la page boutique pour récupérer l'image d'un autre listing.
  // Si shopUrl non disponible (shopName null) : on laisse image2 vide.

  const BATCH    = 5;
  const listings = [];

  for (let i = 0; i < rawListings.length; i += BATCH) {
    if (isAborted()) return listings;

    const batch    = rawListings.slice(i, i + BATCH);
    const resolved = await Promise.allSettled(batch.map(async (raw) => {
      let image2 = null;

      if (raw.shopUrl && raw.hasRealShopName) {
        image2 = await getSecondShopImage(raw.shopUrl, raw.listingId).catch(() => null);
      }

      return {
        listingId:       raw.listingId,
        listingUrl:      raw.link,
        link:            raw.link,
        title:           raw.title,
        image:           raw.image,
        image2:          image2 || raw.image, // fallback sur image principale
        shopName:        raw.shopName,
        shopUrl:         raw.shopUrl || raw.link,
        shopImage:       raw.image,
        shopAvatar:      raw.image,
        shopId:          null,
        hasRealShopName: raw.hasRealShopName,
        source:          'etsy',
      };
    }));

    for (const r of resolved) {
      if (r.status !== 'fulfilled') {
        console.warn('[fetchListings] Résolution échouée:', r.reason?.message);
        continue;
      }
      const l = r.value;

      // On garde tout listing avec une image — shopName non obligatoire
      if (!l.image) continue;

      // Déduplication globale (inclut usedShops)
      const dedupeKey = l.shopName || l.listingId;
      if (shopsSeen.has(dedupeKey)) continue;
      shopsSeen.add(dedupeKey);

      listings.push(l);
    }
  }

  console.log(`[fetchListings] Résultat final: ${listings.length} boutiques avec images`);
  return listings;
}

// ── POST /search-dropship ─────────────────────────────────────────────────────

router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });
  if (!SERPER_KEYS.length) return res.status(500).json({ error: 'SERPER_API_KEY manquant' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  // Nettoyer les sessions périmées
  for (const [key, val] of activeSearches.entries()) {
    if (val === true) activeSearches.delete(key);
  }
  const sid = sessionId?.trim() || (Date.now() + Math.random()).toString(36);
  activeSearches.set(sid, false);
  const isAborted = () => activeSearches.get(sid) === true;

  try {
    // ── Vérification scraper ──────────────────────────────────────────────
    const scraperOk = await isScraperAvailable();
    if (!scraperOk) {
      send({ step: 'error', message: '❌ Scraper Etsy indisponible. Réessayez dans quelques minutes.' });
      return res.end();
    }

    // ── Boutiques déjà analysées (usedShops) ─────────────────────────────
    const AutoSearchState = require('../models/autoSearchModel');
    let usedShops = [];
    try {
      const jwt        = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET;
      const header     = req.headers.authorization || '';
      const token      = header.startsWith('Bearer ') ? header.slice(7) : null;
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        const state   = await AutoSearchState.findOne({ userId: decoded.id });
        if (state?.usedShops?.length) {
          usedShops = state.usedShops;
          console.log('[search-dropship] Exclusion de', usedShops.length, 'boutiques déjà analysées');
        }
      }
    } catch (e) {
      console.warn('[search-dropship] usedShops non chargé:', e.message);
    }

    send({ step: 'analyzing', message: '🤖 Vérification DINOv2...' });
    send({ step: 'scraping',  message: `🔍 Recherche Etsy — "${keyword}"...` });

    // ── DINOv2 + scraping en parallèle ───────────────────────────────────
    async function waitForDino(maxAttempts, delayMs) {
      maxAttempts = maxAttempts || 8;
      delayMs     = delayMs     || 20000;
      for (let i = 0; i < maxAttempts; i++) {
        if (!await isClipAvailable().catch(() => false)) { await new Promise(r => setTimeout(r, delayMs)); continue; }
        if ( await isDinoReady().catch(() => false))     return true;
        if (i < maxAttempts - 1) {
          send({ step: 'analyzing', message: `⏳ DINOv2 en démarrage (${i + 1}/${maxAttempts}) — attente ${delayMs / 1000}s...` });
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
          (page, count, avgPageMs, maxPages) =>
            send({ step: 'scraping', page, maxPages, avgPageMs, message: `📄 Page ${page}/7 — ${count} boutiques...` }),
          usedShops,
          isAborted
        ),
      ]);
    } catch (e) {
      send({ step: 'error', message: '❌ Scraping Etsy échoué: ' + e.message });
      return res.end();
    }

    if (isAborted()) {
      send({ step: 'stopped', message: '🛑 Recherche arrêtée.' });
      activeSearches.delete(sid);
      return res.end();
    }

    if (!dinoReady) {
      send({ step: 'error', message: '❌ DINOv2 indisponible. Réessayez dans 1-2 min (démarrage HuggingFace ~60-90s).' });
      activeSearches.delete(sid);
      return res.end();
    }

    send({ step: 'analyzing', message: '✅ DINOv2 prêt — comparaison visuelle activée' });

    // ── Filtre : garder tout listing avec une image ───────────────────────
    // shopName peut être null — l'image suffit pour Serper Lens + DINOv2
    const MAX_LISTINGS = Number(process.env.MAX_ANALYZE_LISTINGS || 24);
    listings = listings.filter(l => l.image).slice(0, MAX_LISTINGS);
    console.log(`[search-dropship] ${listings.length} listings prêts pour analyse`);

    if (!listings.length) {
      const hint = '(Essayez un autre mot-clé, ou vérifiez que le scraper Etsy tourne correctement sur Render)';
      send({ step: 'error', message: `❌ Aucun résultat Etsy trouvé pour "${keyword}". ${hint}` });
      activeSearches.delete(sid);
      return res.end();
    }

    send({ step: 'analyzing', message: `✅ ${listings.length} boutiques. Analyse Serper Lens + DINOv2...` });

    // ── Serper Lens + DINOv2 pour chaque listing ──────────────────────────
    const { uploadImageFree } = require('../services/freeImageUploader');

    async function lensMatchWithClip(etsyImageUrl) {
      if (!etsyImageUrl || isAborted()) return null;
      try {
        const pub = await uploadImageFree(etsyImageUrl);
        if (!pub || isAborted()) return null;

        let r;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            r = await axios.post(
              'https://google.serper.dev/lens',
              { url: pub, gl: 'us', hl: 'en' },
              { headers: { 'X-API-KEY': getSerperKey() }, timeout: 25000 }
            );
            break;
          } catch (err) {
            const status = err.response?.status;
            const data   = err.response?.data;
            if (status === 400) {
              if (data?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
              throw err;
            }
            if (status === 429 && attempt < 2) {
              await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
              continue;
            }
            throw err;
          }
        }

        if (!r) return null;

        const aliResults = (r.data.visual_matches || [])
          .filter(m => m.link && (m.link.includes('aliexpress.com') || m.link.includes('ali')))
          .slice(0, 5);
        if (!aliResults.length) return null;

        const aliUrls = await extractAliImageUrls(aliResults);
        if (!aliUrls.length || isAborted()) return null;

        return await findBestAliMatch(etsyImageUrl, aliUrls);
      } catch (e) {
        if (e.message === 'serper_no_credits') throw e;
        console.warn('[lensMatchWithClip]', e.message);
        return null;
      }
    }

    let found   = 0;
    let skipped = 0;
    const total = listings.length;

    for (let idx = 0; idx < listings.length; idx++) {
      if (isAborted()) {
        send({ step: 'stopped', message: '🛑 Recherche arrêtée.' });
        activeSearches.delete(sid);
        return res.end();
      }

      const listing   = listings[idx];
      const shopLabel = listing.shopName || `listing-${listing.listingId}`;
      send({ step: 'progress', current: idx + 1, total, shopName: shopLabel });

      try {
        // Essayer image principale, puis image2 si elle est différente
        const imagesToCheck = [listing.image, listing.image2]
          .filter((url, pos, arr) => url && arr.indexOf(url) === pos);

        let bestMatch = null;
        for (const imageUrl of imagesToCheck) {
          bestMatch = await lensMatchWithClip(imageUrl);
          if (bestMatch) break;
        }

        if (bestMatch) {
          found++;
          send({ step: 'result', listing: { ...listing, aliMatch: bestMatch } });
        } else {
          skipped++;
        }
      } catch (e) {
        if (e.message === 'serper_no_credits') {
          send({ step: 'error', message: '❌ Crédits Serper épuisés. Rechargez votre compte Serper.' });
          activeSearches.delete(sid);
          return res.end();
        }
        console.warn(`[search-dropship] Analyse échouée pour ${shopLabel}:`, e.message);
        skipped++;
      }
    }

    activeSearches.delete(sid);
    send({ step: 'done',     found, skipped, total });
    send({ step: 'complete', found, skipped, total });
    res.end();

  } catch (e) {
    console.error('[search-dropship] Erreur fatale:', e);
    send({ step: 'error', message: '❌ Erreur inattendue: ' + e.message });
    activeSearches.delete(sid);
    res.end();
  }
});

// ── Routes secondaires ────────────────────────────────────────────────────────

router.post('/shop-info', async (req, res) => {
  const { shopIdOrName } = req.body;
  if (!shopIdOrName) return res.status(400).json({ error: 'shopIdOrName required' });
  try { res.json(await getShopInfo(shopIdOrName)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/listing-detail', async (req, res) => {
  const { listingId } = req.body;
  if (!listingId) return res.status(400).json({ error: 'listingId required' });
  try { res.json(await getListingDetail(listingId)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scraper-health', async (req, res) => {
  const ok = await isScraperAvailable();
  res.json({ ok, message: ok ? 'Scraper Etsy ✅' : 'Scraper Etsy indisponible ❌' });
});

module.exports = router;
