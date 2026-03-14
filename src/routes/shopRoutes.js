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

async function scrapeShopListings(shopUrl) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  const reqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}`
    + `&url=${encodeURIComponent(shopUrl)}`
    + `&render_js=true&premium_proxy=true&country_code=us&wait=2000&timeout=45000`;

  const res  = await axios.get(reqUrl, { timeout: 120000 });
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  const listings = [];

  const listingPattern = /"listing_id"\s*:\s*(\d+)[^}]*?"title"\s*:\s*"([^"]+)"[^}]*?"price"[^}]*?"amount"\s*:\s*(\d+)[^}]*?"divisor"\s*:\s*(\d+)/g;
  let m;
  while ((m = listingPattern.exec(html)) !== null && listings.length < 30) {
    const id    = m[1];
    const title = m[2];
    const price = parseInt(m[3]) / parseInt(m[4]);
    const url   = `https://www.etsy.com/listing/${id}/${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
    listings.push({ id, title, price, url, image: null });
  }

  const imgMatches = [...html.matchAll(/https:\/\/i\.etsystatic\.com\/[^\s"']+(?:il|il_fullxfull)[^"'\s]*/g)];
  imgMatches.forEach((im, idx) => {
    if (listings[idx]) listings[idx].image = im[0];
    else if (idx < 30) listings.push({ image: im[0], title: '', url: shopUrl, price: null });
  });

  if (listings.length === 0) {
    const hrefMatches = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"]+)"/g)];
    const seen = new Set();
    for (const hm of hrefMatches) {
      if (seen.has(hm[1]) || listings.length >= 30) break;
      seen.add(hm[1]);
      listings.push({ url: hm[1], title: hm[1].split('/').pop().replace(/-/g, ' '), image: null, price: null });
    }
  }

  return listings.filter(l => l.image || l.url);
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
    const apiKey = process.env.SCRAPINGBEE_KEY;
    if (!apiKey) { send({ step: 'error', message: '❌ SCRAPINGBEE_KEY missing' }); return res.end(); }
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

    const totalShops = listings.length;
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

    // Set des boutiques déjà analysées — on saute si déjà vue
    const shopsAnalyzed = new Set();

    async function analyzeOne(listing) {
      try {
        // ── Sauter si boutique déjà analysée ──────────────────────────
        const shopKey = listing.shopName || listing.link;
        if (shopKey && shopsAnalyzed.has(shopKey)) {
          console.log('Skip (already analyzed):', shopKey);
          return;
        }
        if (shopKey) shopsAnalyzed.add(shopKey);

        // ── 1. Upload image Etsy sur ImgBB pour URL publique ──────────
        // Serper Lens a besoin d'une URL publique accessible
        if (!listing.image) return;

        let etsyPublicUrl;
        try {
          etsyPublicUrl = await uploadToImgBB(listing.image);
        } catch (e) {
          console.warn('ImgBB upload (Etsy) failed:', e.message);
          return;
        }
        if (!etsyPublicUrl) return;

        // ── 2. Serper Google Lens — recherche par image ───────────────
        // On envoie l'image Etsy à Google Lens et on cherche
        // un résultat AliExpress parmi les correspondances visuelles
        await new Promise(r => setTimeout(r, 300)); // éviter Serper 429
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

        // ── 3. Upload image AliExpress sur ImgBB ─────────────────────
        let aliPublicUrl;
        try {
          aliPublicUrl = await uploadToImgBB(aliImageUrl);
        } catch (e) {
          console.warn('ImgBB upload (Ali) failed:', e.message);
          return;
        }
        if (!aliPublicUrl) return;

        // ── 4. Récupérer les deux images en base64 ────────────────────
        const fetchB64 = async (url) => {
          const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
          const ct = r.headers['content-type'] || 'image/jpeg';
          return { data: Buffer.from(r.data).toString('base64'), mime: ct.split(';')[0] };
        };

        let etsyImg, aliImg;
        try {
          [etsyImg, aliImg] = await Promise.all([
            fetchB64(etsyPublicUrl),
            fetchB64(aliPublicUrl),
          ]);
        } catch (e) {
          console.warn('Image fetch (base64) failed:', e.message);
          return;
        }

        // ── 5. Gemini Vision — l'objet Etsy correspond-il à AliExpress ?
        await new Promise(r => setTimeout(r, 1500)); // délai rate limit Gemini
        const geminiRes = await callGeminiWithRetry({
          contents: [{
            parts: [
              { inline_data: { mime_type: etsyImg.mime, data: etsyImg.data } },
              { inline_data: { mime_type: aliImg.mime,  data: aliImg.data  } },
              { text: 'Compare these two product images. Does the Etsy product look like a dropshipped or wholesale version of the AliExpress product?\nScore: same product+design→0.85-1.0 | same type+similar→0.65-0.84 | same category→0.35-0.64 | different→0.0-0.34\nIgnore background, watermarks, angle, lighting.\nReply with ONLY a decimal number (e.g. 0.82).' }
            ]
          }]
        });

        const txt   = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '0';
        const match = txt.match(/(?:0\.\d+|1(?:\.0+)?)/);
        const gemScore = match ? parseFloat(match[0]) : 0;

        console.log('🤖 Gemini vision:', Math.round(gemScore * 100) + '%');

        if (gemScore >= SIMILARITY_THRESHOLD) {
          dropshippers++;
          dropshipperShops.push({
            shopName:   listing.shopName || 'Unknown',
            shopUrl:    listing.shopName ? 'https://www.etsy.com/shop/' + listing.shopName : (listing.link || '#'),
            aliUrl:     aliUrl,
            similarity: Math.round(gemScore * 100),
          });
          console.log('✅ Similarity:', Math.round(gemScore * 100) + '% —', aliUrl);
          send({ step: 'match', message: '🛒 Match ' + Math.round(gemScore * 100) + '% — ' + (listing.shopName || 'shop') + ' (' + dropshippers + ' dropshippers)' });
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
  const MAX_LISTINGS = 400;
  const shopsSeen   = new Set(); // shops already analyzed
  const listings    = [];
  let page = 1;

  while (listings.length < MAX_LISTINGS) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
    let html = '';
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: apiKey, url: etsyUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '3000', timeout: '45000', block_resources: false },
        timeout: 120000,
      });
      html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } catch (e) {
      console.warn('Competition scrape page', page, e.message);
      break;
    }

    const rawListings = parseSearchResultListings(html);

    let addedOnPage = 0;
    for (const l of rawListings) {
      if (listings.length >= MAX_LISTINGS) break;
      if (!l.image) continue;

      // Skip if this shop was already analyzed
      if (l.shopName && shopsSeen.has(l.shopName)) continue;

      // Mark shop as seen, add listing
      if (l.shopName) shopsSeen.add(l.shopName);
      listings.push({ shopName: l.shopName || null, image: l.image, link: l.link });
      addedOnPage++;
    }

    onPage(page, listings.length);

    // Stop if nothing new, no next page, or limit reached
    const hasNext = html.includes('pagination-next') || html.includes(`page=${page + 1}`);
    if (!hasNext || addedOnPage === 0 || listings.length >= MAX_LISTINGS) break;
    page++;
    await new Promise(r => setTimeout(r, 800));
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



