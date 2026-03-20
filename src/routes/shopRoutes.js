const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const AutoSearchState = require('../models/autoSearchModel');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl } = req.body;

  // Extraire shopName depuis différentes sources
  if (!shopName && shopUrl) {
    const m = shopUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
    if (m) shopName = m[1];
  }
  if (!shopName && productUrl) {
    const m = productUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
    if (m) shopName = m[1];
  }

  // Toujours reconstruire shopUrl proprement depuis shopName
  if (shopName) {
    shopUrl = 'https://www.etsy.com/shop/' + shopName;
  } else if (shopUrl) {
    shopUrl = shopUrl.replace(/\/$/, '');
  }

  if (!productUrl && shopUrl) productUrl = shopUrl;
  if (!productUrl) return res.status(400).json({ error: 'productUrl requis' });

  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, productUrl },
      { $set: { shopName: shopName || null, shopUrl: shopUrl || null, shopAvatar: shopAvatar || null, productImage: productImage || null, savedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, shop });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Already saved' });
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

// ── GET auto-search state ──
router.get('/auto-state', requireAuth, async (req, res) => {
  try {
    const state = await AutoSearchState.findOne({ userId: req.user.id });
    if (!state) return res.json({ keywordQueue: [], usedKeywords: [], usedShops: [] });
    res.json({
      keywordQueue: state.keywordQueue,
      usedKeywords: state.usedKeywords,
      usedShops:    state.usedShops,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SAVE auto-search state ──
router.post('/auto-state', requireAuth, async (req, res) => {
  try {
    const { keywordQueue, usedKeywords, usedShops } = req.body;
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { keywordQueue: keywordQueue || [], usedKeywords: usedKeywords || [], usedShops: usedShops || [], updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADD used shop ──
router.post('/auto-state/shop', requireAuth, async (req, res) => {
  try {
    const { shopName } = req.body;
    if (!shopName) return res.status(400).json({ error: 'shopName required' });
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $addToSet: { usedShops: shopName }, $set: { updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UPDATE keyword queue (après génération ou consommation) ──
router.post('/auto-state/queue', requireAuth, async (req, res) => {
  try {
    const { keywordQueue, usedKeyword } = req.body;
    const update = { $set: { updatedAt: new Date() } };
    if (keywordQueue !== undefined) update.$set.keywordQueue = keywordQueue;
    if (usedKeyword) update.$addToSet = { usedKeywords: usedKeyword };
    await AutoSearchState.findOneAndUpdate({ userId: req.user.id }, update, { upsert: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




// ── CLONE SHOP ──
router.post('/clone', requireAuth, async (req, res) => {
  const { shopName } = req.body;
  if (!shopName) return res.status(400).json({ error: 'shopName required' });

  const axios = require('axios');
  const FormData = require('form-data');
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const SERPER_KEY = process.env.SERPER_API_KEY;
  const IMGBB_KEY  = process.env.IMGBB_API_KEY;
  const ETSY_CID   = process.env.ETSY_CLIENT_ID;

  const AutoSearchState = require('../models/autoSearchModel');
  const state = await AutoSearchState.findOne({ userId: req.user.id });
  const etsyToken = state && state.etsyToken;
  if (!etsyToken) return res.status(401).json({ error: 'No Etsy token. Please login first.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = function(d) { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch(e){} };

  function getSbKey() {
    if (process.env.SCRAPINGBEE_KEY) return process.env.SCRAPINGBEE_KEY;
    for (var i = 2; i <= 10; i++) { var k = process.env['SCRAPINGBEE_KEY_' + i]; if (k) return k; }
    return null;
  }

  async function sbFetch(url) {
    var key = getSbKey();
    if (!key) throw new Error('No ScrapingBee key');
    var r = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: { api_key: key, url: url, country_code: 'us', timeout: '45000', stealth_proxy: 'true' },
      timeout: 120000
    });
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }

  try {
    send({ step: 'scraping', message: '🔍 Scraping shop listings...' });
    var shopHtml = await sbFetch('https://www.etsy.com/shop/' + shopName);

    var listingMatches = [];
    var listingRegex = /listing\/([0-9]+)\/([^"? ]+)/g;
    var seen = new Set();
    var lm;
    while ((lm = listingRegex.exec(shopHtml)) !== null) {
      if (!seen.has(lm[1])) { seen.add(lm[1]); listingMatches.push({ id: lm[1], slug: lm[2] }); }
      if (listingMatches.length >= 20) break;
    }

    send({ step: 'found', message: '✅ Found ' + listingMatches.length + ' listings', total: listingMatches.length });

    var shopId = null;
    try {
      var meRes = await axios.get('https://openapi.etsy.com/v3/application/users/me', {
        headers: { 'Authorization': 'Bearer ' + etsyToken, 'x-api-key': ETSY_CID }
      });
      shopId = meRes.data.shop_id;
    } catch(e) { send({ step: 'error', message: 'Etsy auth failed: ' + e.message }); res.end(); return; }

    for (var li = 0; li < listingMatches.length; li++) {
      var listing = listingMatches[li];
      send({ step: 'listing', message: 'Processing ' + (li+1) + '/' + listingMatches.length, index: li });
      try {
        var listingUrl = 'https://www.etsy.com/listing/' + listing.id + '/' + listing.slug;
        var listingHtml = await sbFetch(listingUrl);

        var titleMatch = listingHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        var rawTitle = titleMatch ? titleMatch[1].replace(' | Etsy', '').trim() : listing.slug.replace(/-/g, ' ');
        var priceM = listingHtml.match(/\$([0-9]+\.?[0-9]*)/);
        var price = priceM ? parseFloat(priceM[1]) : 25;

        var imgSet = new Set();
        var imgMatch;
        var imgRe = /https:\/\/i\.etsystatic\.com\/[^"' ]+\.jpg/g;
        while ((imgMatch = imgRe.exec(listingHtml)) !== null) imgSet.add(imgMatch[0]);
        var imgs = Array.from(imgSet).slice(0, 5);
        if (imgs.length === 0) { send({ step: 'skip', message: 'No images: ' + rawTitle }); continue; }

        // Google Lens
        send({ step: 'lens', message: '🔎 Checking AliExpress...' });
        var aliFound = false;
        try {
          var lensRes = await axios.post('https://google.serper.dev/lens',
            { url: imgs[0], gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': SERPER_KEY }, timeout: 20000 }
          );
          var organic = (lensRes.data && lensRes.data.organic) || [];
          for (var oi = 0; oi < organic.length; oi++) {
            if (organic[oi].link && (organic[oi].link.includes('aliexpress') || organic[oi].link.includes('alibaba'))) {
              aliFound = true; break;
            }
          }
        } catch(e) { console.warn('Lens:', e.message); }

        if (!aliFound) { send({ step: 'skip', message: 'Not on AliExpress: ' + rawTitle }); continue; }
        send({ step: 'ali_match', message: '✅ AliExpress confirmed!' });

        // Upload images ImgBB
        var uploadedUrls = [];
        for (var ui = 0; ui < imgs.length; ui++) {
          try {
            var imgData = await axios.get(imgs[ui], { responseType: 'arraybuffer', timeout: 10000 });
            var b64 = Buffer.from(imgData.data).toString('base64');
            var form = new FormData();
            form.append('key', IMGBB_KEY);
            form.append('image', b64);
            var up = await axios.post('https://api.imgbb.com/1/upload', form, { headers: form.getHeaders(), timeout: 15000 });
            if (up.data && up.data.data && up.data.data.url) uploadedUrls.push(up.data.data.url);
          } catch(e) { console.warn('ImgBB:', e.message); }
        }

        // Gemini SEO
        send({ step: 'gemini', message: '✨ Generating SEO content...' });
        var prompt = 'You are an Etsy SEO expert. Original title: "' + rawTitle + '". Generate optimized content. Respond ONLY with JSON: {"title":"SEO title max 140 chars","description":"150-200 word English Etsy SEO description","tags":["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10","t11","t12","t13"]}. Rules: exactly 13 tags, max 20 chars each, English only.';
        var gemRes = await axios.post(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + GEMINI_KEY,
          { contents: [{ parts: [{ text: prompt }] }] },
          { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        var rawGem = ((gemRes.data.candidates || [])[0] || {});
        var gemText = (rawGem.content && rawGem.content.parts && rawGem.content.parts[0] && rawGem.content.parts[0].text || '').replace(/```json|```/g, '').trim();
        var gemContent = JSON.parse(gemText);

        // Publier sur Etsy
        send({ step: 'publishing', message: '🚀 Publishing to Etsy...' });
        var listingRes = await axios.post(
          'https://openapi.etsy.com/v3/application/shops/' + shopId + '/listings',
          { quantity: 1, title: gemContent.title, description: gemContent.description, price: price, who_made: 'i_did', when_made: 'made_to_order', taxonomy_id: 1, tags: gemContent.tags.slice(0, 13), state: 'active' },
          { headers: { 'Authorization': 'Bearer ' + etsyToken, 'x-api-key': ETSY_CID, 'Content-Type': 'application/json' } }
        );
        var newListingId = listingRes.data.listing_id;

        // Upload images Etsy
        for (var ii = 0; ii < uploadedUrls.length; ii++) {
          try {
            var imgBuf = await axios.get(uploadedUrls[ii], { responseType: 'arraybuffer', timeout: 15000 });
            var formImg = new FormData();
            formImg.append('image', Buffer.from(imgBuf.data), { filename: 'img_' + ii + '.jpg', contentType: 'image/jpeg' });
            formImg.append('rank', ii + 1);
            await axios.post(
              'https://openapi.etsy.com/v3/application/shops/' + shopId + '/listings/' + newListingId + '/images',
              formImg,
              { headers: Object.assign({}, formImg.getHeaders(), { 'Authorization': 'Bearer ' + etsyToken, 'x-api-key': ETSY_CID }) }
            );
          } catch(e) { console.warn('Etsy img:', e.message); }
        }

        send({ step: 'published', message: '✅ Published: ' + gemContent.title, listingId: newListingId, index: li });

      } catch(e) { send({ step: 'error_listing', message: 'Error on listing ' + (li+1) + ': ' + e.message }); }
    }

    send({ step: 'complete', message: '🎉 All listings processed!' });
    res.end();
  } catch(e) { send({ step: 'error', message: '❌ ' + e.message }); res.end(); }
});

module.exports = router;

