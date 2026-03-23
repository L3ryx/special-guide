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
  const LEONARDO_KEY = process.env.LEONARDO_API_KEY;
  const IMGBB_KEY    = process.env.IMGBB_API_KEY;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = function(d) { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch(e){} };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  async function modifyImageWithLeonardo(b64Image, background, angle) {
    // ── Step 1: Upload the source image to Leonardo ──
    var uploadRes = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/init-image',
      { extension: 'jpg' },
      { headers: { Authorization: 'Bearer ' + LEONARDO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    var uploadData   = uploadRes.data.uploadInitImage;
    var uploadUrl    = uploadData.url;
    var uploadFields = uploadData.fields; // pre-signed S3 fields (JSON string or object)
    var initImageId  = uploadData.id;

    // Upload image bytes to the pre-signed S3 URL
    var FormDataLib = require('form-data');
    var fields = typeof uploadFields === 'string' ? JSON.parse(uploadFields) : uploadFields;
    var s3Form = new FormDataLib();
    Object.entries(fields).forEach(function([k, v]) { s3Form.append(k, v); });
    s3Form.append('file', Buffer.from(b64Image, 'base64'), { filename: 'product.jpg', contentType: 'image/jpeg' });
    await axios.post(uploadUrl, s3Form, { headers: s3Form.getHeaders(), timeout: 30000 });

    // ── Step 2: Generate with Image Guidance (Image-to-Image) ──
    var prompt = 'Professional e-commerce product photo of the exact same product. '
      + 'Background: ' + background + '. '
      + 'Angle: ' + angle + '. '
      + 'Keep the product identical (same shape, colors, text, details). '
      + 'Clean, high quality studio photography.';

    var genRes = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/generations',
      {
        prompt: prompt,
        modelId: '6bef9f1b-29cb-40c7-b9df-32b51c1f67d3', // Leonardo Diffusion XL
        width: 1024,
        height: 1024,
        num_images: 1,
        guidance_scale: 7,
        init_image_id: initImageId,
        init_strength: 0.45,
        presetStyle: 'PRODUCT_PHOTOGRAPHY'
      },
      { headers: { Authorization: 'Bearer ' + LEONARDO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    var generationId = genRes.data.sdGenerationJob.generationId;

    // ── Step 3: Poll until generation is COMPLETE ──
    var maxWait = 120; // seconds
    var waited  = 0;
    while (waited < maxWait) {
      await sleep(4000);
      waited += 4;
      var pollRes = await axios.get(
        'https://cloud.leonardo.ai/api/rest/v1/generations/' + generationId,
        { headers: { Authorization: 'Bearer ' + LEONARDO_KEY }, timeout: 15000 }
      );
      var gen = pollRes.data.generations_by_pk;
      if (gen && gen.status === 'COMPLETE') {
        var imageUrl = gen.generated_images && gen.generated_images[0] && gen.generated_images[0].url;
        if (!imageUrl) throw new Error('Leonardo returned no image URL');
        // Download the generated image and convert to base64
        var imgBuf = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
        return Buffer.from(imgBuf.data).toString('base64');
      }
      if (gen && gen.status === 'FAILED') throw new Error('Leonardo generation failed');
    }
    throw new Error('Leonardo generation timed out');
  }

  try {
    // ── Étape 1 : scraper la boutique pour récupérer toutes les annonces ──
    send({ step: 'scraping', message: '🔍 Scraping shop page...' });
    var shopHtml = await sbFetch('https://www.etsy.com/shop/' + shopName);

    var listingMatches = [];
    var listingRegex = /listing\/([0-9]+)\/([^"? ]+)/g;
    var seen = new Set();
    var lm;
    while ((lm = listingRegex.exec(shopHtml)) !== null) {
      if (!seen.has(lm[1])) { seen.add(lm[1]); listingMatches.push({ id: lm[1], slug: lm[2] }); }
      if (listingMatches.length >= 20) break;
    }

    if (listingMatches.length === 0) {
      send({ step: 'error', message: '❌ No listings found in this shop' });
      res.end(); return;
    }

    send({ step: 'found', message: '✅ Found ' + listingMatches.length + ' listings, searching for AliExpress match...' });

    const SERPER_KEY = process.env.SERPER_API_KEY;

    // ── Boucle sur les annonces jusqu'à trouver une correspondance AliExpress ──
    var foundListing = null;
    var foundImgs = [];
    var foundTitle = '';

    for (var li = 0; li < listingMatches.length; li++) {
      var listing = listingMatches[li];
      send({ step: 'checking', message: '🔎 Checking listing ' + (li+1) + '/' + listingMatches.length + '...' });

      try {
        var listingUrl = 'https://www.etsy.com/listing/' + listing.id + '/' + listing.slug;
        var listingHtml = await sbFetch(listingUrl);

        var titleMatch = listingHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        var rawTitle = titleMatch ? titleMatch[1].replace(' | Etsy', '').trim() : listing.slug.replace(/-/g, ' ');

        // Extraire les images de cette annonce
        var imgSet = new Set();
        var imgMatch;
        var imgRe = /https:\/\/i\.etsystatic\.com\/[^"' ]+\.jpg/g;
        while ((imgMatch = imgRe.exec(listingHtml)) !== null) imgSet.add(imgMatch[0]);
        var imgs = Array.from(imgSet).slice(0, 5);

        if (imgs.length === 0) {
          send({ step: 'skip', message: '⏭ No images in listing ' + (li+1) + ', skipping...' });
          continue;
        }

        // ── Google Lens : vérifier si le produit est sur AliExpress ──
        send({ step: 'lens', message: '🔎 Google Lens check on listing ' + (li+1) + '...' });
        var aliFound = false;
        try {
          var lensRes = await axios.post(
            'https://google.serper.dev/lens',
            { url: imgs[0], gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': SERPER_KEY }, timeout: 20000 }
          );
          var organic = (lensRes.data && lensRes.data.organic) || [];
          for (var oi = 0; oi < organic.length; oi++) {
            if (organic[oi].link && (organic[oi].link.includes('aliexpress') || organic[oi].link.includes('alibaba'))) {
              aliFound = true;
              break;
            }
          }
        } catch(lensErr) {
          console.warn('Google Lens error:', lensErr.message);
          send({ step: 'skip', message: '⚠️ Lens error on listing ' + (li+1) + ', skipping...' });
          continue;
        }

        if (!aliFound) {
          send({ step: 'skip', message: '⏭ Listing ' + (li+1) + ' not on AliExpress, trying next...' });
          continue;
        }

        // ✅ Trouvé sur AliExpress — on utilise cette annonce
        send({ step: 'ali_match', message: '✅ AliExpress match on listing ' + (li+1) + '! (' + rawTitle + ')' });
        foundListing = listing;
        foundImgs = imgs;
        foundTitle = rawTitle;
        break;

      } catch(e) {
        send({ step: 'skip', message: '⚠️ Error on listing ' + (li+1) + ': ' + e.message + ', skipping...' });
        continue;
      }
    }

    if (!foundListing) {
      send({ step: 'error', message: '❌ No listing found on AliExpress in this shop' });
      res.end(); return;
    }

    var imgs = foundImgs;
    var rawTitle = foundTitle;

    send({ step: 'images', message: '📸 Downloading ' + imgs.length + ' image(s)...' });

    // ── Télécharger les images en base64 ──
    var rawImages = [];
    for (var ui = 0; ui < imgs.length; ui++) {
      try {
        var imgData = await axios.get(imgs[ui], { responseType: 'arraybuffer', timeout: 12000 });
        rawImages.push(Buffer.from(imgData.data).toString('base64'));
        send({ step: 'images', message: '📥 Image ' + (ui+1) + '/' + imgs.length + ' downloaded' });
      } catch(e) { console.warn('Image download error:', e.message); }
    }

    if (rawImages.length === 0) {
      send({ step: 'error', message: '❌ Could not download any images' });
      res.end(); return;
    }

    // ── Modifier chaque image avec Gemini ──
    var angles = ['front view', 'slight left angle', 'slight right angle', 'top-down view', '3/4 angle view'];
    var backgrounds = [
      'clean white marble surface with soft natural light and subtle shadows',
      'rustic wooden table, warm tones, soft bokeh background',
      'light grey minimalist studio, gradient background',
      'cozy lifestyle home setting, soft blurred interior',
      'pure white seamless background, professional studio lighting'
    ];

    var uploadedUrls = [];

    for (var ii = 0; ii < rawImages.length; ii++) {
      if (ii > 0) await sleep(10000);
      send({ step: 'imagen', message: '🎨 Modifying image ' + (ii+1) + '/' + rawImages.length + ' with Leonardo AI...' });

      var attempts = 0;
      var success = false;
      while (attempts < 3 && !success) {
        try {
          var modifiedB64 = await modifyImageWithLeonardo(rawImages[ii], backgrounds[ii % backgrounds.length], angles[ii % angles.length]);
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
          console.warn('Leonardo image error (attempt ' + attempts + '):', imgErr.message);
          if (status === 429 && attempts < 3) {
            send({ step: 'imagen', message: '⏳ Rate limit, waiting 30s...' });
            await sleep(30000);
          } else {
            // Fallback : uploader l'image originale
            try {
              var form2 = new FormData();
              form2.append('key', IMGBB_KEY);
              form2.append('image', rawImages[ii]);
              var up2 = await axios.post('https://api.imgbb.com/1/upload', form2, { headers: form2.getHeaders(), timeout: 15000 });
              if (up2.data && up2.data.data && up2.data.data.url) {
                uploadedUrls.push(up2.data.data.url);
                send({ step: 'imagen', message: '⚠️ Image ' + (ii+1) + ' kept original (Leonardo error)' });
              }
            } catch(e2) { console.warn('ImgBB fallback error:', e2.message); }
            break;
          }
        }
      }
    }

    // ── Étape 6 : envoyer le résultat final ──
    send({
      step: 'complete',
      message: '🎉 Done! ' + uploadedUrls.length + ' image(s) generated',
      title: rawTitle,
      images: uploadedUrls
    });

    res.end();
  } catch(e) {
    send({ step: 'error', message: '❌ ' + e.message });
    res.end();
  }
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



