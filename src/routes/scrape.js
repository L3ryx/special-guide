const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

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


// ══════════════════════════════════════════════════════════════════════════════
// ── ALIEXPRESS SCRAPING ──
// Stratégie en cascade :
//  1. Serper /images  → "aliexpress.com keyword" — retourne toujours des imageUrl
//  2. Scrape direct AliExpress via ScrapeAPI (si SCRAPEAPI_KEY dispo)
//  3. Scrape direct AliExpress sans clé (fallback léger)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Extrait les annonces AliExpress depuis la page HTML de résultats.
 * Utilisé comme fallback si Serper Images ne suffit pas.
 */
async function scrapeAliExpressDirect(keyword, maxListings, isAborted) {
  const listings = [];
  const seen = new Set();

  // Nombre de pages à scraper (60 annonces/page sur AliExpress)
  const pagesNeeded = Math.ceil(maxListings / 60);

  for (let page = 1; page <= pagesNeeded && listings.length < maxListings; page++) {
    if (isAborted()) break;

    const searchUrl = `https://www.aliexpress.com/wholesale?SearchText=${encodeURIComponent(keyword)}&page=${page}`;

    let html = null;

    // Essai 1 : ScrapeAPI si dispo
    if (process.env.SCRAPEAPI_KEY) {
      try {
        const r = await axios.get('https://api.scraperapi.com/', {
          params: { api_key: process.env.SCRAPEAPI_KEY, url: searchUrl, render: 'true' },
          timeout: 45000,
        });
        html = r.data;
        console.log(`[aliexpress] ScrapeAPI page ${page}: ${html?.length || 0} chars`);
      } catch(e) {
        console.warn(`[aliexpress] ScrapeAPI failed: ${e.message}`);
      }
    }

    // Essai 2 : requête directe avec headers navigateur
    if (!html) {
      try {
        const r = await axios.get(searchUrl, {
          timeout: 20000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
        html = r.data;
        console.log(`[aliexpress] Direct page ${page}: ${html?.length || 0} chars`);
      } catch(e) {
        console.warn(`[aliexpress] Direct request failed: ${e.message}`);
        break;
      }
    }

    if (!html) break;

    // Parser les URLs d'items et d'images depuis le HTML/JSON embarqué
    // AliExpress injecte les données dans window._dida_config_ ou __INITIAL_STATE__
    const itemMatches = [];

    // Regex pour extraire les product IDs et images depuis le JSON embarqué
    const jsonMatch = html.match(/"productId"\s*:\s*"?(\d+)"?[^}]*?"imageUrl"\s*:\s*"([^"]+)"/g)
      || html.match(/\/\/ae\d+\.alicdn\.com\/kf\/[^"'\s]+/g)
      || [];

    // Extraire paires (itemId, imageUrl) depuis le HTML
    const productPattern = /\/item\/(\d+)\.html/g;
    const imagePattern = /https?:\/\/ae\d+\.alicdn\.com\/kf\/[A-Za-z0-9_\-]+\.(jpg|png|webp)/g;

    const itemIds = [];
    let m;
    while ((m = productPattern.exec(html)) !== null) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        itemIds.push(m[1]);
      }
    }

    const imageUrls = [];
    while ((m = imagePattern.exec(html)) !== null) {
      imageUrls.push(m[0]);
    }

    // Associer chaque itemId à une imageUrl (dans l'ordre d'apparition)
    for (let i = 0; i < itemIds.length && listings.length < maxListings; i++) {
      const itemId = itemIds[i];
      const imageUrl = imageUrls[i] || null;
      if (!imageUrl) continue;
      listings.push({
        title: keyword,
        link: `https://www.aliexpress.com/item/${itemId}.html`,
        imageUrl,
      });
    }

    console.log(`[aliexpress] Scrape page ${page}: ${itemIds.length} items, ${listings.length} total`);
  }

  return listings;
}


/**
 * Récupère N annonces AliExpress avec image via Serper /images puis fallback scrape.
 */
async function fetchAliExpressListings(keyword, maxListings, isAborted = () => false) {
  const listings = [];
  const seen = new Set();

  // ── Méthode 1 : Serper /images — "aliexpress keyword" ──
  // C'est la méthode la plus fiable : Serper Images retourne toujours des imageUrl
  if (SERPER_KEYS.length) {
    try {
      console.log(`[aliexpress] Serper Images: "${keyword}" (max ${maxListings})`);

      // Serper Images retourne jusqu'à 100 résultats par requête
      const pagesNeeded = Math.ceil(maxListings / 100);

      for (let page = 1; page <= pagesNeeded && listings.length < maxListings; page++) {
        if (isAborted()) break;
        try {
          const r = await axios.post('https://google.serper.dev/images',
            {
              q: `aliexpress ${keyword}`,
              gl: 'us',
              hl: 'en',
              num: 100,
              page,
            },
            { headers: { 'X-API-KEY': getSerperKey() }, timeout: 20000 }
          );

          const images = r.data.images || [];
          console.log(`[aliexpress] Images page ${page}: ${images.length} résultats`);

          for (const item of images) {
            if (listings.length >= maxListings) break;
            const link = item.link || item.sourceUrl || '';
            // On garde uniquement les résultats pointant vers aliexpress.com
            if (!link.includes('aliexpress.com')) continue;
            const imageUrl = item.imageUrl || item.thumbnailUrl || null;
            if (!imageUrl) continue;
            const key = imageUrl;
            if (seen.has(key)) continue;
            seen.add(key);

            // Reconstruire un lien /item/ si possible depuis sourceUrl
            const itemMatch = link.match(/\/item\/(\d+)/);
            const cleanLink = itemMatch
              ? `https://www.aliexpress.com/item/${itemMatch[1]}.html`
              : link;

            listings.push({
              title:    item.title || keyword,
              link:     cleanLink,
              imageUrl,
            });
          }

          if (images.length < 10) break; // plus de pages
        } catch(e) {
          const status = e.response?.status;
          if (status === 401) throw new Error('serper_401');
          if (status === 400) {
            const detail = e.response?.data;
            if (detail?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
          }
          console.warn(`[aliexpress] Serper Images page ${page} failed: ${e.message}`);
          break;
        }
      }

      if (listings.length > 0) {
        console.log(`[aliexpress] ✅ ${listings.length} annonces via Serper Images`);
        return listings.slice(0, maxListings);
      }
    } catch(e) {
      if (e.message === 'serper_401' || e.message === 'serper_no_credits') throw e;
      console.warn('[aliexpress] Serper Images failed:', e.message);
    }
  }

  // ── Méthode 2 : Scrape direct AliExpress (ScrapeAPI ou direct) ──
  if (listings.length < maxListings) {
    console.log(`[aliexpress] Fallback scrape direct: "${keyword}"`);
    try {
      const scraped = await scrapeAliExpressDirect(keyword, maxListings - listings.length, isAborted);
      for (const item of scraped) {
        if (!seen.has(item.imageUrl)) {
          seen.add(item.imageUrl);
          listings.push(item);
        }
      }
    } catch(e) {
      console.warn('[aliexpress] Scrape direct failed:', e.message);
    }
  }

  console.log(`[aliexpress] Total final: ${listings.length} annonces`);
  return listings.slice(0, maxListings);
}


/**
 * Télécharge une image publique (AliExpress ou autre) et l'héberge sur litterbox
 * pour pouvoir la passer à Google Lens via Serper.
 */
async function uploadAliImageToHost(imageUrl) {
  if (!imageUrl) return null;

  // Télécharger l'image
  let buffer, mimeType;
  try {
    const res = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.aliexpress.com/',
      },
    });
    buffer   = Buffer.from(res.data);
    mimeType = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (buffer.length < 100) {
      console.warn('[uploadAliImage] Image trop petite:', buffer.length, 'bytes');
      return null;
    }
    console.log(`[uploadAliImage] ✅ Téléchargé — ${buffer.length} bytes`);
  } catch(e) {
    console.warn(`[uploadAliImage] ❌ Téléchargement échoué: ${e.message}`);
    return null;
  }

  // Héberger sur Litterbox
  const FormData = require('form-data');
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '1h');
    form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post(
      'https://litterbox.catbox.moe/resources/internals/api.php',
      form,
      { headers: form.getHeaders(), timeout: 20000, responseType: 'text' }
    );
    const url = (typeof res.data === 'string' ? res.data : '').trim();
    if (url.startsWith('https://')) {
      console.log(`[uploadAliImage] ✅ Litterbox → ${url}`);
      return url;
    }
    console.warn('[uploadAliImage] Litterbox réponse inattendue:', url);
  } catch(e) {
    console.warn('[uploadAliImage] ❌ Litterbox échoué:', e.message);
  }
  return null;
}


/**
 * Recherche Google Lens sur une image AliExpress → résultats Etsy.
 * Pipeline :
 *   1. Upload image AliExpress → URL publique
 *   2. Serper /lens → liste de résultats (visual_matches + organic)
 *   3. Filtrer les URLs etsy.com
 *   4. Pour chaque résultat Etsy :
 *      a. Si l'URL contient /shop/ShopName → shopName résolu immédiatement
 *      b. Sinon si /listing/{id} → API Etsy : listing_id → shop_id → /shops/{shop_id} → shop_name
 *   5. Si shopName trouvé → API Etsy getShopInfo → avatar + shopUrl officiel
 * Retourne : { etsyImage, etsyLink, listingId, shopName, shopUrl, shopAvatar }
 */
async function lensSearchEtsy(aliImageUrl, isAborted = () => false) {
  if (!aliImageUrl || isAborted()) return null;

  // ── 1. Upload image AliExpress ──
  const pubUrl = await uploadAliImageToHost(aliImageUrl);
  if (!pubUrl || isAborted()) return null;

  // ── 2. Google Lens via Serper ──
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await axios.post('https://google.serper.dev/lens',
        { url: pubUrl, gl: 'us', hl: 'en' },
        { headers: { 'X-API-KEY': getSerperKey() }, timeout: 25000 }
      );
      break;
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data;
      if (status === 400) {
        if (detail?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
        throw err;
      }
      if (status === 401) throw new Error('serper_401');
      if (status === 429 && attempt < 2) {
        await new Promise(res => setTimeout(res, 1500 * Math.pow(2, attempt)));
        continue;
      }
      if (status === 429) { console.warn('[lensSearchEtsy] Serper 429 définitif — skip'); return null; }
      throw err;
    }
  }
  if (isAborted()) return null;

  // ── 3. Filtrer résultats Etsy ──
  const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
  const etsyResults = all.filter(x => {
    const u = x.link || x.url || '';
    return u.includes('etsy.com');
  });

  if (!etsyResults.length) {
    console.log('[lensSearchEtsy] ❌ Aucun résultat Etsy dans Lens');
    return null;
  }

  // Log des résultats bruts pour debug
  console.log(`[lensSearchEtsy] ${etsyResults.length} résultats Etsy trouvés`);
  etsyResults.slice(0, 3).forEach((x, i) => {
    console.log(`  [${i}] ${(x.link || x.url || '').slice(0, 80)}`);
  });

  // ── 4. Résoudre shopName et listingId ──
  let shopName   = null;
  let shopUrl    = null;
  let shopAvatar = null;
  let etsyLink   = etsyResults[0].link || etsyResults[0].url || '';
  let etsyImage  = etsyResults[0].imageUrl || etsyResults[0].thumbnailUrl || null;
  let listingId  = null;

  // 4a. Chercher d'abord une URL /shop/ShopName directe dans tous les résultats
  for (const candidate of etsyResults) {
    const cLink = candidate.link || candidate.url || '';
    const shopMatch = cLink.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/);
    if (shopMatch && shopMatch[1] && shopMatch[1] !== 'ca' && shopMatch[1] !== 'uk') {
      shopName = shopMatch[1];
      shopUrl  = `https://www.etsy.com/shop/${shopName}`;
      // Garder l'image du meilleur résultat (le premier)
      console.log(`[lensSearchEtsy] shopName extrait depuis URL /shop/: ${shopName}`);
      break;
    }
  }

  // 4b. Extraire listing_id depuis tous les résultats (pour listingUrl)
  for (const candidate of etsyResults) {
    const cLink = candidate.link || candidate.url || '';
    const lm = cLink.match(/etsy\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/listing\/(\d+)/);
    if (lm) {
      listingId = lm[1];
      etsyLink  = cLink;
      if (candidate.imageUrl || candidate.thumbnailUrl) {
        etsyImage = candidate.imageUrl || candidate.thumbnailUrl;
      }
      break;
    }
  }

  // 4c. Si pas de shopName via URL → résoudre via API Etsy (listing_id → shop_id → shop_name)
  let _resolvedShopId = null;
  if (!shopName && listingId && !isAborted()) {
    try {
      const { getListingDetail } = require('../services/etsyApi');
      console.log(`[lensSearchEtsy] Résolution via API Etsy, listing_id: ${listingId}`);
      const detail = await getListingDetail(listingId);
      if (detail.shopName) {
        shopName       = detail.shopName;
        _resolvedShopId = detail.shopId || null;
        shopUrl        = `https://www.etsy.com/shop/${shopName}`;
        console.log(`[lensSearchEtsy] ✅ shopName via API Etsy: ${shopName}`);
      } else {
        console.warn(`[lensSearchEtsy] API Etsy: listing ${listingId} → shop_id ${detail.shopId} → shopName null`);
      }
    } catch(e) {
      console.warn('[lensSearchEtsy] API Etsy listing→shop échouée:', e.message);
    }
  }

  // 4d. Dernier recours : scraping léger de la page Etsy listing
  if (!shopName && listingId && !isAborted()) {
    try {
      console.log(`[lensSearchEtsy] Fallback scraping HTML pour listing ${listingId}`);
      const pageRes = await axios.get(`https://www.etsy.com/listing/${listingId}`, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        maxRedirects: 3,
      });
      const html = pageRes.data || '';
      // Chercher "shopName" dans le JSON de la page (window.__INITIAL_STATE__ ou data-buy-box)
      const jsMatch    = html.match(/"shop_name"\s*:\s*"([^"]+)"/);
      const canonMatch = html.match(/etsy\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/shop\/([A-Za-z0-9_-]+)/);
      const found = (jsMatch && jsMatch[1]) || (canonMatch && canonMatch[1]) || null;
      if (found && found.length > 2 && !['etsy', 'ca', 'uk', 'fr', 'de'].includes(found)) {
        shopName = found;
        shopUrl  = `https://www.etsy.com/shop/${shopName}`;
        console.log(`[lensSearchEtsy] ✅ shopName via scraping HTML: ${shopName}`);
      }
    } catch(e) {
      console.warn('[lensSearchEtsy] Scraping HTML échoué:', e.message);
    }
  }

  // ── 5. Récupérer avatar + infos boutique via API Etsy ──
  if (shopName && !isAborted()) {
    try {
      const { getShopInfo } = require('../services/etsyApi');
      const info = await getShopInfo(_resolvedShopId || shopName);
      shopAvatar = info.shopAvatar || null;
      shopUrl    = info.shopUrl || shopUrl;
      console.log(`[lensSearchEtsy] ✅ Avatar récupéré pour ${shopName}: ${shopAvatar ? 'oui' : 'non'}`);
    } catch(e) {
      console.warn(`[lensSearchEtsy] getShopInfo(${shopName}) échoué:`, e.message);
    }
  }

  const listingUrl = listingId ? `https://www.etsy.com/listing/${listingId}` : etsyLink;

  console.log(`[lensSearchEtsy] Résultat final → shopName: ${shopName || 'INCONNU'} | listingId: ${listingId || 'null'} | avatar: ${shopAvatar ? 'oui' : 'non'}`);

  // Si on n'a pas de shopName du tout → pas de match utilisable
  if (!shopName) {
    console.log('[lensSearchEtsy] ❌ shopName non résolu — résultat ignoré');
    return null;
  }

  return {
    etsyImage,
    etsyLink: listingUrl,
    listingId,
    shopName,
    shopUrl,
    shopAvatar,
  };
}


/**
 * Pipeline SAM + DINOv2 : compare image AliExpress avec image Etsy.
 * Retourne { similarity, is_dropship, threshold } ou null si pipeline indisponible.
 */
// Circuit-breaker : désactivé après 2 timeouts consécutifs
let _visualPipelineDisabled = false;
let _visualTimeoutCount = 0;

async function runVisualPipeline(aliImageUrl, etsyImageUrl) {
  if (!process.env.VISUAL_API_URL || _visualPipelineDisabled) return null;
  try {
    console.log('[visualPipeline] SAM + DINOv2 (fond blanc)...');

    const samRes = await axios.post(
      `${process.env.VISUAL_API_URL}/segment`,
      { images: [aliImageUrl, etsyImageUrl] },
      { timeout: 10000 }
    );
    const masks = samRes.data?.masks || [];

    const extractRes = await axios.post(
      `${process.env.VISUAL_API_URL}/extract`,
      { images: [aliImageUrl, etsyImageUrl], masks, background: 'white' },
      { timeout: 30000 }
    );
    const croppedImages = extractRes.data?.croppedImages || [];

    const dinoRes = await axios.post(
      `${process.env.VISUAL_API_URL}/features`,
      { images: croppedImages },
      { timeout: 30000 }
    );
    const features = dinoRes.data?.features || [];

    const patchRes = await axios.post(
      `${process.env.VISUAL_API_URL}/filter-patches`,
      { features, masks },
      { timeout: 30000 }
    );
    const filteredPatches = patchRes.data?.filteredPatches || [];

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
      console.log(`[visualPipeline] ✅ Score: ${sim} | is_dropship: ${scoreRes.data?.is_dropship}`);
      return scoreRes.data;
    }
    return null;
  } catch (e) {
    if (e.code === 'ECONNABORTED' || e.message.includes('timeout')) {
      _visualTimeoutCount++;
      if (_visualTimeoutCount >= 2) {
        _visualPipelineDisabled = true;
        console.warn('[visualPipeline] ⚠️ 2 timeouts consécutifs — pipeline désactivé pour cette session');
      } else {
        console.warn('[visualPipeline] ⚠️ Timeout', _visualTimeoutCount, '/ 2');
      }
    } else {
      console.warn('[visualPipeline] ⚠️ Erreur (non bloquant):', e.message);
    }
    return null;
  }
}


// ── SEARCH DROPSHIP (nouveau pipeline inversé) ──
router.post('/search-dropship', async (req, res) => {
  const { keyword, sessionId, pages } = req.body;
  // `pages` = nombre d'annonces AliExpress (1–200)
  const maxListings = Math.min(Math.max(parseInt(pages) || 5, 1), 200);
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

  // Reset circuit-breaker pour chaque nouvelle recherche
  _visualPipelineDisabled = false;
  _visualTimeoutCount = 0;

  try {

    // ── STEP 1 : Récupérer les boutiques déjà analysées ──
    let usedShops = [];
    try {
      const AutoSearchState = require('../models/autoSearchModel');
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

    // ── STEP 2 : Scraping AliExpress ──
    send({ step: 'scraping', message: `🔍 Recherche AliExpress pour "${keyword}"...` });

    let aliListings = [];
    try {
      aliListings = await fetchAliExpressListings(keyword, maxListings, isAborted);
    } catch(e) {
      if (e.message === 'serper_401')        { send({ step: 'error', message: '❌ Serper key invalid' }); return res.end(); }
      if (e.message === 'serper_no_credits') { send({ step: 'error', message: '❌ Crédits Serper épuisés — recharge sur serper.dev' }); return res.end(); }
      send({ step: 'error', message: '❌ AliExpress scraping failed: ' + e.message });
      return res.end();
    }

    if (isAborted()) { send({ step: 'stopped', message: '🛑 Search stopped by user.' }); activeSearches.delete(sid); return res.end(); }

    // Filtrer ceux sans image
    aliListings = aliListings.filter(l => l.imageUrl);
    console.log('[search-dropship] Annonces AliExpress avec image:', aliListings.length);

    if (!aliListings.length) {
      send({ step: 'error', message: '❌ Aucune annonce AliExpress trouvée avec image pour ce mot-clé' });
      return res.end();
    }

    send({ step: 'analyzing', message: `✅ ${aliListings.length} annonces AliExpress. Recherche Etsy via Google Lens...` });

    // ── STEP 3 + 4 + 5 : Pour chaque annonce AliExpress ──
    const dropshippers = [];
    const seenShops = new Set(usedShops);
    let analyzed = 0;
    const queue = [...aliListings];

    async function worker() {
      while (queue.length > 0) {
        if (isAborted()) break;
        const listing = queue.shift();
        if (!listing) continue;
        analyzed++;
        const shopStart = Date.now();
        send({
          step: 'analyzing',
          total: aliListings.length,
          done: analyzed,
          message: `🔎 ${analyzed}/${aliListings.length} — ${dropshippers.length} dropshippers`
        });

        try {
          // STEP 3 : Google Lens sur l'image AliExpress → premier résultat Etsy
          const etsyResult = await lensSearchEtsy(listing.imageUrl, isAborted);

          const shopElapsedMs = Date.now() - shopStart;
          send({ step: 'shop_done', done: analyzed, total: aliListings.length, elapsedMs: shopElapsedMs });

          if (isAborted()) break;

          if (!etsyResult) {
            console.log(`[worker] ❌ Pas de résultat Etsy pour: ${listing.link.slice(0, 60)}`);
            continue;
          }

          // Skip boutique déjà vue
          if (etsyResult.shopName && seenShops.has(etsyResult.shopName)) {
            console.log(`[worker] ⏭ Boutique déjà vue: ${etsyResult.shopName}`);
            continue;
          }

          // STEP 4 : DINOv2 — comparer image AliExpress vs image Etsy
          let isDropship = false;
          let visualSimilarity = null;

          if (etsyResult.etsyImage) {
            const pipelineResult = await runVisualPipeline(listing.imageUrl, etsyResult.etsyImage);

            if (!pipelineResult) {
              // Pas de pipeline dispo → Lens seul suffit comme signal de match
              isDropship = true;
              console.log(`[worker] ✅ Match Lens (sans DINOv2) — ${etsyResult.shopName}`);
            } else {
              isDropship = !!pipelineResult.is_dropship;
              visualSimilarity = pipelineResult.similarity ?? null;
              console.log(`[worker] DINOv2 sim: ${visualSimilarity} | is_dropship: ${isDropship} — ${etsyResult.shopName}`);
            }
          } else {
            // Pas d'image Etsy récupérée → on considère Lens seul
            isDropship = true;
          }

          if (isDropship) {
            const shopName  = etsyResult.shopName;
            const shopUrl   = etsyResult.shopUrl || (shopName ? `https://www.etsy.com/shop/${shopName}` : '#');
            const listingUrl = etsyResult.etsyLink || (etsyResult.listingId ? `https://www.etsy.com/listing/${etsyResult.listingId}` : shopUrl);
            if (shopName) seenShops.add(shopName);

            const shopData = {
              shopName,
              shopUrl,
              shopAvatar:       etsyResult.shopAvatar || null,
              shopImage:        etsyResult.etsyImage  || null,
              listingUrl,
              listingId:        etsyResult.listingId  || null,
              aliUrl:           listing.link || null,
              aliImage:         listing.imageUrl || null,
              visualSimilarity: visualSimilarity ?? null,
            };
            dropshippers.push(shopData);

            const simLabel = visualSimilarity !== null
              ? ` | Similarité DINOv2 : ${(visualSimilarity * 100).toFixed(1)}%`
              : '';
            send({
              step:    'match',
              message: `✅ ${shopName} (${dropshippers.length} dropshippers) | Lens Etsy match${simLabel}`,
              shop:    shopData,
            });
          }

        } catch (e) {
          if (e.message === 'serper_401')        { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
          if (e.message === 'serper_no_credits') { send({ step: 'error', message: '❌ Crédits Serper épuisés — recharge sur serper.dev' }); return; }
          console.warn('[worker] erreur non bloquante:', e.message);
        }
      }
    }

    // 3 workers max (limite Serper)
    await Promise.all(Array.from({ length: 3 }, worker));
    activeSearches.delete(sid);

    if (isAborted()) {
      send({ step: 'stopped', message: '🛑 Search stopped by user.' });
    } else {
      send({ step: 'complete', dropshippers, total: aliListings.length });
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
    SERPER_API_KEY:   !!process.env.SERPER_API_KEY,
    SERPER_API_KEY_2: !!process.env.SERPER_API_KEY_2,
  };
  res.json({ status: Object.values(keys).some(Boolean) ? 'ready' : 'missing_keys', keys });
});

module.exports = router;
