const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const { uploadToImgBB } = require('../services/imgbbUploader');

// ── SAVE shop ──
// POST /api/shops/save
router.post('/save', requireAuth, async (req, res) => {
  const { shopName, shopUrl, shopAvatar } = req.body;
  if (!shopUrl) return res.status(400).json({ error: 'shopUrl requis' });
  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, shopUrl },
      { shopName, shopUrl, shopAvatar, savedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, shop });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── LIST shops ──
// GET /api/shops
router.get('/', requireAuth, async (req, res) => {
  const shops = await SavedShop.find({ userId: req.user.id }).sort({ savedAt: -1 });
  res.json(shops);
});

// ── DELETE shop ──
// DELETE /api/shops/:id
router.delete('/:id', requireAuth, async (req, res) => {
  await SavedShop.deleteOne({ _id: req.params.id, userId: req.user.id });
  res.json({ ok: true });
});

// ── FIND — analyse complète d'une boutique sauvegardée ──
// POST /api/shops/:id/find  (SSE)
router.post('/:id/find', requireAuth, async (req, res) => {
  const shop = await SavedShop.findOne({ _id: req.params.id, userId: req.user.id });
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');

  try {
    // 1. Scraper les listings de la boutique via ScrapingBee
    send({ step: 'scraping', message: '🔍 Récupération des listings...' });
    const listings = await scrapeShopListings(shop.shopUrl);
    if (!listings.length) {
      send({ step: 'error', message: 'Aucun listing trouvé dans cette boutique' });
      return res.end();
    }
    send({ step: 'scraping', message: `✅ ${listings.length} listings trouvés` });

    // 2. Reverse image search + filtre AliExpress pour chaque listing
    const results = [];
    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      send({ step: 'searching', index: i, total: listings.length, message: `🔎 ${i+1}/${listings.length} — ${listing.title?.slice(0,40) || ''}` });
      try {
        // Upload sur ImgBB
        const publicUrl = await uploadToImgBB(listing.image);
        // Serper Lens
        const lensRes = await axios.post('https://google.serper.dev/lens',
          { url: publicUrl, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );
        const all = [...(lensRes.data.visual_matches || []), ...(lensRes.data.organic || [])];
        const aliMatch = all.find(m => (m.link || m.url || '').includes('aliexpress.com/item/'));
        if (!aliMatch) continue;

        const aliUrl = cleanAliUrl(aliMatch.link || aliMatch.url);
        if (!aliUrl) continue;

        // Comparer avec Claude Vision
        const aliImgUrl = aliMatch.imageUrl || aliMatch.thumbnailUrl || null;
        let similarity  = 75; // fallback
        if (aliImgUrl) {
          try {
            similarity = await compareWithClaude(listing.image, aliImgUrl);
          } catch (e) {
            console.warn('Claude Vision indispo:', e.message);
          }
        }

        results.push({
          etsyTitle:  listing.title,
          etsyUrl:    listing.url,
          etsyImage:  listing.image,
          etsyPrice:  listing.price,
          aliUrl,
          aliImage:   aliImgUrl,
          similarity,
        });

        send({ step: 'match', result: results[results.length - 1], total: results.length });
      } catch (e) {
        console.warn(`Listing ${i} erreur:`, e.message);
      }
    }

    // 3. Sauvegarder les résultats dans MongoDB
    shop.lastFind = { runAt: new Date(), results };
    await shop.save();

    send({ step: 'complete', results, shopId: shop._id });
    res.end();

  } catch (err) {
    send({ step: 'error', message: err.message });
    res.end();
  }
});

// ── Helpers ──
function cleanAliUrl(raw) {
  if (!raw) return null;
  const m = raw.match(/\/item\/(\d{10,})/);
  return m ? `https://www.aliexpress.com/item/${m[1]}.html` : null;
}

async function scrapeShopListings(shopUrl) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  const reqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}`
    + `&url=${encodeURIComponent(shopUrl)}`
    + `&render_js=true&premium_proxy=true&country_code=us&wait=2000&timeout=45000`;

  const res  = await axios.get(reqUrl, { timeout: 120000 });
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);

  // Extraire les listings depuis le JSON embarqué ou le HTML
  const listings = [];

  // Pattern JSON __NEXT_DATA__ ou similaire
  // Chercher les objets listing : {listing_id, title, price, url, image}
  const listingPattern = /"listing_id"\s*:\s*(\d+)[^}]*?"title"\s*:\s*"([^"]+)"[^}]*?"price"[^}]*?"amount"\s*:\s*(\d+)[^}]*?"divisor"\s*:\s*(\d+)/g;
  let m;
  while ((m = listingPattern.exec(html)) !== null && listings.length < 30) {
    const id    = m[1];
    const title = m[2];
    const price = parseInt(m[3]) / parseInt(m[4]);
    const url   = `https://www.etsy.com/listing/${id}/${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
    listings.push({ id, title, price, url, image: null });
  }

  // Extraire les images (etsystatic.com)
  const imgMatches = [...html.matchAll(/https:\/\/i\.etsystatic\.com\/[^\s"']+(?:il|il_fullxfull)[^"'\s]*/g)];
  imgMatches.forEach((im, idx) => {
    if (listings[idx]) listings[idx].image = im[0].replace(/\/il\//, '/il_300x300.').replace(/\.(jpg|jpeg|png|webp).*$/, '.$1');
    else if (idx < 30) listings.push({ image: im[0], title: '', url: shopUrl, price: null });
  });

  // Si on n'a rien, parser le HTML directement
  if (listings.length === 0) {
    const hrefMatches = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"]+)"/g)];
    const seen = new Set();
    for (const hm of hrefMatches) {
      if (seen.has(hm[1]) || listings.length >= 30) break;
      seen.add(hm[1]);
      listings.push({ url: hm[1], title: hm[1].split('/').pop().replace(/-/g, ' '), image: null, price: null });
    }
  }

  return listings.filter(l => l.image || l.url);
}

async function compareWithClaude(etsyImgUrl, aliImgUrl) {
  const [etsyBuf, aliBuf] = await Promise.all([
    axios.get(etsyImgUrl, { responseType: 'arraybuffer', timeout: 15000 }),
    axios.get(aliImgUrl,  { responseType: 'arraybuffer', timeout: 15000 }),
  ]);
  const etsyB64 = Buffer.from(etsyBuf.data).toString('base64');
  const aliB64  = Buffer.from(aliBuf.data).toString('base64');
  const etsyMime = etsyBuf.headers['content-type'] || 'image/jpeg';
  const aliMime  = aliBuf.headers['content-type']  || 'image/jpeg';

  const claudeRes = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-opus-4-5',
    max_tokens: 10,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: etsyMime, data: etsyB64 } },
        { type: 'image', source: { type: 'base64', media_type: aliMime,  data: aliB64  } },
        { type: 'text',  text: 'Are these two product images showing the same or very similar product? Reply with ONLY a number from 0 to 100 representing similarity percentage.' }
      ]
    }]
  }, {
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    timeout: 30000
  });

  const txt = claudeRes.data.content?.[0]?.text?.trim() || '75';
  return Math.min(100, Math.max(0, parseInt(txt) || 75));
}

module.exports = router;
