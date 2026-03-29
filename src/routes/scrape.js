const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { searchListings, getShopListings, getShopInfo, getListingDetail, handleEtsyError } = require('../services/etsyApi');
// ScraperAPI conservé UNIQUEMENT pour AliExpress
const { scraperApiFetch } = require('../services/scrapingFetch');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}

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
 * - Max 8 pages (800 listings)
 * - Ignore les boutiques déjà analysées (usedShops)
 * Retourne un tableau de { link, image, shopName, shopUrl }.
 */
async function fetchListingsForDropship(keyword, onBatch, usedShops = []) {
  const MAX_PAGES = 8;
  const perPage   = 100;
  const shopsSeen = new Set(usedShops);
  const listings  = [];
  let   offset    = 0;
  let   page      = 0;

  // Cache shopId → shopName pour éviter des appels répétés
  const shopNameCache = new Map();

  while (page < MAX_PAGES) {
    let results;
    try {
      results = await searchListings(keyword, perPage, offset);
    } catch (e) {
      handleEtsyError(e);
    }

    if (!results || results.length === 0) break;

    let added = 0;
    for (const l of results) {
      // Résoudre shopName si c'est un ID numérique
      const shopNameIsId = !l.shopName || /^\d+$/.test(String(l.shopName));
      if (shopNameIsId && l.shopId) {
        const cached = shopNameCache.get(String(l.shopId));
        if (cached) {
          l.shopName = cached.shopName;
          l.shopUrl  = cached.shopUrl;
        } else {
          try {
            const info = await getShopInfo(l.shopId);
            l.shopName = info.shopName;
            l.shopUrl  = info.shopUrl;
            shopNameCache.set(String(l.shopId), { shopName: info.shopName, shopUrl: info.shopUrl });
          } catch (e) {
            console.warn('[fetchListings] getShopInfo failed for shopId', l.shopId, ':', e.message);
          }
        }
      }

      // Récupérer l'image via le listing detail si manquante
      if (!l.image && l.listingId) {
        try {
          const detail = await getListingDetail(l.listingId);
          if (detail.images?.[0]) l.image = detail.images[0];
          if (!l.shopName && detail.shopName) {
            l.shopName = detail.shopName;
            l.shopUrl  = `https://www.etsy.com/shop/${detail.shopName}`;
          }
        } catch (e) {
          console.warn('[fetchListings] getListingDetail failed for', l.listingId, ':', e.message);
        }
      }

      if (!l.image || !l.shopName || /^\d+$/.test(String(l.shopName))) continue;
      if (shopsSeen.has(l.shopName)) continue;
      shopsSeen.add(l.shopName);
      listings.push(l);
      added++;
    }

    page++;
    if (onBatch) onBatch(page, listings.length);
    console.log(`fetchListingsForDropship page ${page}/${MAX_PAGES}: ${added} new shops, total ${listings.length}`);

    if (results.length < perPage) break; // dernière page
    offset += perPage;
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('fetchListingsForDropship done:', listings.length, 'unique new shops');
  return listings;
}


// ── SEARCH DROPSHIP ──
router.post('/search-dropship', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  if (!process.env.ETSY_CLIENT_ID)   return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  if (!process.env.IMGBB_API_KEY)  return res.status(500).json({ error: 'IMGBB_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

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

    // ── STEP 2 : Récupérer les listings via l'API Etsy (8 pages max) ──
    send({ step: 'scraping', message: '🔍 Searching Etsy API for "' + keyword + '"...' });

    let listings = [];
    try {
      listings = await fetchListingsForDropship(
        keyword,
        (page, count) => send({ step: 'scraping', message: '📄 Page ' + page + '/8 — ' + count + ' new shops...' }),
        usedShops
      );
    } catch(e) {
      send({ step: 'error', message: '❌ Etsy API failed: ' + e.message }); return res.end();
    }

    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings with shopName:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ No shops found in Etsy results' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' unique shops. Analyzing...' });

    // ── STEP 2 : Récupérer les images des boutiques + Google Lens ──
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const r = await uploadToImgBB(url);
      imgbbCache.set(url, r);
      return r;
    }

    /**
     * Récupère l'avatar et 2 images de listing d'une boutique via l'API Etsy.
     * shopIdOrName peut être un shop_name (string) ou un shop_id numérique (string de chiffres).
     */
    async function scrapeShopImages(shopIdOrName) {
      try {
        // Infos boutique (avatar + resolution du vrai shop_name si on n'a que l'ID)
        let shopAvatar = null;
        let resolvedName = shopIdOrName;
        try {
          const info = await getShopInfo(shopIdOrName);
          shopAvatar   = info.shopAvatar || null;
          resolvedName = info.shopName   || shopIdOrName;
        } catch (e) {
          console.warn('[avatar] getShopInfo failed for', shopIdOrName, ':', e.message);
        }

        // Listings de la boutique — getShopListings retourne les listing_id
        const shopListings = await getShopListings(resolvedName, 5);

        // getShopListings peut ne pas retourner les images — on les recupere via getListingDetail
        const images = [];
        for (const l of shopListings.slice(0, 3)) {
          if (l.image) {
            images.push({ image: l.image, link: l.link });
          } else if (l.listingId) {
            try {
              const detail = await getListingDetail(l.listingId);
              if (detail.images?.[0]) images.push({ image: detail.images[0], link: l.link });
            } catch {}
          }
          if (images.length >= 2) break;
        }

        return { images, shopAvatar, resolvedName };
      } catch (e) {
        console.warn('[scrapeShopImages] failed for', shopIdOrName, ':', e.message);
        return { images: [], shopAvatar: null, resolvedName: shopIdOrName };
      }
    }

    async function lensMatch(imageUrl) {
      try {
        const pub = await uploadCached(imageUrl);
        if (!pub) return null;
        const r = await axios.post('https://google.serper.dev/lens',
          { url: pub, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );
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
        const listing = queue.shift();
        if (!listing) continue;
        analyzed++;
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: '🔎 ' + analyzed + '/' + listings.length + ' — ' + dropshippers.length + ' dropshippers' });
        try {
          const { images: shopImages, shopAvatar, resolvedName } = await scrapeShopImages(listing.shopName);
          if (shopImages.length < 2) continue;
          const [m1, m2] = await Promise.all([lensMatch(shopImages[0].image), lensMatch(shopImages[1].image)]);
          if (m1 && m2) {
            dropshippers.push({
              shopName:   resolvedName,
              shopUrl:    'https://www.etsy.com/shop/' + resolvedName,
              shopAvatar: shopAvatar || null,
              shopImage:  shopImages[0].image,
              listingUrl: shopImages[0].link || listing.link,
            });
            send({ step: 'match', message: '✅ ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers)', shop: dropshippers[dropshippers.length - 1] });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
        }
      }
    }

    await Promise.all([worker(), worker(), worker(), worker()]);
    send({ step: 'complete', dropshippers, total: listings.length });
    res.end();

  } catch (err) {
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



