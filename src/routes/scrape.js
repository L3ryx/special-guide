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
const { scrapeShopStats, computeScore,
        extractStatsFromListingHtml }             = require('../services/shopStatsScraper');

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

// ── DEBUG KEYS ──
router.get('/debug', (req, res) => {
  const keys = ['SCRAPEAPI_KEY', 'SERPER_API_KEY', 'ANTHROPIC_API_KEY', 'IMGBB_API_KEY', 'SCRAPINGBEE_KEY'];
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

  const missing = ['SCRAPEAPI_KEY', 'SERPER_API_KEY', 'ANTHROPIC_API_KEY', 'IMGBB_API_KEY']
    .filter(k => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: 'Missing keys: ' + missing.join(', ') });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send         = (step, msg) => res.write('data: ' + JSON.stringify({ step, message: msg }) + '\n\n');
  const sendError    = msg => { res.write('data: ' + JSON.stringify({ step: 'error', message: msg }) + '\n\n'); res.end(); };
  const sendComplete = r   => { res.write('data: ' + JSON.stringify({ step: 'complete', results: r }) + '\n\n'); res.end(); };

  try {
    send('scraping_etsy', `🔍 Scraping Etsy for "${keyword}"...`);
    const listings = await scrapeEtsy(keyword, maxCount);
    if (!listings.length) return sendError('No Etsy listings found');
    send('etsy_done', `✅ ${listings.length} listings found`);

    send('reverse_search', `🏪 Fetching shop info...`);
    await parallel(listings, 5, async (listing) => {
      try {
        const shopInfo = await getShopInfo(listing);
        listing.shopName   = shopInfo.shopName   || listing.shopName;
        listing.shopUrl    = shopInfo.shopUrl    || listing.shopUrl;
        listing.shopAvatar = shopInfo.shopAvatar || null;
      } catch {}
    });

    send('reverse_search', `🔎 Analyzing ${listings.length} listings in parallel...`);

    let done = 0;
    const allResults = [];

    await parallel(
      listings.filter(l => l.image),
      5,
      async (listing) => {
        try {
          const matches = await reverseImageSearch(listing.image, listing.title || '');
          done++;
          send('comparing', `🤖 ${done}/${listings.length} analyzed`);
          if (!matches.length) return;
          const comparisons = await compareEtsyWithAliexpress(listing, matches);
          if (comparisons.length > 0) {
            allResults.push(...comparisons);
            send('match_found', `✅ ${allResults.length} correspondance(s)`);
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

    await parallel(deduped, 3, async (result) => {
      try {
        const shop = await getShopInfo(result.etsy);
        result.etsy.shopName   = shop.shopName   || result.etsy.shopName   || null;
        result.etsy.shopUrl    = shop.shopUrl    || result.etsy.shopUrl    || null;
        result.etsy.shopAvatar = shop.shopAvatar || null;
      } catch {}
    });

    sendComplete(deduped);

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

    await parallel(shops, 3, async (shop, i) => {
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
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
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
