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

module.exports = router;




