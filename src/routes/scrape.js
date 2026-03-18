const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');
const { scrapingbeeFetch } = require('../services/scrapingFetch');

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

// ── SEARCH DROPSHIP ──
// Recherche Etsy par mot-clé, scrape les boutiques trouvées,
// compare 2 images par boutique avec Google Lens → n'affiche que les dropshippers
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

    const shopRoutes = require('./shopRoutes');
    let listings = await shopRoutes.scrapeEtsyListingsForCompetition(
      apiKey, keyword,
      (page, count) => send({ step: 'scraping', message: '📄 Page ' + page + ' — ' + count + ' listings...' })
    );

    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings with shopName:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ No shop names found in Etsy results' });
      return res.end();
    }
    send({ step: 'scraping', message: '✅ ' + listings.length + ' unique shops found' });

    // ── STEP 2 : Scraper la page boutique + comparer 2 images ──
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const r = await uploadToImgBB(url);
      imgbbCache.set(url, r);
      return r;
    }

    async function scrapeShopImages(shopName) {
      try {
        const shopUrl = 'https://www.etsy.com/shop/' + shopName;
        const html = await scrapingbeeFetch(shopUrl, { stealth_proxy: 'true', wait: '2000' });
        const images = [];
        const links  = [];
        // JSON-LD
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
        // Fallback etsystatic
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
        const res2 = await axios.post('https://google.serper.dev/lens',
          { url: pub, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );
        const all = [...(res2.data.visual_matches || []), ...(res2.data.organic || [])];
        return all.find(r => { const u = r.link || r.url || ''; return u.includes('aliexpress.com') && u.includes('/item/') && (r.imageUrl || r.thumbnailUrl); }) || null;
      } catch (e) {
        if (e.response?.status === 401) throw new Error('serper_401');
        return null;
      }
    }

    const dropshippers = [];
    let analyzed = 0;

    // 2 workers en parallèle
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
              shopName:     listing.shopName,
              shopUrl:      'https://www.etsy.com/shop/' + listing.shopName,
              shopImage:    shopImages[0].image,
              listingUrl:   shopImages[0].link || listing.link,
            });
            send({ step: 'match', message: '✅ ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers)', shop: dropshippers[dropshippers.length - 1] });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '❌ Serper key invalid' }); return res.end(); }
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




