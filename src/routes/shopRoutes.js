const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const { uploadToImgBB } = require('../services/imgbbUploader');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl } = req.body;
  if (!shopUrl) return res.status(400).json({ error: 'shopUrl requis' });
  if (shopUrl.includes('/listing/')) {
    const m = shopUrl.match(/etsy\.com\/shop\/([^/?#]+)/);
    shopUrl = m
      ? `https://www.etsy.com/shop/${m[1]}`
      : shopName
        ? `https://www.etsy.com/shop/${shopName}`
        : shopUrl.split('/listing/')[0].replace(/\/$/, '');
  } else {
    shopUrl = shopUrl.replace(/\/$/, '');
  }
  if (!shopName || shopName === 'Shop' || shopName === 'Boutique') {
    const m = shopUrl.match(/\/shop\/([^/?#]+)/);
    shopName = m ? m[1] : shopUrl.split('/').filter(Boolean).pop() || 'Shop';
  }
  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, shopUrl },
      { $set: { shopName, shopAvatar: shopAvatar || null, productImage: productImage || null, productUrl: productUrl || null, savedAt: new Date() }, $setOnInsert: { userId: req.user.id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, shop });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LIST SHOPS ──
router.get('/', requireAuth, async (req, res) => {
  try {
    const shops = await SavedShop.find({ userId: req.user.id }).sort({ savedAt: -1 });
    res.json(shops);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE SHOP ──
router.delete('/:id', requireAuth, async (req, res) => {
  await SavedShop.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

// ── FIND ──
router.post('/:id/find', requireAuth, async (req, res) => {
  const shop = await SavedShop.findOne({ _id: req.params.id, userId: req.user.id });
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');

  // API key check
  if (!process.env.SERPER_API_KEY) {
    send({ step: 'error', message: '❌ SERPER_API_KEY missing in Render environment' });
    return res.end();
  }

  try {
    send({ step: 'scraping', message: '🔍 Fetching listings...' });
    const listings = await scrapeShopListings(shop.shopUrl);
    if (!listings.length) {
      send({ step: 'error', message: 'No listings found for this shop' });
      return res.end();
    }
    send({ step: 'scraping', message: `✅ ${listings.length} listings found` });

    const results = [];
    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      if (!listing.image) continue;
      send({ step: 'searching', index: i, total: listings.length, message: `🔎 ${i+1}/${listings.length} — ${listing.title?.slice(0,40) || ''}` });
      try {
        // Upload sur ImgBB pour URL publique (Serper a besoin d'une URL accessible)
        const publicUrl = await uploadToImgBB(listing.image);
        if (!publicUrl || !publicUrl.startsWith('http')) {
          console.warn(`Listing ${i}: ImgBB upload failed, skipping`);
          continue;
        }

        // Appel Serper Lens
        let lensRes;
        try {
          lensRes = await axios.post('https://google.serper.dev/lens',
            { url: publicUrl, gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
          );
        } catch (serperErr) {
          const status = serperErr.response?.status;
          if (status === 401) {
            send({ step: 'error', message: '❌ Serper API key invalid (401) — check SERPER_API_KEY in Render' });
            return res.end();
          }
          console.warn(`Listing ${i} Serper error ${status}:`, serperErr.message);
          continue; // skip ce listing, continue les autres
        }

        const all = [...(lensRes.data.visual_matches || []), ...(lensRes.data.organic || [])];
        const aliMatch = all.find(m => (m.link || m.url || '').includes('aliexpress.com/item/'));
        if (!aliMatch) continue;

        const aliUrl = cleanAliUrl(aliMatch.link || aliMatch.url);
        if (!aliUrl) continue;

        const aliImgUrl = aliMatch.imageUrl || aliMatch.thumbnailUrl || null;
        let similarity = 75;
        if (aliImgUrl) {
          try { similarity = await compareWithClaude(listing.image, aliImgUrl); }
          catch (e) { console.warn('Claude Vision unavailable:', e.message); }
        }

        results.push({
          etsyTitle: listing.title,
          etsyUrl:   listing.url,
          etsyImage: listing.image,
          etsyPrice: listing.price,
          aliUrl,
          aliImage:  aliImgUrl,
          similarity,
        });
        send({ step: 'match', result: results[results.length - 1], total: results.length });
      } catch (e) {
        console.warn(`Listing ${i} error:`, e.message);
        // Don't abort — continue other listings
      }
    }

    shop.lastFind = { runAt: new Date(), results };
    await shop.save();
    send({ step: 'complete', results, shopId: shop._id });
    res.end();
  } catch (err) {
    const msg = err.response
      ? `Erreur API ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    send({ step: 'error', message: msg });
    res.end();
  }
});

function cleanAliUrl(raw) {
  if (!raw) return null;
  const m = raw.match(/\/item\/(\d{10,})/);
  return m ? `https://www.aliexpress.com/item/${m[1]}.html` : null;
}

// ════════════════════════════════════════════════════════════════════════
// HELPER : Scraping avec fallback ZenRows si ScrapingBee échoue
// ScrapingBee est essayé en premier. En cas d'erreur (401, 500, timeout),
// ZenRows prend le relais automatiquement.
// ════════════════════════════════════════════════════════════════════════
async function scrapingbeeFetch(targetUrl, sbParams = {}) {
  // ScrapingBee désactivé — ZenRows puis ScraperAPI directement

  // ── Fallback 1 : ZenRows (JS+premium) ──
  const zrKey = process.env.ZENROWS_API_KEY;
  if (zrKey) {
    try {
      console.log('ZenRows fetch (JS+premium):', targetUrl);
      const r = await axios.get('https://api.zenrows.com/v1/', {
        params: { apikey: zrKey, url: targetUrl, js_render: 'true', premium_proxy: 'true' },
        timeout: 90000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) {
        console.log('ZenRows OK —', html.length, 'chars');
        return html;
      }
    } catch (e) {
      console.warn('ZenRows failed (' + e.response?.status + '):', e.message.slice(0, 80));
    }
  }

  // ── Fallback 2 : ScraperAPI ──
  const saKey = process.env.SCRAPEAPI_KEY;
  if (saKey) {
    try {
      console.log('ScraperAPI fetch:', targetUrl);
      const r = await axios.get('http://api.scraperapi.com', {
        params: { api_key: saKey, url: targetUrl, render: 'true', country_code: 'us' },
        timeout: 90000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) {
        console.log('ScraperAPI OK —', html.length, 'chars');
        return html;
      }
    } catch (e) {
      console.warn('ScraperAPI failed (' + e.response?.status + '):', e.message.slice(0, 80));
    }
  }

  throw new Error('All scrapers failed — check ZENROWS_API_KEY, SCRAPEAPI_KEY');
}

async function scrapeShopListings(shopUrl) {
  const html = await scrapingbeeFetch(shopUrl, { premium_proxy: 'true', wait: '2000' });
  const listings = [];
  const seen = new Set();

  // Stratégie 1 : JSON embarqué (ScrapingBee/ZenRows avec JS)
  const listingPattern = /"listing_id"\s*:\s*(\d+)[^}]*?"title"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = listingPattern.exec(html)) !== null && listings.length < 30) {
    const id = m[1], title = m[2];
    const url = 'https://www.etsy.com/listing/' + id + '/' + title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!seen.has(id)) { seen.add(id); listings.push({ id, title, url, image: null, price: null }); }
  }

  // Stratégie 2 : JSON-LD (présent dans HTML statique ScraperAPI)
  if (listings.length < 3) {
    for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(raw);
        const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
        for (const item of items) {
          const url = item.url || item['@id'];
          if (!url || !url.includes('/listing/')) continue;
          const cleanUrl = url.split('?')[0];
          if (seen.has(cleanUrl)) continue;
          seen.add(cleanUrl);
          listings.push({ title: item.name || cleanUrl.split('/').pop().replace(/-/g, ' '), url: cleanUrl, image: null, price: null });
          if (listings.length >= 30) break;
        }
      } catch {}
      if (listings.length >= 5) break;
    }
  }

  // Stratégie 3 : liens href vers listings (fallback HTML pur)
  if (listings.length < 3) {
    for (const hm of html.matchAll(/href="(https?:\/\/www\.etsy\.com(?:\/[a-z]{2})?\/listing\/(\d+)\/([^"?#]+))"/g)) {
      const url = hm[1].replace(/\/[a-z]{2}(\/listing\/)/, '$1').split('?')[0];
      const id  = hm[2];
      if (seen.has(id) || listings.length >= 30) continue;
      seen.add(id);
      listings.push({ title: hm[3].replace(/-/g, ' '), url, image: null, price: null });
    }
  }

  // Ajouter les images etsystatic aux listings dans l'ordre
  const imgMatches = [...html.matchAll(/https:\/\/i\.etsystatic\.com\/[^\s"']+(?:il|il_fullxfull)[^"'\s]*/g)];
  imgMatches.forEach((im, idx) => { if (listings[idx]) listings[idx].image = im[0]; });

  // Debug : voir ce que contient le HTML
  const hasListing  = (html.match(/\/listing\//g) || []).length;
  const hasJsonLd   = (html.match(/ld\+json/g) || []).length;
  const hasAlt      = (html.match(/listing\/\d+/g) || []).length;
  const hasFrListing= (html.match(/\/fr\/listing\//g) || []).length;
  const hasEtsystatic=(html.match(/etsystatic\.com/g) || []).length;
  console.log('scrapeShopListings debug — /listing/:', hasListing, '| /fr/listing/:', hasFrListing, '| ld+json:', hasJsonLd, '| listing/N:', hasAlt, '| etsystatic:', hasEtsystatic);
  // Extrait du HTML pour voir la structure
  const sampleIdx = html.indexOf('listing');
  if (sampleIdx > 0) console.log('HTML sample around listing:', html.slice(Math.max(0,sampleIdx-30), sampleIdx+80));
  console.log('scrapeShopListings:', listings.length, 'listings, titles:', listings.slice(0,5).map(l=>l.title));
  return listings.filter(l => l.url);
}

// Appel Gemini avec retry exponentiel pour absorber les 429
async function callGeminiWithRetry(payload, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      return res;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        // Backoff exponentiel : 5s, 10s, 20s, 40s
        const wait = 5000 * Math.pow(2, attempt);
        console.warn(`Gemini 429 — attente ${wait / 1000}s avant retry ${attempt + 1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err; // Autre erreur -> propager
    }
  }
  throw new Error('Gemini 429 — max retries atteint');
}

async function compareWithClaude(etsyImgUrl, aliImgUrl) {
  const [etsyBuf, aliBuf] = await Promise.all([
    axios.get(etsyImgUrl, { responseType: 'arraybuffer', timeout: 15000 }),
    axios.get(aliImgUrl,  { responseType: 'arraybuffer', timeout: 15000 }),
  ]);
  const etsyB64  = Buffer.from(etsyBuf.data).toString('base64');
  const aliB64   = Buffer.from(aliBuf.data).toString('base64');
  const etsyMime = etsyBuf.headers['content-type'] || 'image/jpeg';
  const aliMime  = aliBuf.headers['content-type']  || 'image/jpeg';

  const geminiVisionRes = await callGeminiWithRetry({
    contents: [{
      parts: [
        { inline_data: { mime_type: etsyMime, data: etsyB64 } },
        { inline_data: { mime_type: aliMime,  data: aliB64  } },
        { text: 'Are these two product images showing the same or very similar product? Reply with ONLY a number from 0 to 100 representing similarity percentage.' }
      ]
    }]
  });

  const txt = geminiVisionRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '75';
  return Math.min(100, Math.max(0, parseInt(txt) || 75));
}

module.exports = router;

// ── COMPETITION ──
router.post('/:id/competition', requireAuth, async (req, res) => {
  const shop = await SavedShop.findOne({ _id: req.params.id, userId: req.user.id });
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');

  try {
    const apiKey = null; // ScrapingBee désactivé
    if (!process.env.GEMINI_API_KEY) { send({ step: 'error', message: '❌ GEMINI_API_KEY missing' }); return res.end(); }
    if (!process.env.SERPER_API_KEY) { send({ step: 'error', message: '❌ SERPER_API_KEY missing' }); return res.end(); }
    if (!process.env.IMGBB_API_KEY)  { send({ step: 'error', message: '❌ IMGBB_API_KEY missing' });  return res.end(); }

    // ── STEP 1 : Récupérer les titres des 5 premières annonces → keyword via Gemini ──
    send({ step: 'status', message: '🏪 Fetching shop listings...' });
    const shopBase = shop.shopUrl.replace(/\/?$/, '');

    // Scraper les listings de la boutique pour récupérer les 5 premiers titres
    let shopTitles = [];
    try {
      const shopListings = await scrapeShopListings(shopBase);
      shopTitles = shopListings
        .slice(0, 5)
        .map(l => l.title)
        .filter(t => t && t.length > 3);
      console.log('Shop titles found:', shopTitles);
    } catch (e) {
      console.warn('scrapeShopListings failed:', e.message);
    }

    // Si on n'a pas pu récupérer les titres, essayer ScraperAPI en fallback
    if (shopTitles.length === 0 && process.env.SCRAPEAPI_KEY) {
      try {
        send({ step: 'status', message: '🏪 Trying ScraperAPI fallback...' });
        console.log('ScraperAPI shop fetch:', shopBase);
        const scraperUrl = 'http://api.scraperapi.com?api_key=' + process.env.SCRAPEAPI_KEY + '&url=' + encodeURIComponent(shopBase) + '&render=false&country_code=us';
        const r = await axios.get(scraperUrl, { timeout: 60000 });
        const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        if (html.length > 500) {
          // Extraire les titres depuis le HTML ScraperAPI
          const titleMatches = [...html.matchAll(/"title"\s*:\s*"([^"]{5,150})"/g)];
          shopTitles = titleMatches
            .map(m => m[1].replace(/\\u[0-9a-f]{4}/gi, '').trim())
            .filter(t => t.length > 5)
            .slice(0, 5);
          console.log('ScraperAPI titles:', shopTitles);
        }
      } catch (e) {
        console.warn('ScraperAPI fallback failed:', e.message);
      }
    }

    if (shopTitles.length === 0) {
      send({ step: 'error', message: '❌ Could not fetch any listing titles from this shop. Please try again.' });
      return res.end();
    }

    send({ step: 'status', message: '📝 ' + shopTitles.length + ' listing titles found. Analyzing with AI...' });
    console.log('Titles sent to Gemini:', shopTitles);

    // ── STEP 2 : Gemini → keyword à partir des titres ──
    let keyword = '';
    try {
      const titlesText = shopTitles.map((t, i) => (i + 1) + '. ' + t).join('\n');
      const aiRes = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + process.env.GEMINI_API_KEY,
        {
          contents: [{
            parts: [{
              text: 'Here are the first 5 product listing titles from an Etsy shop:\n\n' + titlesText + '\n\nWhat is the main type of product sold by this shop? Respond with ONLY a single short English keyword (1-3 words max) that best defines the niche. No explanation, no punctuation, just the keyword.'
            }]
          }]
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
      );
      keyword = (aiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      send({ step: 'error', message: '❌ Gemini failed (' + (e.response?.status || '') + '): ' + detail });
      return res.end();
    }

    if (!keyword) { send({ step: 'error', message: '❌ AI could not determine a keyword' }); return res.end(); }
    send({ step: 'keyword', message: '🔑 Keyword: "' + keyword + '"', keyword });

    // ── STEP 3 : Scrape Etsy listings (1 per unique shop) ──
    send({ step: 'status', message: '🔍 Scraping Etsy listings for "' + keyword + '"...' });

    const listings = await scrapeEtsyListingsForCompetition(apiKey, keyword, (page, count) => {
      send({ step: 'scraping', message: '📄 Page ' + page + ' — ' + count + '/400 listings collected...' });
    });

    // totalShops = boutiques uniques (chaque boutique peut avoir jusqu'à 3 images)
    const totalShops = new Set(listings.map(l => l.shopName || l.link)).size;
    if (totalShops === 0) {
      send({ step: 'error', message: '❌ No listings found on Etsy for this keyword' });
      return res.end();
    }
    send({ step: 'status', message: '✅ ' + totalShops + ' unique shops found. Starting reverse image search...' });

    // ── STEP 4 : Recherche image Google Lens + comparaison Gemini ──
    const { uploadToImgBB } = require('../services/imgbbUploader');
    let dropshippers = 0;
    let analyzed = 0;
    const dropshipperShops = [];
    const SIMILARITY_THRESHOLD = 0.55;

    // Cache ImgBB — évite de re-uploader la même image
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const result = await uploadToImgBB(url);
      imgbbCache.set(url, result);
      return result;
    }

    // Set des boutiques déjà analysées — on saute si déjà vue
    const shopsAnalyzed = new Set();

    // Map boutique → nombre d'images testées (pour les boutiques multi-images)
    const shopImageCount  = new Map(); // shopName → nb images tentées
    const shopMatched     = new Set(); // boutiques déjà comptées comme dropshipper

    async function analyzeOne(listing) {
      try {
        const shopKey = listing.shopName || listing.link;

        // ── Sauter si boutique déjà comptée comme dropshipper ────────
        if (shopKey && shopMatched.has(shopKey)) {
          console.log('Skip (already matched):', shopKey);
          return;
        }

        // ── Sauter si c'est une image extra et la boutique est déjà dans shopsAnalyzed ──
        // shopsAnalyzed = boutiques dont toutes les images ont été testées sans match
        if (shopKey && shopsAnalyzed.has(shopKey)) {
          console.log('Skip (all images tested, no match):', shopKey);
          return;
        }

        // Incrémenter le compteur d'images pour cette boutique
        const imgCount = (shopImageCount.get(shopKey) || 0) + 1;
        shopImageCount.set(shopKey, imgCount);
        console.log('Analyzing image', imgCount, 'for:', shopKey);

        // ── 1. Upload image Etsy sur ImgBB pour URL publique ──────────
        if (!listing.image) return;

        let etsyPublicUrl;
        try {
          etsyPublicUrl = await uploadCached(listing.image);
        } catch (e) {
          console.warn('ImgBB upload (Etsy) failed:', e.message);
          return;
        }
        if (!etsyPublicUrl) return;

        // ── 2. Serper Google Lens — recherche par image ───────────────
        // On envoie l'image Etsy à Google Lens et on cherche
        // un résultat AliExpress parmi les correspondances visuelles
        await new Promise(r => setTimeout(r, 100)); // éviter Serper 429
        let aliResult = null;
        try {
          const lensRes = await axios.post(
            'https://google.serper.dev/lens',
            { url: etsyPublicUrl, gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
          );

          // Chercher AliExpress dans visual_matches d'abord, puis organic
          const allResults = [
            ...(lensRes.data.visual_matches || []),
            ...(lensRes.data.organic        || []),
          ];

          console.log('🔍 Lens:', (lensRes.data.visual_matches || []).length, 'visual +', (lensRes.data.organic || []).length, 'organic');

          aliResult = allResults.find(r => {
            const url = r.link || r.url || '';
            return url.includes('aliexpress.com') && url.includes('/item/') && (r.imageUrl || r.thumbnailUrl);
          });

        } catch (e) {
          const status = e.response?.status;
          if (status === 401) {
            send({ step: 'error', message: '❌ Serper API key invalid (401)' });
            throw new Error('Serper 401 — abort');
          }
          console.warn('Serper Lens error:', e.message);
          return;
        }

        if (!aliResult) {
          console.log('🛒 Result: none');
          return;
        }

        const aliImageUrl = aliResult.imageUrl || aliResult.thumbnailUrl;
        const aliUrl      = aliResult.link || aliResult.url;
        console.log('🛒 Result:', aliUrl);

        // ── 3. Gemini désactivé — compter directement comme dropshipper si Lens a trouvé AliExpress
        if (shopKey) shopMatched.add(shopKey);
        dropshippers++;
        dropshipperShops.push({
          shopName:   listing.shopName || 'Unknown',
          shopUrl:    listing.shopName ? 'https://www.etsy.com/shop/' + listing.shopName : (listing.link || '#'),
          aliUrl:     aliUrl,
          similarity: 75,
        });
        console.log('✅ Lens match direct — ' + (listing.shopName || 'shop'));
        send({ step: 'match', message: '🛒 Match Lens — ' + (listing.shopName || 'shop') + ' (' + dropshippers + ' dropshippers)' });

        // Marquer la boutique comme analysée
        if (true) {
          const maxImages = 3;
          if ((shopImageCount.get(shopKey) || 0) >= maxImages) {
            if (shopKey) shopsAnalyzed.add(shopKey);
            console.log('No match after', maxImages, 'images for:', shopKey);
          }
        }

      } catch (e) {
        // Si erreur fatale (ex: Serper 401), propager pour stopper le pipeline
        if (e.message.includes('abort')) throw e;
        console.warn('analyzeOne failed for', listing.shopName, e.message);
      }

      analyzed++;
      send({ step: 'analyzing', message: '🔎 ' + analyzed + '/' + totalShops + ' analyzed — ' + dropshippers + ' dropshippers found' });
    }

    // Séquentiel (1 worker) pour éviter les 429 Gemini et Serper
    const queue = [...listings];
    async function worker() {
      while (queue.length > 0) {
        const listing = queue.shift();
        if (listing) await analyzeOne(listing);
      }
    }
    await Promise.all(Array.from({ length: 1 }, worker));

    // ── STEP 5 : Compute score ──
    const score = computeDropshipScore(dropshippers, totalShops);

    // Save competition result to MongoDB
    // Utiliser $set avec les champs pointés pour forcer la mise à jour du sous-document
    await SavedShop.findByIdAndUpdate(req.params.id, {
      $set: {
        'lastCompetition.runAt':            new Date(),
        'lastCompetition.keyword':          keyword,
        'lastCompetition.totalShops':       totalShops,
        'lastCompetition.dropshippers':     dropshippers,
        'lastCompetition.dropshipperShops': dropshipperShops,
        'lastCompetition.label':            score.label,
        'lastCompetition.color':            score.color,
        'lastCompetition.description':      score.description,
        'lastCompetition.saturation':       score.saturation,
      }
    }, { new: true });
    console.log('Competition saved — totalShops:', totalShops, 'dropshippers:', dropshippers, 'saturation:', score.saturation);

    send({
      step: 'complete',
      keyword,
      totalShops,
      dropshippers,
      dropshipperShops,
      score,
      label:       score.label,
      color:       score.color,
      description: score.description,
      saturation:  score.saturation,
    });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + (err.message || 'Unexpected error') });
    res.end();
  }
});

// Scrape Etsy search results — all listings, skip if shop already seen, max 400 total
async function scrapeEtsyListingsForCompetition(apiKey, keyword, onPage) {
  const MAX_LISTINGS = 150; // 150 suffisant statistiquement, 3x plus rapide
  const shopsSeen   = new Set(); // shops already analyzed
  const listings    = [];
  let page = 1;

  while (listings.length < MAX_LISTINGS) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
    let html = '';
    try {
      html = await scrapingbeeFetch(etsyUrl, {
        stealth_proxy: 'true',
        wait:          '3000',
      });
    } catch (e) {
      console.warn('Competition scrape page', page, '— both ScrapingBee and ZenRows failed:', e.message);
      break;
    }

    const rawListings = parseSearchResultListings(html);

    let addedOnPage = 0;
    for (const l of rawListings) {
      if (listings.length >= MAX_LISTINGS) break;
      if (!l.image) continue;

      const shopKey = l.shopName || null;

      // Si boutique déjà vue, on peut encore ajouter des images (max 3 par boutique)
      if (shopKey && shopsSeen.has(shopKey)) {
        // Compter combien d'images on a déjà pour cette boutique
        const existing = listings.filter(x => x.shopName === shopKey);
        if (existing.length >= 3) continue; // déjà 3 images → passer
        // Ajouter une image supplémentaire pour cette boutique
        listings.push({ shopName: shopKey, image: l.image, link: l.link, extraImage: true });
        addedOnPage++;
        continue;
      }

      // Nouvelle boutique
      if (shopKey) shopsSeen.add(shopKey);
      listings.push({ shopName: shopKey, image: l.image, link: l.link });
      addedOnPage++;
    }

    onPage(page, listings.length);

    // Stop si rien de nouveau sur cette page, pas de page suivante, ou limite atteinte
    const hasNext = html.includes('pagination-next') || html.includes(`page=${page + 1}`);
    if (!hasNext || listings.length >= MAX_LISTINGS) break;
    // Stop anticipé : 2 pages consécutives sans nouvelles boutiques
    if (addedOnPage === 0) break;
    page++;
    await new Promise(r => setTimeout(r, 400)); // réduit de 800ms
  }

  console.log('Competition: total listings to analyze:', listings.length);
  return listings;
}

// Extract listings from Etsy search result HTML (covers all 3 strategies)
function parseSearchResultListings(html) {
  const results = [];
  const seen = new Set();

  // Strategy 1: JSON-LD
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data  = JSON.parse(raw);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url  = item.url || item['@id'];
        const img  = item.image?.[0] || item.image;
        const name = item.name;
        if (!url || !url.includes('/listing/') || !img || !name) continue;
        const cleanUrl = url.split('?')[0];
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);
        // Try all possible shopName fields in JSON-LD
        const shopName = item.seller?.name
          || item.brand?.name
          || item.offers?.seller?.name
          || item.manufacturer?.name
          || item.provider?.name
          || null;
        // Also try to extract shopName from the listing URL context in full HTML
        let resolvedShop = shopName;
        if (!resolvedShop) {
          const idx = html.indexOf(cleanUrl.split('/listing/')[1]?.split('/')[0] || '');
          if (idx > -1) {
            const ctx = html.slice(Math.max(0, idx - 2000), idx + 2000);
            const m = ctx.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/i)
                   || ctx.match(/"shopName"\s*:\s*"([^"]+)"/i);
            if (m) resolvedShop = m[1];
          }
        }
        const shopUrl = resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null;
        results.push({ title: name, link: cleanUrl, image: img, shopName: resolvedShop, shopUrl });
      }
    } catch {}
  }
  if (results.filter(r => r.shopName).length >= 2) return results;

  // Strategy 2: data-listing-id blocks
  const blocks = [...html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)];
  for (const block of blocks) {
    const b = block[1];
    const linkM = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgM  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    const shopM = b.match(/data-shop-name="([^"]+)"/i);
    if (linkM && imgM && shopM && !seen.has(linkM[1])) {
      seen.add(linkM[1]);
      const shopName = shopM[1];
      results.push({ link: linkM[1], image: imgM[1].split('?')[0], shopName, shopUrl: `https://www.etsy.com/shop/${shopName}` });
    }
  }
  if (results.length >= 2) return results;

  // Strategy 3: proximity (links + images near each other in HTML)
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos   = allLinks.map(m  => ({ url: m[1].split('?')[0], pos: m.index }));
  const imgPos    = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      // Extract shopName from nearby HTML — wider context window
      const ctx = html.slice(Math.max(0, link.pos - 2000), link.pos + 2000);
      const shopM = ctx.match(/data-shop-name="([^"]+)"/i)
                 || ctx.match(/href="https:\/\/www\.etsy\.com\/shop\/([A-Za-z0-9_-]+)"/i)
                 || ctx.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/i)
                 || ctx.match(/"shopName"\s*:\s*"([^"]+)"/i)
                 || ctx.match(/"shop_name"\s*:\s*"([^"]+)"/i);
      const shopName = shopM ? shopM[1] : null;
      results.push({ link: link.url, image: closest.url, shopName, shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null });
    }
  }

  return results;
}


function extractAboutText(html) {
  const patterns = [
    // Etsy JSON data embedded in page
    /"shop_description"\s*:\s*"([^"]{30,1500})"/i,
    /"shopDescription"\s*:\s*"([^"]{30,1500})"/i,
    /"description"\s*:\s*"([^"]{30,1500})"/i,
    /"about_text"\s*:\s*"([^"]{30,1500})"/i,
    /"about"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]{30,1500})"/i,
    // HTML sections
    /<div[^>]*class="[^"]*shop-about[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]*id="about"[^>]*>([\s\S]*?)<\/section>/i,
    /<div[^>]*data-region="about"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="about"[^>]*>([\s\S]*?)<\/div>/i,
    // Meta fallback
    /<meta[^>]+name="description"[^>]+content="([^"]{30,500})"/i,
    /<meta[^>]+content="([^"]{30,500})"[^>]+name="description"/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const text = m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\n/g, ' ').replace(/\"/g, '"')
        .replace(/\s+/g, ' ').trim();
      if (text.length > 30) return text;
    }
  }
  // Last resort: all paragraph text
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const combined = paras
    .map(p => p[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 30)
    .join(' ');
  return combined.slice(0, 1500);
}

function computeDropshipScore(dropshippers, totalShops) {
  const pct = totalShops > 0 ? Math.round((dropshippers / totalShops) * 100) : 0;
  const saturation = pct;

  if (pct <= 10) return { label: 'Very Low',  color: '#22c55e', description: 'Almost no dropshippers — excellent original niche!',          saturation };
  if (pct <= 25) return { label: 'Low',        color: '#86efac', description: 'Few dropshippers — good opportunity with differentiation.',   saturation };
  if (pct <= 45) return { label: 'Moderate',   color: '#fbbf24', description: 'Some dropshipping presence. Stand out with quality.',         saturation };
  if (pct <= 65) return { label: 'High',        color: '#f97316', description: 'Many dropshippers in this niche. Tough competition.',         saturation };
  return                { label: 'Very High',   color: '#ef4444', description: 'Niche heavily flooded with dropshippers. Very hard to win.',  saturation };
    }



