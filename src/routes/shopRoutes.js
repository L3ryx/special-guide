const express      = require('express');
const router       = express.Router();
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const AutoSearchState = require('../models/autoSearchModel');
const PendingSession  = require('../models/pendingSessionModel');

// Les sessions 2FA sont désormais persistées en MongoDB (résistant aux redémarrages serveur)

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl } = req.body;

  if (!shopName && shopUrl) {
    const m = shopUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
    if (m) shopName = m[1];
  }
  if (!shopName && productUrl) {
    const m = productUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
    if (m) shopName = m[1];
  }

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

// ── UPDATE keyword queue ──
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
  const LEONARDO_KEY = process.env.LEONARDO_API_KEY;
  const IMGBB_KEY    = process.env.IMGBB_API_KEY;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send  = (d) => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch(e){} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getSbKey() {
    if (process.env.SCRAPINGBEE_KEY) return process.env.SCRAPINGBEE_KEY;
    for (let i = 2; i <= 10; i++) { const k = process.env['SCRAPINGBEE_KEY_' + i]; if (k) return k; }
    return null;
  }

  async function sbFetch(url) {
    const key = getSbKey();
    if (!key) throw new Error('No ScrapingBee key');
    const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
      params: { api_key: key, url, country_code: 'us', timeout: '45000', stealth_proxy: 'true' },
      timeout: 120000
    });
    return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  }

  async function modifyImageWithLeonardo(b64Image, background, angle) {
    const uploadRes = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/init-image',
      { extension: 'jpg' },
      { headers: { Authorization: 'Bearer ' + LEONARDO_KEY, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    const { url: uploadUrl, fields: uploadFields, id: initImageId } = uploadRes.data.uploadInitImage;

    const FormDataLib = require('form-data');
    const fields = typeof uploadFields === 'string' ? JSON.parse(uploadFields) : uploadFields;
    const s3Form = new FormDataLib();
    Object.entries(fields).forEach(([k, v]) => s3Form.append(k, v));
    s3Form.append('file', Buffer.from(b64Image, 'base64'), { filename: 'product.jpg', contentType: 'image/jpeg' });
    await axios.post(uploadUrl, s3Form, { headers: s3Form.getHeaders(), timeout: 30000 });

    const prompt = `Professional e-commerce product photo. Background: ${background}. Angle: ${angle}. Same product, same colors and details. Clean studio photography, white seamless.`;
    const genRes = await axios.post(
      'https://cloud.leonardo.ai/api/rest/v1/generations',
      { prompt, modelId: '6bef9f1b-29cb-40c7-b9df-32b51c1f67d3', width: 1024, height: 1024, num_images: 1, guidance_scale: 7, init_image_id: initImageId, init_strength: 0.35 },
      { headers: { Authorization: 'Bearer ' + LEONARDO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
    );

    if (!genRes.data?.sdGenerationJob) throw new Error('Leonardo gen response unexpected: ' + JSON.stringify(genRes.data));
    const generationId = genRes.data.sdGenerationJob.generationId;

    for (let waited = 0; waited < 120; waited += 4) {
      await sleep(4000);
      const pollRes = await axios.get(`https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`, { headers: { Authorization: 'Bearer ' + LEONARDO_KEY }, timeout: 15000 });
      const gen = pollRes.data.generations_by_pk;
      if (gen?.status === 'COMPLETE') {
        const imageUrl = gen.generated_images?.[0]?.url;
        if (!imageUrl) throw new Error('Leonardo returned no image URL');
        const imgBuf = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
        return Buffer.from(imgBuf.data).toString('base64');
      }
      if (gen?.status === 'FAILED') throw new Error('Leonardo generation failed');
    }
    throw new Error('Leonardo generation timed out');
  }

  try {
    send({ step: 'scraping', message: '🔍 Scraping shop page...' });
    const shopHtml = await sbFetch('https://www.etsy.com/shop/' + shopName);

    const listingMatches = [];
    const listingRegex = /listing\/([0-9]+)\/([^"? ]+)/g;
    const seen = new Set();
    let lm;
    while ((lm = listingRegex.exec(shopHtml)) !== null) {
      if (!seen.has(lm[1])) { seen.add(lm[1]); listingMatches.push({ id: lm[1], slug: lm[2] }); }
      if (listingMatches.length >= 20) break;
    }

    if (!listingMatches.length) { send({ step: 'error', message: '❌ No listings found in this shop' }); res.end(); return; }
    send({ step: 'found', message: `✅ Found ${listingMatches.length} listings, searching for AliExpress match...` });

    const SERPER_KEY = process.env.SERPER_API_KEY;
    let foundListing = null, foundImgs = [], foundTitle = '';

    for (let li = 0; li < listingMatches.length; li++) {
      const listing = listingMatches[li];
      send({ step: 'checking', message: `🔎 Checking listing ${li+1}/${listingMatches.length}...` });
      try {
        const listingHtml = await sbFetch(`https://www.etsy.com/listing/${listing.id}/${listing.slug}`);
        const titleMatch  = listingHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        const rawTitle    = titleMatch ? titleMatch[1].replace(' | Etsy', '').trim() : listing.slug.replace(/-/g, ' ');

        const imgSet = new Set();
        const imgRe  = /https:\/\/i\.etsystatic\.com\/[^"' ]+\.jpg/g;
        let imgMatch;
        while ((imgMatch = imgRe.exec(listingHtml)) !== null) imgSet.add(imgMatch[0]);
        const imgs = Array.from(imgSet).slice(0, 5);

        if (!imgs.length) { send({ step: 'skip', message: `⏭ No images in listing ${li+1}, skipping...` }); continue; }

        send({ step: 'lens', message: `🔎 Google Lens check on listing ${li+1}...` });
        let aliFound = false;
        try {
          const lensRes = await axios.post('https://google.serper.dev/lens', { url: imgs[0], gl: 'us', hl: 'en' }, { headers: { 'X-API-KEY': SERPER_KEY }, timeout: 20000 });
          const organic = lensRes.data?.organic || [];
          aliFound = organic.some(o => o.link && (o.link.includes('aliexpress') || o.link.includes('alibaba')));
        } catch(lensErr) {
          send({ step: 'skip', message: `⚠️ Lens error on listing ${li+1}, skipping...` }); continue;
        }

        if (!aliFound) { send({ step: 'skip', message: `⏭ Listing ${li+1} not on AliExpress, trying next...` }); continue; }

        send({ step: 'ali_match', message: `✅ AliExpress match on listing ${li+1}! (${rawTitle})` });
        foundListing = listing; foundImgs = imgs; foundTitle = rawTitle;
        break;
      } catch(e) {
        send({ step: 'skip', message: `⚠️ Error on listing ${li+1}: ${e.message}, skipping...` });
      }
    }

    if (!foundListing) { send({ step: 'error', message: '❌ No listing found on AliExpress in this shop' }); res.end(); return; }

    send({ step: 'images', message: `📸 Downloading ${foundImgs.length} image(s)...` });
    const rawImages = [];
    for (let ui = 0; ui < foundImgs.length; ui++) {
      try {
        const imgData = await axios.get(foundImgs[ui], { responseType: 'arraybuffer', timeout: 12000 });
        rawImages.push(Buffer.from(imgData.data).toString('base64'));
        send({ step: 'images', message: `📥 Image ${ui+1}/${foundImgs.length} downloaded` });
      } catch(e) { console.warn('Image download error:', e.message); }
    }

    if (!rawImages.length) { send({ step: 'error', message: '❌ Could not download any images' }); res.end(); return; }

    const angles      = ['front view', 'slight left angle', 'slight right angle', 'top-down view', '3/4 angle view'];
    const backgrounds = [
      'clean white marble surface with soft natural light and subtle shadows',
      'rustic wooden table, warm tones, soft bokeh background',
      'light grey minimalist studio, gradient background',
      'cozy lifestyle home setting, soft blurred interior',
      'pure white seamless background, professional studio lighting'
    ];

    const uploadedUrls = [];
    for (let ii = 0; ii < rawImages.length; ii++) {
      if (ii > 0) await sleep(10000);
      send({ step: 'imagen', message: `🎨 Modifying image ${ii+1}/${rawImages.length} with Leonardo AI...` });
      let attempts = 0, success = false;
      while (attempts < 3 && !success) {
        try {
          const modifiedB64 = await modifyImageWithLeonardo(rawImages[ii], backgrounds[ii % backgrounds.length], angles[ii % angles.length]);
          const form = new FormData();
          form.append('key', IMGBB_KEY);
          form.append('image', modifiedB64);
          const up = await axios.post('https://api.imgbb.com/1/upload', form, { headers: form.getHeaders(), timeout: 20000 });
          if (up.data?.data?.url) { uploadedUrls.push(up.data.data.url); send({ step: 'imagen', message: `✅ Image ${ii+1}/${rawImages.length} modified & uploaded` }); success = true; }
        } catch(imgErr) {
          attempts++;
          const httpStatus = imgErr.response?.status;
          const errBody    = imgErr.response?.data ? JSON.stringify(imgErr.response.data) : imgErr.message;
          console.warn(`Leonardo image error (attempt ${attempts}) [HTTP ${httpStatus}]:`, errBody);
          if (httpStatus === 429 && attempts < 3) { send({ step: 'imagen', message: '⏳ Rate limit, waiting 30s...' }); await sleep(30000); }
          else {
            try {
              const form2 = new FormData();
              form2.append('key', IMGBB_KEY);
              form2.append('image', rawImages[ii]);
              const up2 = await axios.post('https://api.imgbb.com/1/upload', form2, { headers: form2.getHeaders(), timeout: 15000 });
              if (up2.data?.data?.url) { uploadedUrls.push(up2.data.data.url); send({ step: 'imagen', message: `⚠️ Image ${ii+1} kept original (Leonardo error)` }); }
            } catch(e2) { console.warn('ImgBB fallback error:', e2.message); }
            break;
          }
        }
      }
    }

    send({ step: 'complete', message: `🎉 Done! ${uploadedUrls.length} image(s) generated`, title: foundTitle, images: uploadedUrls });
    res.end();
  } catch(e) {
    send({ step: 'error', message: '❌ ' + e.message });
    res.end();
  }
});

// ── ETSY SESSION STATUS ──
router.get('/etsy-session-status', requireAuth, async (req, res) => {
  try {
    const state = await AutoSearchState.findOne({ userId: req.user.id });
    res.json({ connected: !!(state && state.etsyToken) });
  } catch(e) {
    res.json({ connected: false });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// HELPER zenrowsRun
// ZenRows ne retourne PAS les cookies dans les headers set-cookie.
// On injecte un evaluate JS à la fin qui écrit document.cookie dans un
// élément DOM caché, puis on le parse depuis le HTML retourné.
// ──────────────────────────────────────────────────────────────────────────────
async function zenrowsRun(ZENROWS_KEY, url, jsInstructions) {
  const axios = require('axios');

  const instructionsWithDump = [
    ...jsInstructions,
    {
      evaluate: `
        (function() {
          try {
            var el = document.getElementById('__zr_cookies__');
            if (!el) { el = document.createElement('div'); el.id = '__zr_cookies__'; el.style.display='none'; document.body.appendChild(el); }
            el.textContent = document.cookie;
          } catch(e) {}
        })()
      `
    },
    { wait: 800 }
  ];

  const response = await axios.get('https://api.zenrows.com/v1/', {
    params: {
      apikey:          ZENROWS_KEY,
      url:             url,
      js_render:       'true',
      antibot:         'true',
      premium_proxy:   'true',
      proxy_country:   'us',
      js_instructions: JSON.stringify(instructionsWithDump)
    },
    timeout: 120000
  });

  const html = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

  // Extraire les cookies depuis l'élément DOM injecté
  const cookieMatch = html.match(/<div id="__zr_cookies__"[^>]*>([^<]*)<\/div>/);
  const cookies = cookieMatch ? cookieMatch[1].trim() : '';

  console.log(`ZenRows [${url}] — cookies extracted: ${cookies.length} chars | HTML: ${html.length} chars`);
  return { html, cookies };
}

// ── ETSY LOGIN via ZenRows ──
router.post('/etsy-zenrows-login', requireAuth, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const ZENROWS_KEY = process.env.ZENROWS_API_KEY;
    if (!ZENROWS_KEY) return res.status(500).json({ error: 'ZENROWS_API_KEY not configured' });

    console.log('ZenRows: submitting Etsy login form...');

    const { html: resultHtml, cookies: allCookies } = await zenrowsRun(
      ZENROWS_KEY,
      'https://www.etsy.com/signin',
      [
        { wait_for: 'input[name="email"],#join_neu_email_field' },
        { fill:     ['input[name="email"],#join_neu_email_field', email] },
        { wait:     500 },
        { fill:     ['input[name="password"],#join_neu_password_field', password] },
        { wait:     500 },
        { click:    'button[type="submit"],#signin_button' },
        { wait:     8000 }
      ]
    );

    const needs2FA = resultHtml.includes('verification') || resultHtml.includes('verify')
      || resultHtml.includes('two-factor') || resultHtml.includes('phone_number_verification')
      || resultHtml.includes('one-time-code');

    const isLoggedIn = (
      resultHtml.includes('sign-out') || resultHtml.includes('logout')
      || resultHtml.includes('user_prefs') || resultHtml.includes('/signout')
    ) && !needs2FA;

    console.log('ZenRows login: isLoggedIn =', isLoggedIn, '| needs2FA =', needs2FA, '| cookies =', allCookies.length);

    if (isLoggedIn) {
      await AutoSearchState.findOneAndUpdate(
        { userId: req.user.id },
        { $set: { etsyToken: allCookies, etsyEmail: email, updatedAt: new Date() } },
        { upsert: true }
      );
      return res.json({ ok: true });
    }

    if (needs2FA) {
      const sessionId = require('crypto').randomBytes(16).toString('hex');
      await PendingSession.create({
        sessionId,
        userId:    req.user.id,
        email,
        password,
        cookies:   allCookies,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes
      });
      return res.json({ needs2FA: true, sessionId });
    }

    // Fallback : si on a des cookies, on accepte quand même
    if (allCookies.length > 30) {
      await AutoSearchState.findOneAndUpdate(
        { userId: req.user.id },
        { $set: { etsyToken: allCookies, etsyEmail: email, updatedAt: new Date() } },
        { upsert: true }
      );
      return res.json({ ok: true });
    }

    res.status(401).json({ error: 'Login failed — check your Etsy credentials.' });

  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.error('ZenRows Etsy login error:', detail);
    res.status(500).json({ error: detail });
  }
});

// ── ETSY 2FA via ZenRows ──
// Stratégie : on refait le login complet + saisie du code dans le MÊME appel ZenRows.
// C'est la seule approche fiable car ZenRows ne partage aucune session entre deux appels.
router.post('/etsy-zenrows-2fa', requireAuth, async (req, res) => {
  try {
    const { sessionId, code } = req.body;
    if (!sessionId || !code) return res.status(400).json({ error: 'sessionId and code required' });

    const session = await PendingSession.findOne({
      sessionId,
      expiresAt: { $gt: new Date() }
    });
    if (!session) return res.status(400).json({ error: 'Session expirée — veuillez vous reconnecter.' });
    if (session.userId.toString() !== req.user.id.toString()) return res.status(403).json({ error: 'Forbidden' });

    const ZENROWS_KEY = process.env.ZENROWS_API_KEY;
    if (!ZENROWS_KEY) return res.status(500).json({ error: 'ZENROWS_API_KEY not configured' });

    console.log('ZenRows 2FA: full login + code in single call...');

    const { html: resultHtml, cookies: newCookies } = await zenrowsRun(
      ZENROWS_KEY,
      'https://www.etsy.com/signin',
      [
        // Étape 1 : saisir email + password
        { wait_for: 'input[name="email"],#join_neu_email_field' },
        { fill:     ['input[name="email"],#join_neu_email_field', session.email] },
        { wait:     500 },
        { fill:     ['input[name="password"],#join_neu_password_field', session.password] },
        { wait:     500 },
        { click:    'button[type="submit"],#signin_button' },
        { wait:     8000 },
        // Étape 2 : attendre le champ 2FA et saisir le code
        { wait_for: 'input[name="code"],input[autocomplete="one-time-code"],input[type="tel"],input[name="otp"],input[type="number"]' },
        { fill: [
            'input[name="code"],input[autocomplete="one-time-code"],input[type="tel"],input[name="otp"],input[type="number"]',
            code
        ]},
        { wait:  500 },
        { click: 'button[type="submit"],input[type="submit"],button[data-action="verify"],button[data-testid="submit"]' },
        { wait:  8000 }
      ]
    );

    const mergedCookies = mergeCookies(session.cookies, newCookies);

    const isLoggedIn = (
      resultHtml.includes('sign-out') ||
      resultHtml.includes('logout') ||
      resultHtml.includes('user_prefs') ||
      resultHtml.includes('/signout')
    );

    const still2FA = resultHtml.includes('verification') || resultHtml.includes('verify')
      || resultHtml.includes('two-factor') || resultHtml.includes('phone_number_verification')
      || resultHtml.includes('one-time-code');

    console.log('ZenRows 2FA: isLoggedIn =', isLoggedIn, '| still2FA =', still2FA, '| mergedCookies =', mergedCookies.length);

    if (isLoggedIn && !still2FA) {
      await AutoSearchState.findOneAndUpdate(
        { userId: session.userId },
        { $set: { etsyToken: mergedCookies, etsyEmail: session.email, updatedAt: new Date() } },
        { upsert: true }
      );
      await PendingSession.deleteOne({ sessionId });
      return res.json({ ok: true });
    }

    if (still2FA) {
      return res.status(401).json({ error: 'Invalid or expired code — please try again.' });
    }

    // Fallback : si on a des cookies, on accepte
    if (mergedCookies.length > 30) {
      await AutoSearchState.findOneAndUpdate(
        { userId: session.userId },
        { $set: { etsyToken: mergedCookies, etsyEmail: session.email, updatedAt: new Date() } },
        { upsert: true }
      );
      await PendingSession.deleteOne({ sessionId });
      return res.json({ ok: true });

  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.error('ZenRows 2FA error:', detail);
    res.status(500).json({ error: detail });
  }
});

// ── Utilitaire : fusionner deux chaînes de cookies ──
function mergeCookies(older, newer) {
  const map = new Map();
  for (const str of [older, newer]) {
    if (!str) continue;
    for (const part of str.split(';')) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key) map.set(key, val);
    }
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

module.exports = router;

