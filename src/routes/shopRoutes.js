const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const { uploadToImgBB } = require('../services/imgbbUploader');
const { scrapeEtsy } = require('../services/etsyScraper');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl, keyword } = req.body;
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
      { $set: { shopName, shopAvatar: shopAvatar || null, productImage: productImage || null, productUrl: productUrl || null, keyword: keyword || null, savedAt: new Date() }, $setOnInsert: { userId: req.user.id } },
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
        const publicUrl = await uploadToImgBB(listing.image);
        if (!publicUrl || !publicUrl.startsWith('http')) continue;

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
          continue;
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
// HELPER : Scraping avec ScrapingBee, fallback ScraperAPI
// ════════════════════════════════════════════════════════════════════════
async function scrapingbeeFetch(targetUrl, sbParams = {}) {
  const sbKey = process.env.SCRAPINGBEE_KEY;
  if (sbKey) {
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: sbKey, url: targetUrl, country_code: 'us', timeout: '45000', ...sbParams },
        timeout: 120000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) { console.log('ScrapingBee OK —', html.length, 'chars'); return html; }
    } catch (e) {
      console.warn('ScrapingBee failed (' + e.response?.status + ') — trying ScraperAPI:', e.message.slice(0, 80));
    }
  }
  const saKey = process.env.SCRAPEAPI_KEY;
  if (saKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await axios.get('http://api.scraperapi.com', {
          params: { api_key: saKey, url: targetUrl, render: 'true', country_code: 'us' },
          timeout: 90000,
        });
        const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        if (html.length > 500) { console.log('ScraperAPI OK —', html.length, 'chars'); return html; }
      } catch (e) {
        console.warn('ScraperAPI attempt', attempt, 'failed:', e.message.slice(0, 80));
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw new Error('All scrapers failed — check SCRAPINGBEE_KEY, SCRAPEAPI_KEY');
}

async function scrapeShopListings(shopUrl) {
  const parseHtml = (html) => {
    const listings = [], seen = new Set();
    const patterns = [
      /"listing_id"\s*:\s*(\d+)[^}]{0,300}"title"\s*:\s*"([^"]{5,150})"/g,
      /"listingId"\s*:\s*(\d+)[^}]{0,300}"title"\s*:\s*"([^"]{5,150})"/g,
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(html)) !== null && listings.length < 12) {
        const id = m[1], title = m[2].trim();
        if (!seen.has(id) && title.length > 3) {
          seen.add(id);
          listings.push({ id, title, url: 'https://www.etsy.com/listing/' + id, image: null });
        }
      }
      if (listings.length >= 5) break;
    }
    return listings;
  };

  const sbKey = process.env.SCRAPINGBEE_KEY;
  if (sbKey) {
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: sbKey, url: shopUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '3000', timeout: '45000' },
        timeout: 90000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      const listings = parseHtml(html);
      if (listings.length > 0) { console.log('ScrapingBee shop OK —', listings.length, 'listings'); return listings; }
    } catch (e) {
      console.warn('ScrapingBee shop failed (' + e.response?.status + '):', e.message.slice(0, 80));
    }
  }

  const saKey = process.env.SCRAPEAPI_KEY;
  if (saKey) {
    try {
      const r = await axios.get('http://api.scraperapi.com', {
        params: { api_key: saKey, url: shopUrl, render: 'true', country_code: 'us' },
        timeout: 90000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      const listings = parseHtml(html);
      if (listings.length > 0) { console.log('ScraperAPI shop OK —', listings.length, 'listings'); return listings; }
    } catch (e) {
      console.warn('ScraperAPI shop failed:', e.message.slice(0, 80));
    }
  }

  return [];
}

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
        const wait = 5000 * Math.pow(2, attempt);
        console.warn(`Gemini 429 — attente ${wait / 1000}s avant retry ${attempt + 1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
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
    const apiKey = process.env.SCRAPINGBEE_KEY || process.env.SCRAPEAPI_KEY;
    if (!apiKey) { send({ step: 'error', message: '❌ SCRAPINGBEE_KEY or SCRAPEAPI_KEY missing' }); return res.end(); }
    if (!process.env.SERPER_API_KEY) { send({ step: 'error', message: '❌ SERPER_API_KEY missing' }); return res.end(); }
    if (!process.env.IMGBB_API_KEY)  { send({ step: 'error', message: '❌ IMGBB_API_KEY missing' });  return res.end(); }

    // ── STEP 1 : Keyword ──
    let keyword = '';
    if (shop.keyword && shop.keyword.trim().length > 1) {
      keyword = shop.keyword.trim().toLowerCase();
    }
    if (!keyword && shop.productUrl) {
      const m = shop.productUrl.match(/\/listing\/\d+\/([^/?#]+)/);
      if (m) {
        keyword = m[1].replace(/-/g, ' ').replace(/[^a-z0-9 ]/gi, ' ').trim().toLowerCase();
        keyword = keyword.split(/\s+/).slice(0, 3).join(' ');
      }
    }
    if (!keyword && shop.shopName) {
      keyword = shop.shopName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
    }
    if (!keyword) {
      send({ step: 'error', message: '❌ Could not determine a keyword for this shop.' });
      return res.end();
    }
    send({ step: 'keyword', message: '🔑 Keyword: "' + keyword + '"', keyword });

    // ── STEP 2 : Scrape Etsy via etsyScraper (ScrapingBee + fallback) ──
    send({ step: 'scraping', message: '🔍 Scraping Etsy for "' + keyword + '"...' });
    let rawListings = [];
    try {
      rawListings = await scrapeEtsy(keyword, 150);
    } catch(e) {
      console.warn('scrapeEtsy failed:', e.message);
    }

    // Dédupliquer par boutique
    const seenShops = new Set();
    const listings = rawListings.filter(l => {
      if (!l.image) return false;
      if (l.shopName && seenShops.has(l.shopName)) return false;
      if (l.shopName) seenShops.add(l.shopName);
      return true;
    });

    const totalShops = listings.length;
    if (totalShops === 0) {
      send({ step: 'error', message: '❌ No listings found on Etsy for this keyword' });
      return res.end();
    }
    send({ step: 'status', message: '✅ ' + totalShops + ' unique shops found. Starting reverse image search...' });

    // ── STEP 3 : Reverse image search ──
    let dropshippers = 0;
    let analyzed = 0;
    const dropshipperShops = [];
    const SIMILARITY_THRESHOLD = 0.55;
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const result = await uploadToImgBB(url);
      imgbbCache.set(url, result);
      return result;
    }
    const shopsAnalyzed = new Set();

    async function analyzeOne(listing) {
      try {
        const shopKey = listing.shopName || listing.link;
        if (shopKey && shopsAnalyzed.has(shopKey)) return;
        if (shopKey) shopsAnalyzed.add(shopKey);
        if (!listing.image) return;

        let etsyPublicUrl;
        try { etsyPublicUrl = await uploadCached(listing.image); } catch (e) { return; }
        if (!etsyPublicUrl) return;

        await new Promise(r => setTimeout(r, 100));
        let aliResult = null;
        try {
          const lensRes = await axios.post(
            'https://google.serper.dev/lens',
            { url: etsyPublicUrl, gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
          );
          const allResults = [...(lensRes.data.visual_matches || []), ...(lensRes.data.organic || [])];
          console.log('🔍 Lens:', (lensRes.data.visual_matches || []).length, 'visual +', (lensRes.data.organic || []).length, 'organic');
          aliResult = allResults.find(r => {
            const url = r.link || r.url || '';
            return url.includes('aliexpress.com') && url.includes('/item/') && (r.imageUrl || r.thumbnailUrl);
          });
        } catch (e) {
          if (e.response?.status === 401) { send({ step: 'error', message: '❌ Serper API key invalid (401)' }); throw new Error('Serper 401 — abort'); }
          return;
        }

        if (!aliResult) { console.log('🛒 Result: none'); return; }
        const aliUrl = aliResult.link || aliResult.url;
        console.log('🛒 Result:', aliUrl);

        dropshippers++;
        dropshipperShops.push({
          shopName:   listing.shopName || 'Unknown',
          shopUrl:    listing.shopName ? 'https://www.etsy.com/shop/' + listing.shopName : (listing.link || '#'),
          aliUrl,
          similarity: 75,
        });
        console.log('✅ Lens match direct —', listing.shopName || 'shop');
        send({ step: 'match', totalShops, message: '🛒 Match — ' + (listing.shopName || 'shop') + ' (' + dropshippers + ' dropshippers)' });

      } catch (e) {
        if (e.message.includes('abort')) throw e;
        console.warn('analyzeOne failed for', listing.shopName, e.message);
      }
      analyzed++;
      send({ step: 'analyzing', totalShops, message: '🔎 ' + analyzed + '/' + totalShops + ' analyzed — ' + dropshippers + ' dropshippers found' });
    }

    const queue = [...listings];
    async function worker() {
      while (queue.length > 0) {
        const listing = queue.shift();
        if (listing) await analyzeOne(listing);
      }
    }
    await Promise.all(Array.from({ length: 3 }, worker));

    // ── STEP 4 : Score ──
    const score = computeDropshipScore(dropshippers, totalShops);
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
    console.log('Competition saved — totalShops:', totalShops, 'dropshippers:', dropshippers);

    send({ step: 'complete', keyword, totalShops, dropshippers, dropshipperShops, score, label: score.label, color: score.color, description: score.description, saturation: score.saturation });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + (err.message || 'Unexpected error') });
    res.end();
  }
});

function extractAboutText(html) {
  const patterns = [
    /"shop_description"\s*:\s*"([^"]{30,1500})"/i,
    /"shopDescription"\s*:\s*"([^"]{30,1500})"/i,
    /"description"\s*:\s*"([^"]{30,1500})"/i,
    /"about_text"\s*:\s*"([^"]{30,1500})"/i,
    /"about"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]{30,1500})"/i,
    /<div[^>]*class="[^"]*shop-about[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]*id="about"[^>]*>([\s\S]*?)<\/section>/i,
    /<meta[^>]+name="description"[^>]+content="([^"]{30,500})"/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const text = m[1].replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').replace(/\n/g,' ').replace(/\"/g,'"').replace(/\s+/g,' ').trim();
      if (text.length > 30) return text;
    }
  }
  return '';
}

function computeDropshipScore(dropshippers, totalShops) {
  const pct = totalShops > 0 ? Math.round((dropshippers / totalShops) * 100) : 0;
  const saturation = pct;
  if (pct <= 10) return { label: 'Very Low',  color: '#22c55e', description: 'Almost no dropshippers — excellent original niche!',         saturation };
  if (pct <= 25) return { label: 'Low',        color: '#86efac', description: 'Few dropshippers — good opportunity with differentiation.',  saturation };
  if (pct <= 45) return { label: 'Moderate',   color: '#fbbf24', description: 'Some dropshipping presence. Stand out with quality.',        saturation };
  if (pct <= 65) return { label: 'High',        color: '#f97316', description: 'Many dropshippers in this niche. Tough competition.',        saturation };
  return               { label: 'Very High',   color: '#ef4444', description: 'Niche heavily flooded with dropshippers. Very hard to win.', saturation };
}

