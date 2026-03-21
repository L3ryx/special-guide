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

        // ── Télécharger les 5 premières images ──
        send({ step: 'images', message: '📸 Downloading images...' });
        var rawImages = [];
        for (var ui = 0; ui < Math.min(imgs.length, 5); ui++) {
          try {
            var imgData = await axios.get(imgs[ui], { responseType: 'arraybuffer', timeout: 12000 });
            rawImages.push({
              b64: Buffer.from(imgData.data).toString('base64'),
              mimeType: 'image/jpeg'
            });
          } catch(e) { console.warn('Image download:', e.message); }
        }

        // ── Gemini Imagen — modifier chaque image (fond + angle différents) ──
        send({ step: 'imagen', message: '🎨 Modifying images with Gemini Imagen...' });
        var uploadedUrls = [];

        var angles = ['front view', 'slight left angle', 'slight right angle', 'top-down view', '3/4 angle view'];
        var backgrounds = [
          'a clean white marble surface with soft natural light',
          'a rustic wooden table with warm bokeh background',
          'a light grey minimalist studio background',
          'a cozy home setting with soft blurred background',
          'an outdoor natural setting with green plants blurred in background'
        ];

        for (var ii = 0; ii < rawImages.length; ii++) {
          try {
            var imagePrompt = 'Recreate this product image with a different background and angle. '
              + 'Keep the exact same product, colors, and details. '
              + 'Use this background: ' + backgrounds[ii % backgrounds.length] + '. '
              + 'Show the product from a ' + angles[ii % angles.length] + '. '
              + 'Professional product photography style, high quality, clean composition.';

            var imagenRes = await axios.post(
              'https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=' + GEMINI_KEY,
              {
                instances: [{ prompt: imagePrompt, referenceImages: [{ referenceType: 'REFERENCE_TYPE_RAW', referenceId: 1, referenceImage: { bytesBase64Encoded: rawImages[ii].b64 } }] }],
                parameters: { sampleCount: 1, aspectRatio: '1:1', safetyFilterLevel: 'BLOCK_SOME' }
              },
              { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
            );

            var generatedB64 = imagenRes.data && imagenRes.data.predictions && imagenRes.data.predictions[0] && imagenRes.data.predictions[0].bytesBase64Encoded;
            if (!generatedB64) throw new Error('No image generated');

            // Upload vers ImgBB
            var form = new FormData();
            form.append('key', IMGBB_KEY);
            form.append('image', generatedB64);
            var up = await axios.post('https://api.imgbb.com/1/upload', form, { headers: form.getHeaders(), timeout: 15000 });
            if (up.data && up.data.data && up.data.data.url) {
              uploadedUrls.push(up.data.data.url);
              send({ step: 'imagen', message: '🎨 Image ' + (ii+1) + '/' + rawImages.length + ' modified' });
            }
          } catch(imgErr) {
            console.warn('Imagen error:', imgErr.message);
            // Fallback : utiliser l'image originale
            try {
              var form2 = new FormData();
              form2.append('key', IMGBB_KEY);
              form2.append('image', rawImages[ii].b64);
              var up2 = await axios.post('https://api.imgbb.com/1/upload', form2, { headers: form2.getHeaders(), timeout: 15000 });
              if (up2.data && up2.data.data && up2.data.data.url) uploadedUrls.push(up2.data.data.url);
            } catch(e2) { console.warn('ImgBB fallback:', e2.message); }
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


// ── ETSY TOKEN GET ──
router.get('/etsy-token', requireAuth, async (req, res) => {
  try {
    const AutoSearchState = require('../models/autoSearchModel');
    const state = await AutoSearchState.findOne({ userId: req.user.id });
    res.json({ token: state && state.etsyToken ? state.etsyToken : null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ETSY OAUTH PKCE — Step 1 : générer l'URL d'autorisation ──
router.get('/etsy-oauth-url', requireAuth, async (req, res) => {
  try {
    const crypto = require('crypto');
    const clientId = process.env.ETSY_CLIENT_ID;
    if (!clientId) return res.status(500).json({ error: 'ETSY_CLIENT_ID missing' });

    // Générer code_verifier et code_challenge (PKCE)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');

    // Stocker le verifier en session (MongoDB)
    const AutoSearchState = require('../models/autoSearchModel');
    await AutoSearchState.findOneAndUpdate(
      { userId: req.user.id },
      { $set: { oauthVerifier: codeVerifier, oauthState: state, updatedAt: new Date() } },
      { upsert: true }
    );

    const redirectUri = process.env.ETSY_REDIRECT_URI || (req.protocol + '://' + req.get('host') + '/api/shops/etsy-callback');
    const scopes = 'listings_w listings_r shops_r';

    const url = 'https://www.etsy.com/oauth/connect' +
      '?response_type=code' +
      '&redirect_uri=' + encodeURIComponent(redirectUri) +
      '&scope=' + encodeURIComponent(scopes) +
      '&client_id=' + clientId +
      '&state=' + state +
      '&code_challenge=' + codeChallenge +
      '&code_challenge_method=S256';

    res.json({ url, state });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ETSY OAUTH PKCE — Step 2 : callback + échange du code ──
router.get('/etsy-callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const axios = require('axios');
    const AutoSearchState = require('../models/autoSearchModel');

    // Retrouver le verifier via le state
    const stateDoc = await AutoSearchState.findOne({ oauthState: state });
    if (!stateDoc) return res.status(400).send('Invalid state — please try again');

    const clientId = process.env.ETSY_CLIENT_ID;
    const redirectUri = process.env.ETSY_REDIRECT_URI || (req.protocol + '://' + req.get('host') + '/api/shops/etsy-callback');

    // Échanger le code contre un token
    const tokenRes = await axios.post('https://api.etsy.com/v3/public/oauth/token', {
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code: code,
      code_verifier: stateDoc.oauthVerifier,
    }, { headers: { 'Content-Type': 'application/json' } });

    const { access_token, refresh_token } = tokenRes.data;

    // Sauvegarder le token
    await AutoSearchState.findOneAndUpdate(
      { _id: stateDoc._id },
      { $set: { etsyToken: access_token, etsyRefreshToken: refresh_token, oauthVerifier: null, oauthState: null, updatedAt: new Date() } }
    );

    // Fermer la popup et notifier la fenêtre parent
    res.send('<html><body><script>if(window.opener){window.opener.postMessage({type:"etsy_oauth_success",token:"' + access_token + '"},"*");}window.close();</script><p>Connected! You can close this window.</p></body></html>');
  } catch(e) {
    console.error('Etsy callback error:', e.message);
    res.send('<html><body><script>if(window.opener){window.opener.postMessage({type:"etsy_oauth_error",error:"' + e.message.replace(/"/g, '') + '"},"*");}window.close();</script><p>Error: ' + e.message + '</p></body></html>');
  }
});





// ── Store temporaire des sessions Puppeteer en attente de 2FA ──
const _pendingSessions = new Map();

// ── ETSY LOGIN Step 1 : email + password ──
router.post('/etsy-login', requireAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const puppeteer = require('puppeteer-core');
    const blToken = process.env.BROWSERLESS_TOKEN;
    if (!blToken) return res.status(500).json({ error: 'BROWSERLESS_TOKEN not configured' });

    const browser = await puppeteer.connect({
      browserWSEndpoint: 'wss://chrome.browserless.io?token=' + blToken,
    });

    const page = await browser.newPage();
    // Headers pour ressembler à un vrai navigateur
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Aller sur la page signin et attendre que les inputs React se chargent
    await page.goto('https://www.etsy.com/signin', { waitUntil: 'networkidle0', timeout: 45000 });

    // Attendre qu'un input apparaisse (React peut prendre du temps)
    let emailSel = null;
    const emailSelectors = ['#email','input[name="email"]','input[type="email"]','input[autocomplete="email"]','input[autocomplete="username"]'];
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      for (const sel of emailSelectors) {
        try { const el = await page.$(sel); if (el) { emailSel = sel; break; } } catch(e) {}
      }
      if (emailSel) break;
    }

    const currentUrl = page.url();
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({ id: i.id, name: i.name, type: i.type, placeholder: i.placeholder }))
    );
    console.log('[Etsy] URL:', currentUrl, 'Inputs after wait:', JSON.stringify(inputs));

    if (!emailSel) {
      await browser.disconnect();
      return res.status(500).json({ error: 'Email field not found after 10s. URL: ' + currentUrl + ' Inputs: ' + JSON.stringify(inputs) });
    }

    await page.click(emailSel);
    await page.type(emailSel, email, { delay: 80 });

    // Trouver le champ password
    const passwordSelectors = ['#password','input[name="password"]','input[type="password"]'];
    let passSel = null;
    for (const sel of passwordSelectors) {
      try { const el = await page.$(sel); if (el) { passSel = sel; break; } } catch(e) {}
    }
    if (!passSel) { await browser.disconnect(); return res.status(500).json({ error: 'Password field not found' }); }
    await page.click(passSel);
    await page.type(passSel, password, { delay: 80 });

    const submitSelectors = ['#join_neu_submit_btn', 'button[type="submit"]', 'input[type="submit"]'];
    for (const sel of submitSelectors) {
      try { await page.click(sel); break; } catch(e) {}
    }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    const url = page.url();
    const content = await page.content();

    // Vérifier si 2FA demandé
    const needs2FA = content.includes('verification') || content.includes('verify') 
      || content.includes('code') || url.includes('verify') || url.includes('two-factor')
      || content.includes('phone') || content.includes('sms');

    // Vérifier si déjà connecté
    const isLoggedIn = (url.includes('/your/') || url.includes('account') 
      || content.includes('sign-out') || content.includes('user_prefs'))
      && !needs2FA;

    if (isLoggedIn) {
      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
      await browser.disconnect();
      const AutoSearchState = require('../models/autoSearchModel');
      await AutoSearchState.findOneAndUpdate(
        { userId: req.user.id },
        { $set: { etsyToken: cookieStr, etsyEmail: email, updatedAt: new Date() } },
        { upsert: true }
      );
      return res.json({ ok: true, token: cookieStr });
    }

    if (needs2FA) {
      // Stocker la session en attente
      const sessionId = require('crypto').randomBytes(16).toString('hex');
      _pendingSessions.set(sessionId, { browser, page, userId: req.user.id, email, createdAt: Date.now() });
      // Nettoyer après 5 minutes
      setTimeout(() => {
        const s = _pendingSessions.get(sessionId);
        if (s) { s.browser.disconnect().catch(()=>{}); _pendingSessions.delete(sessionId); }
      }, 5 * 60 * 1000);
      return res.json({ needs2FA: true, sessionId });
    }

    await browser.disconnect();
    res.status(401).json({ error: 'Login failed — check your credentials' });

  } catch(e) {
    console.error('Etsy login error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ETSY LOGIN Step 2 : soumettre le code 2FA ──
router.post('/etsy-2fa', requireAuth, async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    if (!sessionId || !code) return res.status(400).json({ error: 'sessionId and code required' });

    const session = _pendingSessions.get(sessionId);
    if (!session) return res.status(400).json({ error: 'Session expired — please login again' });

    const { browser, page, userId, email } = session;

    // Trouver le champ de code 2FA
    const codeSelectors = ['input[name="code"]', 'input[type="tel"]', 'input[autocomplete="one-time-code"]', 'input[name="otp"]', '#otp', 'input[maxlength="6"]'];
    let codeSel = null;
    for (const sel of codeSelectors) {
      try { await page.waitForSelector(sel, { timeout: 3000 }); codeSel = sel; break; } catch(e) {}
    }
    if (!codeSel) { 
      _pendingSessions.delete(sessionId);
      await browser.disconnect().catch(()=>{});
      return res.status(500).json({ error: '2FA field not found on page' }); 
    }

    await page.type(codeSel, code, { delay: 60 });

    // Soumettre le code
    const submitSelectors = ['button[type="submit"]', 'input[type="submit"]', '#submit-btn'];
    for (const sel of submitSelectors) {
      try { await page.click(sel); break; } catch(e) {}
    }
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    const url = page.url();
    const content = await page.content();
    const isLoggedIn = url.includes('/your/') || url.includes('account')
      || content.includes('sign-out') || content.includes('user_prefs');

    if (!isLoggedIn) {
      _pendingSessions.delete(sessionId);
      await browser.disconnect().catch(()=>{});
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    const cookies = await page.cookies();
    const cookieStr = cookies.map(c => c.name + '=' + c.value).join('; ');
    _pendingSessions.delete(sessionId);
    await browser.disconnect().catch(()=>{});

    const AutoSearchState = require('../models/autoSearchModel');
    await AutoSearchState.findOneAndUpdate(
      { userId: userId },
      { $set: { etsyToken: cookieStr, etsyEmail: email, updatedAt: new Date() } },
      { upsert: true }
    );

    res.json({ ok: true, token: cookieStr });
  } catch(e) {
    console.error('Etsy 2FA error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

