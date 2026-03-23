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
  // Token Etsy optionnel — pas de publication pour l'instant

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

    // Pas de publication Etsy — résultats envoyés au frontend

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

        // ── Télécharger les 5 premières images ──
        send({ step: 'images', message: '📸 Downloading images...' });
        var rawImages = [];
        for (var ui = 0; ui < Math.min(imgs.length, 5); ui++) {
          try {
            var imgData = await axios.get(imgs[ui], { responseType: 'arraybuffer', timeout: 12000 });
            rawImages.push(Buffer.from(imgData.data).toString('base64'));
          } catch(e) { console.warn('Image download:', e.message); }
        }

        // ── Gemini — modifier chaque image (fond + angle différents) ──
        send({ step: 'imagen', message: '🎨 Modifying images with Gemini...' });
        var uploadedUrls = [];
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        var angles = ['front view', 'slight left angle', 'slight right angle', 'top-down view', '3/4 angle view'];
        var backgrounds = [
          'clean white marble surface with soft natural light and subtle shadows',
          'rustic wooden table, warm tones, soft bokeh background',
          'light grey minimalist studio, gradient background',
          'cozy lifestyle home setting, soft blurred interior',
          'pure white seamless background, professional studio lighting'
        ];

        async function modifyImage(b64Image, background, angle) {
          var prompt = 'You are a professional product photographer. '
            + 'Generate a NEW product photo of the exact same product with: '
            + 'Background: ' + background + '. '
            + 'Angle: ' + angle + '. '
            + 'Keep the product identical (same shape, colors, text, details). '
            + 'Professional e-commerce photography, clean, high quality. '
            + 'Return ONLY the new image, no text.';

          var gemRes = await axios.post(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=' + GEMINI_KEY,
            {
              contents: [{
                parts: [
                  { inline_data: { mime_type: 'image/jpeg', data: b64Image } },
                  { text: prompt }
                ]
              }],
              generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
            },
            { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
          );

          var parts = (gemRes.data.candidates && gemRes.data.candidates[0] && gemRes.data.candidates[0].content && gemRes.data.candidates[0].content.parts) || [];
          for (var p of parts) {
            if (p.inline_data && p.inline_data.data) return p.inline_data.data;
          }
          throw new Error('Gemini returned no image');
        }

        for (var ii = 0; ii < rawImages.length; ii++) {
          if (ii > 0) await sleep(4000);
          send({ step: 'imagen', message: '🎨 Processing image ' + (ii+1) + '/' + rawImages.length + '...' });
          var attempts = 0;
          var success = false;
          while (attempts < 3 && !success) {
            try {
              var modifiedB64 = await modifyImage(rawImages[ii], backgrounds[ii % backgrounds.length], angles[ii % angles.length]);
              var form = new FormData();
              form.append('key', IMGBB_KEY);
              form.append('image', modifiedB64);
              var up = await axios.post('https://api.imgbb.com/1/upload', form, { headers: form.getHeaders(), timeout: 20000 });
              if (up.data && up.data.data && up.data.data.url) {
                uploadedUrls.push(up.data.data.url);
                send({ step: 'imagen', message: '✅ Image ' + (ii+1) + '/' + rawImages.length + ' modified & uploaded' });
                success = true;
              }
            } catch(imgErr) {
              attempts++;
              var status = imgErr.response && imgErr.response.status;
              console.warn('Gemini image error for image ' + (ii+1) + ' (attempt ' + attempts + '):', imgErr.message);
              if (status === 429 && attempts < 3) {
                send({ step: 'imagen', message: '⏳ Rate limit, waiting 15s...' });
                await sleep(15000);
              } else {
                // Fallback image originale
                try {
                  var form2 = new FormData();
                  form2.append('key', IMGBB_KEY);
                  form2.append('image', rawImages[ii]);
                  var up2 = await axios.post('https://api.imgbb.com/1/upload', form2, { headers: form2.getHeaders(), timeout: 15000 });
                  if (up2.data && up2.data.data && up2.data.data.url) uploadedUrls.push(up2.data.data.url);
                } catch(e2) { console.warn('ImgBB fallback:', e2.message); }
                break;
              }
            }
          }
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

        // Envoyer les résultats au frontend
        send({
          step: 'published',
          message: '✅ ' + gemContent.title,
          index: li,
          title: gemContent.title,
          description: gemContent.description,
          tags: gemContent.tags,
          images: uploadedUrls
        });

      } catch(e) { send({ step: 'error_listing', message: 'Error on listing ' + (li+1) + ': ' + e.message }); }
    }

    send({ step: 'complete', message: '🎉 All listings processed!' });
    res.end();
  } catch(e) { send({ step: 'error', message: '❌ ' + e.message }); res.end(); }
});


// ── ETSY TOKEN GET ──










module.exports = router;

// ── Store temporaire sessions 2FA ──
const _pendingSessions = new Map();

// ── ETSY LOGIN via Crawlbase ──
router.post('/etsy-login', requireAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const axios = require('axios');
    const crawlbaseToken = process.env.CRAWLBASE_TOKEN;
    if (!crawlbaseToken) return res.status(500).json({ error: 'CRAWLBASE_TOKEN not configured' });

    // Step 1 : charger la page de login
    const signinUrl = 'https://www.etsy.com/signin';
    const pageRes = await axios.get('https://api.crawlbase.com', {
      params: {
        token: crawlbaseToken,
        url: signinUrl,
        autoparse: 'false',
        ajax_wait: 'true',
        page_wait: '3000',
      },
      timeout: 120000,
    });

    const html = typeof pageRes.data === 'string' ? pageRes.data : JSON.stringify(pageRes.data);

    // Extraire le CSRF token
    const csrfMatch = html.match(/name="_nnc"\s+value="([^"]+)"/i)
      || html.match(/"csrf_nonce"\s*:\s*"([^"]+)"/i)
      || html.match(/name="csrf_token"\s+value="([^"]+)"/i);
    const csrf = csrfMatch ? csrfMatch[1] : '';

    // Step 2 : soumettre le formulaire
    const formData = 'email=' + encodeURIComponent(email)
      + '&password=' + encodeURIComponent(password)
      + '&_nnc=' + encodeURIComponent(csrf)
      + '&signin_submitted=1';

    const loginRes = await axios.get('https://api.crawlbase.com', {
      params: {
        token: crawlbaseToken,
        url: 'https://www.etsy.com/signin',
        autoparse: 'false',
        ajax_wait: 'true',
        page_wait: '4000',
        'post_data': formData,
        'post_content_type': 'application/x-www-form-urlencoded',
      },
      timeout: 120000,
    });

    const resultHtml = typeof loginRes.data === 'string' ? loginRes.data : JSON.stringify(loginRes.data);
    const resultUrl = loginRes.headers['original-status'] || '';

    const needs2FA = resultHtml.includes('verification') || resultHtml.includes('verify')
      || resultHtml.includes('phone') || resultHtml.includes('two-factor');

    const isLoggedIn = (resultHtml.includes('sign-out') || resultHtml.includes('user_prefs')
      || resultHtml.includes('logout')) && !needs2FA;

    if (isLoggedIn) {
      // Stocker les cookies retournés par Crawlbase
      const cookies = loginRes.headers['set-cookie']
        ? (Array.isArray(loginRes.headers['set-cookie'])
            ? loginRes.headers['set-cookie'].join('; ')
            : loginRes.headers['set-cookie'])
        : 'crawlbase_session';

      const AutoSearchState = require('../models/autoSearchModel');
      await AutoSearchState.findOneAndUpdate(
        { userId: req.user.id },
        { $set: { etsyToken: cookies, etsyEmail: email, updatedAt: new Date() } },
        { upsert: true }
      );
      return res.json({ ok: true, token: cookies });
    }

    if (needs2FA) {
      const sessionId = require('crypto').randomBytes(16).toString('hex');
      _pendingSessions.set(sessionId, { userId: req.user.id, email, html: resultHtml, createdAt: Date.now() });
      setTimeout(() => _pendingSessions.delete(sessionId), 5 * 60 * 1000);
      return res.json({ needs2FA: true, sessionId });
    }

    res.status(401).json({ error: 'Login failed — check your credentials' });
  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('Etsy login error:', detail);
    res.status(500).json({ error: detail });
  }
});

module.exports = router;

