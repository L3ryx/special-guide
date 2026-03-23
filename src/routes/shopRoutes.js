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

  const axios    = require('axios');
  const FormData = require('form-data');
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const IMGBB_KEY  = process.env.IMGBB_API_KEY;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch(e){} };

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

  // ── Modifier une image avec Gemini 2.0 Flash (vision → génération) ──
  async function modifyImageWithGemini(b64Image, background, angle) {
    var prompt = 'You are a professional product photographer. I will show you a product image. '
      + 'Generate a NEW product photo of the exact same product with: '
      + 'Background: ' + background + '. '
      + 'Angle: ' + angle + '. '
      + 'Keep the product identical (same shape, colors, text, details). '
      + 'Professional e-commerce photography, clean, high quality. '
      + 'Return ONLY the new image, no text.';

    var gemRes = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp-image-generation:generateContent?key=' + GEMINI_KEY,
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
      if (p.inline_data && p.inline_data.data) return p.inline_data.data; // base64
    }
    throw new Error('Gemini returned no image');
  }

  // ── Upload base64 vers ImgBB ──
  async function uploadToImgBB(b64) {
    var form = new FormData();
    form.append('key', IMGBB_KEY);
    form.append('image', b64);
    var up = await axios.post('https://api.imgbb.com/1/upload', form, { headers: form.getHeaders(), timeout: 20000 });
    if (up.data && up.data.data && up.data.data.url) return up.data.data.url;
    throw new Error('ImgBB upload failed');
  }

  try {
    // ── 1. Scraper la boutique pour trouver la première annonce ──
    send({ step: 'scraping', message: '🔍 Scraping shop...' });
    var shopHtml = await sbFetch('https://www.etsy.com/shop/' + shopName);

    var listingMatch = shopHtml.match(/listing\/([0-9]+)\/([^"? &#]+)/);
    if (!listingMatch) throw new Error('No listing found in shop');

    var firstListing = { id: listingMatch[1], slug: listingMatch[2] };
    send({ step: 'found', message: '✅ First listing found', total: 1 });

    // ── 2. Scraper la première annonce ──
    send({ step: 'listing', message: '📄 Loading listing...', index: 0 });
    var listingUrl = 'https://www.etsy.com/listing/' + firstListing.id + '/' + firstListing.slug;
    var listingHtml = await sbFetch(listingUrl);

    var titleMatch = listingHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
    var rawTitle = titleMatch ? titleMatch[1].replace(' | Etsy', '').trim() : firstListing.slug.replace(/-/g, ' ');

    // Extraire les images (dédupliquées, haute résolution)
    var imgSet = new Set();
    var imgRe = /https:\/\/i\.etsystatic\.com\/[^"' \s]+\.jpg/g;
    var imgM;
    while ((imgM = imgRe.exec(listingHtml)) !== null) {
      // Prendre la version haute résolution (retirer les paramètres de resize)
      var cleanUrl = imgM[0].split('?')[0];
      // Normaliser vers 1588x1588 ou conserver tel quel
      cleanUrl = cleanUrl.replace(/\/il\/[0-9]+x[0-9]+\//, '/il/1588x1588/');
      imgSet.add(cleanUrl);
    }
    var imgs = Array.from(imgSet).slice(0, 5);
    if (imgs.length === 0) throw new Error('No images found in listing');

    send({ step: 'images', message: '📸 Found ' + imgs.length + ' images, downloading...' });

    // ── 3. Télécharger les 5 premières images ──
    var rawImages = [];
    for (var ui = 0; ui < imgs.length; ui++) {
      try {
        var imgData = await axios.get(imgs[ui], { responseType: 'arraybuffer', timeout: 15000 });
        rawImages.push(Buffer.from(imgData.data).toString('base64'));
        send({ step: 'images', message: '📥 Image ' + (ui+1) + '/' + imgs.length + ' downloaded' });
      } catch(e) {
        console.warn('Image download error:', e.message);
      }
    }
    if (rawImages.length === 0) throw new Error('Failed to download images');

    // ── 4. Modifier chaque image avec Gemini 2.0 Flash ──
    send({ step: 'imagen', message: '🎨 Modifying images with Gemini...' });

    var angles = [
      'front view, centered',
      'slight left 3/4 angle',
      'slight right 3/4 angle',
      'top-down flat lay view',
      'close-up detail shot'
    ];
    var backgrounds = [
      'clean white marble surface with soft natural light and subtle shadows',
      'rustic wooden table, warm tones, soft bokeh background',
      'light grey minimalist studio, gradient background',
      'cozy lifestyle home setting, soft blurred interior',
      'pure white seamless background, professional studio lighting'
    ];

    var uploadedUrls = [];

    for (var ii = 0; ii < rawImages.length; ii++) {
      send({ step: 'imagen', message: '🎨 Processing image ' + (ii+1) + '/' + rawImages.length + '...' });
      try {
        var modifiedB64 = await modifyImageWithGemini(rawImages[ii], backgrounds[ii], angles[ii]);
        var hostedUrl = await uploadToImgBB(modifiedB64);
        uploadedUrls.push(hostedUrl);
        send({ step: 'imagen', message: '✅ Image ' + (ii+1) + '/' + rawImages.length + ' modified & uploaded' });
      } catch(imgErr) {
        console.warn('Gemini image error for image ' + (ii+1) + ':', imgErr.message);
        send({ step: 'imagen', message: '⚠️ Image ' + (ii+1) + ' failed: ' + imgErr.message });
        // Pas de fallback image originale — on skip simplement cette image
      }
    }

    if (uploadedUrls.length === 0) throw new Error('All image modifications failed');

    // ── 5. Générer le SEO avec Gemini ──
    send({ step: 'gemini', message: '✨ Generating SEO content...' });
    var seoPrompt = 'You are an Etsy SEO expert. Original title: "' + rawTitle + '". '
      + 'Generate optimized content. Respond ONLY with valid JSON, no markdown, no backticks: '
      + '{"title":"SEO title max 140 chars","description":"150-200 word English Etsy SEO description",'
      + '"tags":["t1","t2","t3","t4","t5","t6","t7","t8","t9","t10","t11","t12","t13"]}. '
      + 'Rules: exactly 13 tags, max 20 chars each, English only.';
    var gemSeoRes = await axios.post(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + GEMINI_KEY,
      { contents: [{ parts: [{ text: seoPrompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    var rawGem = ((gemSeoRes.data.candidates || [])[0] || {});
    var gemText = (rawGem.content && rawGem.content.parts && rawGem.content.parts[0] && rawGem.content.parts[0].text || '').replace(/```json|```/g, '').trim();
    var gemContent = JSON.parse(gemText);

    // ── 6. Envoyer les résultats au frontend ──
    send({
      step: 'published',
      message: '✅ ' + gemContent.title,
      index: 0,
      title: gemContent.title,
      description: gemContent.description,
      tags: gemContent.tags,
      images: uploadedUrls
    });

    send({ step: 'complete', message: '🎉 Done! ' + uploadedUrls.length + ' images modified' });
    res.end();
  } catch(e) {
    send({ step: 'error', message: '❌ ' + e.message });
    res.end();
  }
});













module.exports = router;


