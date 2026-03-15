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

const { scrapeEtsy, debugEtsyHtml }              = require('../services/etsyScraper');
const { reverseImageSearch }                      = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress }               = require('../services/imageSimilarity');
const { getShopInfo }                             = require('../services/shopScraper');

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
      { contents: [{ parts: [{ text: 'Give me a single short English niche keyword (2-4 words) for an Etsy product search. It should be a specific, trending, or profitable niche for PHYSICAL products only. Do NOT suggest digital products, printables, SVG files, digital downloads, templates, or any non-physical items. Respond with ONLY the keyword, no punctuation, no explanation.' }] }] },
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

// ── DEBUG KEYS ──
router.get('/debug', (req, res) => {
  const keys = ['SCRAPEAPI_KEY', 'SERPER_API_KEY', 'IMGBB_API_KEY', 'SCRAPINGBEE_KEY'];
  const status = {};
  for (const key of keys) {
    const val = process.env[key];
    status[key] = !val ? 'UNDEFINED' : val.includes('your_') ? 'DEFAUT' : `OK (${val.substring(0, 6)}...)`;
  }
  res.json({ keys: status });
});

// ── DEBUG SHOP HTML ──
router.get('/debug-shop', async (req, res) => {
  const shopUrl = req.query.url;
  if (!shopUrl) return res.status(400).json({ error: 'Parameter ?url= required' });
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SCRAPINGBEE_KEY manquant' });
  try {
    const reqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}`
      + `&url=${encodeURIComponent(shopUrl)}`
      + `&render_js=true&premium_proxy=true&country_code=us&wait=2000&timeout=45000`;
    const response = await axios.get(reqUrl, { timeout: 120000 });
    const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
    const keywords = ['sales', 'since', 'joined', 'creation', 'member', 'sales', 'created'];
    const excerpts = {};
    for (const kw of keywords) {
      const idx = html.toLowerCase().indexOf(kw);
      if (idx !== -1) excerpts[kw] = html.substring(Math.max(0, idx - 100), idx + 200);
    }
    res.json({ htmlLength: html.length, excerpts, head: html.substring(0, 3000) });
  } catch (err) {
    res.status(500).json({ error: err.message, status: err.response?.status });
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

  const sendRaw      = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
  const send         = (step, msg, pct) => sendRaw({ step, message: msg, pct: pct ?? null });
  const sendError    = msg => { clearInterval(keepAlive); sendRaw({ step: 'error', message: msg }); res.end(); };
  const sendComplete = (r, ds) => { clearInterval(keepAlive); sendRaw({ step: 'complete', results: r, dropshipperShops: ds || [], pct: 100 }); res.end(); };

  // Keep-alive : envoyer un ping toutes les 10s pour éviter que Render coupe la connexion SSE
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 10000);
  res.on('close', () => clearInterval(keepAlive));

  try {
    // ── Étape 1 : scraping Etsy (0% → 30%) ──────────────────────────
    send('log', '🔍 Scraping Etsy for "' + keyword + '"...', 2);
    const listings = await scrapeEtsy(keyword, maxCount);
    if (!listings.length) return sendError('No Etsy listings found');
    send('log', `✅ ${listings.length} listings found on Etsy`, 30);

    // ── Étape 2 : enrichir shopName/shopUrl depuis les données du listing (instantané) ──
    listings.forEach(listing => {
      const info = {
        shopName:   listing.shopName   || null,
        shopUrl:    listing.shopUrl    || (listing.shopName ? 'https://www.etsy.com/shop/' + listing.shopName : null),
        shopAvatar: listing.shopAvatar || null,
      };
      listing.shopName   = info.shopName;
      listing.shopUrl    = info.shopUrl;
      listing.shopAvatar = info.shopAvatar;
    });
    send('log', `🏪 ${listings.filter(l => l.shopName).length}/${listings.length} shops identified`, 33);

    // ── Étape 3 : analyse par image (33% → 95%) ─────────────────────
    const toAnalyze = listings.filter(l => l.image);
    const total = toAnalyze.length;
    send('log', `🖼 Starting image analysis for ${total} listings...`, 35);

    let done = 0;
    const allResults = [];
    const dropshipperShops = [];

    await parallel(
      toAnalyze,
      2,
      async (listing) => {
        try {
          // Log : upload ImgBB
          const pctBefore = 35 + Math.round((done / total) * 60);
          send('log', `📤 Uploading image ${done + 1}/${total}...`, pctBefore);

          const matches = await reverseImageSearch(listing.image, listing.title || '');
          done++;
          const pct = 35 + Math.round((done / total) * 60);

          if (!matches.length) {
            send('log', `🔍 ${done}/${total} — no AliExpress match`, pct);
            return;
          }

          send('log', `🛒 ${done}/${total} — AliExpress match found!`, pct);
          const comparisons = await compareEtsyWithAliexpress(listing, matches);
          if (comparisons.length > 0) {
            allResults.push(...comparisons);
            const shopName = listing.shopName || null;
            const shopUrl  = listing.shopUrl  || (shopName ? 'https://www.etsy.com/shop/' + shopName : null);
            if (shopUrl && !dropshipperShops.find(s => s.shopUrl === shopUrl)) {
              dropshipperShops.push({ shopName: shopName || 'Unknown', shopUrl });
            }
            send('log', `✅ Match confirmed — ${allResults.length} total (${dropshipperShops.length} shops)`, pct);
          }
        } catch (err) {
          console.error('Erreur listing:', err.message);
          done++;
          send('log', `⚠️ Error on listing ${done}/${total}`, 35 + Math.round((done / total) * 60));
        }
      }
    );

    send('log', `📊 Analysis complete — ${allResults.length} matches found`, 97);

    const seen = new Set();
    const deduped = allResults
      .sort((a, b) => b.similarity - a.similarity)
      .filter(r => {
        const k = r.aliexpress.link || '';
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

    // Enrichir les résultats finaux (instantané)
    deduped.forEach(result => {
      if (!result.etsy.shopUrl && result.etsy.shopName) {
        result.etsy.shopUrl = 'https://www.etsy.com/shop/' + result.etsy.shopName;
      }
    });

    sendComplete(deduped, dropshipperShops);

  } catch (err) {
    sendError(err.message || 'Erreur inattendue');
  }
});

// ── DEBUG ETSY HTML ──
router.get('/debug-etsy', async (req, res) => {
  const keyword = req.query.q || 'neon sign';
  try {
    const info = await debugEtsyHtml(keyword);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SHOP STATS ──
router.post('/shop-stats', async (req, res) => {
  const { results } = req.body;
  if (!results?.length) return res.status(400).json({ error: 'No results provided' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');

  try {
    // Deduplicate shops
    const shops = [...new Map(
      results.map(r => [r.etsy.shopUrl || r.etsy.shopName, {
        shopUrl:     r.etsy.shopUrl,
        shopName:    r.etsy.shopName,
        listingUrl:  r.etsy.link,
        // Pass listing HTML if available to avoid extra ScrapingBee call
        listingHtml: r.etsy.listingHtml || null,
      }])
    ).values()].filter(s => s.shopUrl);

    send({ step: 'start', total: shops.length, message: `Analyse de ${shops.length} boutique(s)...` });

    // ── PARALLÉLISATION (max 3 en simultané) ──
    const statsArr = new Array(shops.length);

    await parallel(shops, 8, async (shop, i) => {
      send({ step: 'scraping', index: i, shopName: shop.shopName, message: `Scraping ${shop.shopName}...` });

      const stats      = await scrapeShopStats(shop.shopUrl, shop.listingHtml);
      stats.shopName   = shop.shopName;
      stats.shopUrl    = shop.shopUrl;
      stats.listingUrl = shop.listingUrl;
      stats.score      = computeScore(stats);
      statsArr[i]      = stats;

      send({
        step:     'done',
        index:    i,
        shopName: shop.shopName,
        stats: {
          sales:     stats.sales,
          createdAt: stats.createdAt,
          score:     stats.score,
        },
      });
    });

    const withScore = statsArr.filter(s => s?.score > 0);
    withScore.sort((a, b) => b.score - a.score);
    const winner = withScore[0] || statsArr[0];

    console.log('WINNER:', JSON.stringify({
      shopName:  winner?.shopName,
      sales:     winner?.sales,
      createdAt: winner?.createdAt,
      score:     winner?.score,
    }));

    send({
      step: 'complete',
      winner,
      all: statsArr.filter(Boolean).map(s => ({
        shopName:  s.shopName,
        shopUrl:   s.shopUrl,
        sales:     s.sales,
        createdAt: s.createdAt,
        score:     s.score,
      })),
    });
    res.end();

  } catch (err) {
    send({ step: 'error', message: err.message });
    res.end();
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

module.exports = router;




