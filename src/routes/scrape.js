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

const { scrapeEtsy }            = require('../services/etsyScraper');
const { reverseImageSearch }    = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress } = require('../services/imageSimilarity');

async function parallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── NICHE KEYWORD (dice button) ──
router.post('/niche-keyword', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing' });
  try {
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: `You are a creative Etsy niche researcher. Generate ONE unique and specific English product keyword (2-4 words) for an Etsy search. Rules: PHYSICAL products only (no digital, no printables, no SVG, no downloads). Be creative and vary across these categories randomly: jewelry, home decor, clothing, accessories, baby items, pet products, seasonal, vintage, personalized gifts, kitchen, candles, crystals, art, stationery, tools, toys, wedding, garden, sports, travel, wellness. Pick a random category and a specific niche within it. Use a random seed: ${Math.floor(Math.random()*100000)}. Reply with ONLY the keyword, no punctuation, no explanation.` }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const keyword = (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (!keyword) return res.status(500).json({ error: 'No keyword generated' });
    res.json({ keyword });
  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    res.status(500).json({ error: detail });
  }
});

// ── SEARCH ──
router.post('/search', async (req, res) => {
  const { keyword, maxCount = 10 } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  const missing = ['SCRAPEAPI_KEY', 'SERPER_API_KEY', 'IMGBB_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: 'Missing keys: ' + missing.join(', ') });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send         = (step, msg) => res.write('data: ' + JSON.stringify({ step, message: msg }) + '\n\n');
  const sendError    = msg => { res.write('data: ' + JSON.stringify({ step: 'error', message: msg }) + '\n\n'); res.end(); };
  const sendComplete = (r, ds) => { res.write('data: ' + JSON.stringify({ step: 'complete', results: r, dropshipperShops: ds || [] }) + '\n\n'); res.end(); };

  try {
    send('scraping_etsy', `🔍 Scraping Etsy for "${keyword}"...`);
    const listings = await scrapeEtsy(keyword, maxCount);
    if (!listings.length) return sendError('No Etsy listings found');
    send('etsy_done', `✅ ${listings.length} listings found`);

    send('reverse_search', `🔎 Analyzing ${listings.length} listings in parallel...`);

    let done = 0;
    const allResults = [];
    await parallel(
      listings.filter(l => l.image),
      2,
      async (listing) => {
        try {
          const matches = await reverseImageSearch(listing.image, listing.title || '');
          done++;
          send('comparing', `🔎 ${done}/${listings.length} analyzed`);
          if (!matches.length) return;
          const comparisons = await compareEtsyWithAliexpress(listing, matches);
          if (comparisons.length > 0) {
            allResults.push(...comparisons);
            // Track dropshipper shop
            send('match_found', `✅ ${allResults.length} match(es)`);
          }
        } catch (err) {
          console.error('Erreur listing:', err.message);
          done++;
        }
      }
    );

    send('finalizing', `📊 Done — ${allResults.length} result(s)`);

    const seen = new Set();
    const deduped = allResults
      .sort((a, b) => b.similarity - a.similarity)
      .filter(r => {
        const k = r.aliexpress.link || '';
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    sendComplete(deduped, []);

  } catch (err) {
    sendError(err.message || 'Erreur inattendue');
  }
});

// ── HEALTH ──
router.get('/health', (req, res) => {
  const keys = {
    SCRAPEAPI_KEY:     !!process.env.SCRAPEAPI_KEY,
    SERPER_API_KEY:    !!process.env.SERPER_API_KEY,
    IMGBB_API_KEY:     !!process.env.IMGBB_API_KEY,
    SCRAPINGBEE_KEY:   !!process.env.SCRAPINGBEE_KEY,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

// ── AUTH + SHOPS ──
const { router: authRouter }  = require('./auth');
const shopRouter               = require('./shopRoutes');
router.use('/auth',  authRouter);
router.use('/shops', shopRouter);


// ── Scrape Etsy search results (copie exacte de scrapeEtsyListingsForCompetition dans shopRoutes.js)
function parseListingsFromHtml(html) {
  const results = [], seen = new Set(), shopMap = new Map();
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(raw);
      for (const el of (data.itemListElement || [])) {
        const p = el.item || el;
        const url = p.url || p['@id'] || '';
        const idM = url.match(/\/listing\/(\d+)\//);
        if (!idM) continue;
        const sn = p.brand?.name || p.seller?.name;
        if (sn && !shopMap.has(idM[1])) shopMap.set(idM[1], sn);
      }
      for (const item of (Array.isArray(data) ? data : (data['@graph'] || []))) {
        const url = item.url || item['@id'] || '';
        const idM = url.match(/\/listing\/(\d+)\//);
        if (!idM) continue;
        const sn = item.brand?.name || item.seller?.name;
        if (sn && !shopMap.has(idM[1])) shopMap.set(idM[1], sn);
      }
    } catch {}
  }
  for (const m of html.matchAll(/"listing_id"\s*:\s*"?(\d+)"?[\s\S]{0,400}?"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/g))
    if (!shopMap.has(m[1])) shopMap.set(m[1], m[2]);
  for (const m of html.matchAll(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"[\s\S]{0,400}?"listing_id"\s*:\s*"?(\d+)"?/g))
    if (!shopMap.has(m[2])) shopMap.set(m[2], m[1]);
  for (const m of html.matchAll(/\/listing\/(\d+)\/[^"'\s]{0,100}[\s\S]{0,600}?\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )/g))
    if (!shopMap.has(m[1])) shopMap.set(m[1], m[2]);
  for (const m of html.matchAll(/\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )[\s\S]{0,600}?\/listing\/(\d+)\//g))
    if (!shopMap.has(m[2])) shopMap.set(m[2], m[1]);

  function resolveShop(id, ctx) {
    if (id && shopMap.has(id)) return shopMap.get(id);
    if (!ctx) return null;
    const m = ctx.match(/\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )/i)
           || ctx.match(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i);
    return m ? m[1] : null;
  }

  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(raw);
      const items = [];
      for (const el of (data.itemListElement || [])) items.push(el.item || el);
      for (const item of (Array.isArray(data) ? data : (data['@graph'] || []))) items.push(item);
      for (const p of items) {
        const url = p.url || p['@id'] || '';
        const img = Array.isArray(p.image) ? p.image[0] : p.image;
        if (!url.includes('/listing/') || !img) continue;
        const clean = url.split('?')[0];
        if (seen.has(clean)) continue;
        seen.add(clean);
        const idM = clean.match(/\/listing\/(\d+)\//);
        const sn = p.brand?.name || p.seller?.name || resolveShop(idM?.[1], null);
        results.push({ link: clean, image: img, shopName: sn || null });
      }
    } catch {}
  }
  if (results.filter(r => r.shopName).length >= 2) return results;

  const lms = [...html.matchAll(/\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g)];
  const imgs = [...html.matchAll(/(https:\/\/i\.etsystatic\.com\/[^"'\s,]+\.(?:jpg|jpeg|png|webp))/gi)].map(m => ({ url: m[1].split('?')[0], pos: m.index }));
  for (const lm of lms) {
    const fullUrl = 'https://www.etsy.com/listing/' + lm[1] + '/' + lm[2];
    if (seen.has(fullUrl)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgs) { const d = Math.abs(img.pos - lm.index); if (d < minDist && d < 8000) { minDist = d; closest = img; } }
    if (!closest) continue;
    seen.add(fullUrl);
    const ctx = html.slice(Math.max(0, lm.index - 2000), lm.index + 2000);
    const sn = resolveShop(lm[1], ctx);
    results.push({ link: fullUrl, image: closest.url, shopName: sn || null });
  }
  return results;
}

async function scrapeEtsyForDropship(apiKey, keyword, onPage, fetchFn) {
  const MAX_PAGES = 5, shopsSeen = new Set(), listings = [];
  let page = 1, emptyPages = 0;
  while (page <= MAX_PAGES) {
    const url = 'https://www.etsy.com/search?q=' + encodeURIComponent(keyword) + '&page=' + page;
    let html;
    try { html = await fetchFn(url, { stealth_proxy: 'true', wait: '3000' }); }
    catch (e) { console.warn('Scrape page', page, 'failed:', e.message); break; }
    const raw = parseListingsFromHtml(html);
    let added = 0;
    for (const l of raw) {
      if (!l.image || !l.shopName) continue;
      if (shopsSeen.has(l.shopName)) continue;
      shopsSeen.add(l.shopName);
      listings.push(l);
      added++;
    }
    if (onPage) onPage(page, listings.length);
    const hasNext = html.includes('pagination-next') || html.includes('page=' + (page + 1));
    if (!hasNext) break;
    if (added === 0) { emptyPages++; if (emptyPages >= 2) break; } else emptyPages = 0;
    page++;
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('scrapeEtsyForDropship done:', listings.length, 'shops');
  return listings;
}

// ── SEARCH DROPSHIP ──
// Fonctionne exactement comme la recherche de compétition :
// scrape Etsy → page boutique → 2 images → Google Lens → dropshipping confirmé si 2 matches
router.post('/search-dropship', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  const apiKey = process.env.SCRAPINGBEE_KEY || process.env.SCRAPEAPI_KEY;
  if (!apiKey)                     return res.status(500).json({ error: 'SCRAPINGBEE_KEY missing' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  if (!process.env.IMGBB_API_KEY)  return res.status(500).json({ error: 'IMGBB_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  try {
    const { uploadToImgBB } = require('../services/imgbbUploader');
    const axios = require('axios');

    // ── STEP 1 : Scraper les résultats Etsy (même méthode que la compétition)
    send({ step: 'scraping', message: '🔍 Scraping Etsy for "' + keyword + '"...' });

    // Utiliser la même fonction que la compétition dans shopRoutes
    let listings = [];
    try {
      listings = await scrapeEtsyForDropship(
        apiKey, keyword,
        (page, count) => send({ step: 'scraping', message: '📄 Page ' + page + ' — ' + count + ' listings...' }),
        scrapingbeeFetch
      );
    } catch(e) {
      send({ step: 'error', message: '❌ Scraping failed: ' + e.message }); return res.end();
    }

    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings with shopName:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ No shop names found in Etsy results' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' unique shops. Analyzing...' });

    // ── STEP 2 : Scraper la page boutique + 2 images + Google Lens
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const r = await uploadToImgBB(url);
      imgbbCache.set(url, r);
      return r;
    }

    async function scrapingbeeFetch(targetUrl, sbParams = {}) {
      const sbKey = process.env.SCRAPINGBEE_KEY;
      if (sbKey) {
        try {
          const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
            params: { api_key: sbKey, url: targetUrl, country_code: 'us', timeout: '45000', ...sbParams },
            timeout: 120000,
          });
          const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          if (html.length > 500) return html;
        } catch (e) { console.warn('ScrapingBee failed:', e.message.slice(0, 60)); }
      }
      const saKey = process.env.SCRAPEAPI_KEY;
      if (saKey) {
        const r = await axios.get('http://api.scraperapi.com', {
          params: { api_key: saKey, url: targetUrl, render: 'true', country_code: 'us' },
          timeout: 90000,
        });
        const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        if (html.length > 500) return html;
      }
      throw new Error('All scrapers failed');
    }

    async function scrapeShopImages(shopName) {
      try {
        const html = await scrapingbeeFetch('https://www.etsy.com/shop/' + shopName, { stealth_proxy: 'true', wait: '2000' });
        const images = [], links = [];
        for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
          try {
            const d = JSON.parse(raw);
            for (const el of (d.itemListElement || [])) {
              const p = el.item || el;
              const img = Array.isArray(p.image) ? p.image[0] : p.image;
              if (img && p.url?.includes('/listing/')) { images.push(img); links.push(p.url.split('?')[0]); if (images.length >= 2) break; }
            }
          } catch {}
          if (images.length >= 2) break;
        }
        if (images.length < 2) {
          for (const m of html.matchAll(/https:\/\/i\.etsystatic\.com\/[^"'\s,]+\.(?:jpg|jpeg|png|webp)/gi)) {
            if (!images.includes(m[0])) { images.push(m[0].split('?')[0]); links.push(null); }
            if (images.length >= 2) break;
          }
        }
        return images.slice(0, 2).map((img, i) => ({ image: img, link: links[i] || null }));
      } catch { return []; }
    }

    async function lensMatch(imageUrl) {
      try {
        const pub = await uploadCached(imageUrl);
        if (!pub) return null;
        await new Promise(r => setTimeout(r, 150));
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
          const shopImages = await scrapeShopImages(listing.shopName);
          if (shopImages.length < 2) continue;
          const [m1, m2] = await Promise.all([lensMatch(shopImages[0].image), lensMatch(shopImages[1].image)]);
          if (m1 && m2) {
            dropshippers.push({
              shopName:   listing.shopName,
              shopUrl:    'https://www.etsy.com/shop/' + listing.shopName,
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

    await Promise.all([worker(), worker()]);
    send({ step: 'complete', dropshippers, total: listings.length });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + err.message });
    res.end();
  }
});


module.exports = router;




