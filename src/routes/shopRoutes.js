const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const { uploadToImgBB } = require('../services/imgbbUploader');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  const { productUrl, productImage, keyword } = req.body;
  if (!productUrl) return res.status(400).json({ error: 'productUrl requis' });
  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, productUrl },
      { $set: {
          productUrl,
          productImage: productImage || null,
          keyword:      keyword      || null,
          shopName:     null,
          shopUrl:      null,
          shopAvatar:   null,
          savedAt:      new Date(),
        },
        $setOnInsert: { userId: req.user.id }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, shop });
  } catch (err) {
    if (err.code === 11000) return res.json({ ok: true });
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

// ── FIND ──
router.post('/:id/find', requireAuth, async (req, res) => {
  const shop = await SavedShop.findOne({ _id: req.params.id, userId: req.user.id });
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');

  // API key check
  if (!process.env.SERPER_API_KEY) {
    send({ step: 'error', message: '❌ SERPER_API_KEY missing in Render environment' });
    return res.end();
  }

  try {
    send({ step: 'scraping', message: '🔍 Fetching listings...' });
    const listings = await scrapeShopListings(shop.shopUrl);
    if (!listings.length) {
      send({ step: 'error', message: 'No listings found for this shop' });
      return res.end();
    }
    send({ step: 'scraping', message: `✅ ${listings.length} listings found` });

    const results = [];
    for (let i = 0; i < listings.length; i++) {
      const listing = listings[i];
      if (!listing.image) continue;
      send({ step: 'searching', index: i, total: listings.length, message: `🔎 ${i+1}/${listings.length} — ${listing.title?.slice(0,40) || ''}` });
      try {
        // Upload sur ImgBB pour URL publique (Serper a besoin d'une URL accessible)
        const publicUrl = await uploadToImgBB(listing.image);
        if (!publicUrl || !publicUrl.startsWith('http')) {
          console.warn(`Listing ${i}: ImgBB upload failed, skipping`);
          continue;
        }

        // Appel Serper Lens
        let lensRes;
        try {
          lensRes = await axios.post('https://google.serper.dev/lens',
            { url: publicUrl, gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
          );
        } catch (serperErr) {
          const status = serperErr.response?.status;
          if (status === 401) {
            send({ step: 'error', message: '❌ Serper API key invalid (401) — check SERPER_API_KEY in Render' });
            return res.end();
          }
          console.warn(`Listing ${i} Serper error ${status}:`, serperErr.message);
          continue; // skip ce listing, continue les autres
        }

        const all = [...(lensRes.data.visual_matches || []), ...(lensRes.data.organic || [])];
        const aliMatch = all.find(m => (m.link || m.url || '').includes('aliexpress.com/item/'));
        if (!aliMatch) continue;

        const aliUrl = cleanAliUrl(aliMatch.link || aliMatch.url);
        if (!aliUrl) continue;

        const aliImgUrl = aliMatch.imageUrl || aliMatch.thumbnailUrl || null;
        let similarity = 75;
        if (aliImgUrl) {
          try { similarity = await compareWithClaude(listing.image, aliImgUrl); }
          catch (e) { console.warn('Claude Vision unavailable:', e.message); }
        }

        results.push({
          etsyTitle: listing.title,
          etsyUrl:   listing.url,
          etsyImage: listing.image,
          etsyPrice: listing.price,
          aliUrl,
          aliImage:  aliImgUrl,
          similarity,
        });
        send({ step: 'match', result: results[results.length - 1], total: results.length });
      } catch (e) {
        console.warn(`Listing ${i} error:`, e.message);
        // Don't abort — continue other listings
      }
    }

    shop.lastFind = { runAt: new Date(), results };
    await shop.save();
    send({ step: 'complete', results, shopId: shop._id });
    res.end();
  } catch (err) {
    const msg = err.response
      ? `Erreur API ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : err.message;
    send({ step: 'error', message: msg });
    res.end();
  }
});

function cleanAliUrl(raw) {
  if (!raw) return null;
  const m = raw.match(/\/item\/(\d{10,})/);
  return m ? `https://www.aliexpress.com/item/${m[1]}.html` : null;
}

// ════════════════════════════════════════════════════════════════════════
// HELPER : Scraping avec ScrapingBee, fallback ScraperAPI
// ════════════════════════════════════════════════════════════════════════
async function scrapingbeeFetch(targetUrl, sbParams = {}) {
  // ── ScrapingBee ──
  const sbKey = process.env.SCRAPINGBEE_KEY;
  if (sbKey) {
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: sbKey, url: targetUrl, country_code: 'us', timeout: '45000', ...sbParams },
        timeout: 120000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) { console.log('ScrapingBee OK —', html.length, 'chars'); return html; }
    } catch (e) {
      console.warn('ScrapingBee failed (' + e.response?.status + ') — trying ScraperAPI:', e.message.slice(0, 80));
    }
  }
  // ── Fallback ScraperAPI ──
  const saKey = process.env.SCRAPEAPI_KEY;
  if (saKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await axios.get('http://api.scraperapi.com', {
          params: { api_key: saKey, url: targetUrl, render: 'true', country_code: 'us' },
          timeout: 90000,
        });
        const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        if (html.length > 500) { console.log('ScraperAPI OK —', html.length, 'chars'); return html; }
      } catch (e) {
        console.warn('ScraperAPI attempt', attempt, 'failed:', e.message.slice(0, 80));
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw new Error('All scrapers failed — check SCRAPINGBEE_KEY, SCRAPEAPI_KEY');
}

async function scrapeShopListings(shopUrl) {
  const parseHtml = (html) => {
    const listings = [], seen = new Set();
    const patterns = [
      /"listing_id"\s*:\s*(\d+)[^}]{0,300}"title"\s*:\s*"([^"]{5,150})"/g,
      /"listingId"\s*:\s*(\d+)[^}]{0,300}"title"\s*:\s*"([^"]{5,150})"/g,
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(html)) !== null && listings.length < 12) {
        const id = m[1], title = m[2].trim();
        if (!seen.has(id) && title.length > 3) {
          seen.add(id);
          listings.push({ id, title, url: 'https://www.etsy.com/listing/' + id, image: null });
        }
      }
      if (listings.length >= 5) break;
    }
    return listings;
  };

  // ScrapingBee avec JS rendering — nécessaire pour charger React Etsy
  const sbKey = process.env.SCRAPINGBEE_KEY;
  if (sbKey) {
    try {
      console.log('ScrapingBee shop fetch:', shopUrl);
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: sbKey, url: shopUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '3000', timeout: '45000' },
        timeout: 90000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      const listings = parseHtml(html);
      if (listings.length > 0) { console.log('ScrapingBee shop OK —', listings.length, 'listings'); return listings; }
    } catch (e) {
      console.warn('ScrapingBee shop failed (' + e.response?.status + '):', e.message.slice(0, 80));
    }
  }

  // Fallback ScraperAPI render=true
  const saKey = process.env.SCRAPEAPI_KEY;
  if (saKey) {
    try {
      console.log('ScraperAPI shop fetch:', shopUrl);
      const r = await axios.get('http://api.scraperapi.com', {
        params: { api_key: saKey, url: shopUrl, render: 'true', country_code: 'us' },
        timeout: 90000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      const listings = parseHtml(html);
      if (listings.length > 0) { console.log('ScraperAPI shop OK —', listings.length, 'listings'); return listings; }
    } catch (e) {
      console.warn('ScraperAPI shop failed:', e.message.slice(0, 80));
    }
  }

  return [];
}

// Appel Gemini avec retry exponentiel pour absorber les 429
async function callGeminiWithRetry(payload, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      return res;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        // Backoff exponentiel : 5s, 10s, 20s, 40s
        const wait = 5000 * Math.pow(2, attempt);
        console.warn(`Gemini 429 — attente ${wait / 1000}s avant retry ${attempt + 1}/${maxRetries}`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err; // Autre erreur -> propager
    }
  }
  throw new Error('Gemini 429 — max retries atteint');
}

async function compareWithClaude(etsyImgUrl, aliImgUrl) {
  const [etsyBuf, aliBuf] = await Promise.all([
    axios.get(etsyImgUrl, { responseType: 'arraybuffer', timeout: 15000 }),
    axios.get(aliImgUrl,  { responseType: 'arraybuffer', timeout: 15000 }),
  ]);
  const etsyB64  = Buffer.from(etsyBuf.data).toString('base64');
  const aliB64   = Buffer.from(aliBuf.data).toString('base64');
  const etsyMime = etsyBuf.headers['content-type'] || 'image/jpeg';
  const aliMime  = aliBuf.headers['content-type']  || 'image/jpeg';

  const geminiVisionRes = await callGeminiWithRetry({
    contents: [{
      parts: [
        { inline_data: { mime_type: etsyMime, data: etsyB64 } },
        { inline_data: { mime_type: aliMime,  data: aliB64  } },
        { text: 'Are these two product images showing the same or very similar product? Reply with ONLY a number from 0 to 100 representing similarity percentage.' }
      ]
    }]
  });

  const txt = geminiVisionRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '75';
  return Math.min(100, Math.max(0, parseInt(txt) || 75));
}

module.exports = router;

// ── COMPETITION ──
router.post('/:id/competition', requireAuth, async (req, res) => {
  const shop = await SavedShop.findOne({ _id: req.params.id, userId: req.user.id });
  if (!shop) return res.status(404).json({ error: 'Shop not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');

  try {
    const apiKey = process.env.SCRAPINGBEE_KEY || process.env.SCRAPEAPI_KEY;
    if (!apiKey)                     { send({ step: 'error', message: '❌ SCRAPINGBEE_KEY or SCRAPEAPI_KEY missing' }); return res.end(); }
    if (!process.env.SERPER_API_KEY) { send({ step: 'error', message: '❌ SERPER_API_KEY missing' }); return res.end(); }
    if (!process.env.IMGBB_API_KEY)  { send({ step: 'error', message: '❌ IMGBB_API_KEY missing' });  return res.end(); }

    // ── STEP 1 : Déterminer le mot-clé ──────────────────────────────
    let keyword = '';
    if (shop.keyword && shop.keyword.trim().length > 1) {
      keyword = shop.keyword.trim().toLowerCase();
    } else if (shop.productUrl) {
      const m = shop.productUrl.match(/\/listing\/\d+\/([^/?#]+)/);
      if (m) keyword = m[1].replace(/-/g, ' ').replace(/[^a-z0-9 ]/gi, ' ').trim().toLowerCase().split(/\s+/).slice(0, 4).join(' ');
    } else if (shop.shopName) {
      keyword = shop.shopName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().trim();
    }
    if (!keyword) { send({ step: 'error', message: '❌ Could not determine keyword' }); return res.end(); }

    send({ step: 'keyword', message: '🔑 Keyword: "' + keyword + '"', keyword });

    // ── STEP 2 : Scraper les listings Etsy ──────────────────────────
    send({ step: 'status', message: '🔍 Scraping Etsy for "' + keyword + '"...' });
    const listings = await scrapeEtsyListingsForCompetition(apiKey, keyword, (page, count) => {
      send({ step: 'scraping', message: '📄 Page ' + page + ' — ' + count + ' listings...' });
    });

    if (listings.length === 0) { send({ step: 'error', message: '❌ No listings found for this keyword' }); return res.end(); }

    // Boutiques uniques pour le calcul du taux
    const uniqueShopNames = new Set(listings.filter(l => l.shopName).map(l => l.shopName));
    const totalUniqueShops = uniqueShopNames.size || listings.length;
    send({ step: 'analyzing', totalShops: totalUniqueShops, message: '✅ ' + listings.length + ' listings (' + totalUniqueShops + ' unique shops). Analyzing...' });

    // ── STEP 3 : Comparaison image par image ──────────────────────────
    const { uploadToImgBB } = require('../services/imgbbUploader');

    let dropshippers = 0;
    let analyzed     = 0;
    const dropshipperShops    = [];
    const dropshipperNames    = new Set(); // dédoublonnage drop list
    const shopsAnalyzed       = new Set(); // 1 image par boutique max
    const imgbbCache          = new Map();

    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const r = await uploadToImgBB(url);
      imgbbCache.set(url, r);
      return r;
    }

    async function analyzeOne(listing) {
      // ── Skip si boutique déjà analysée (une image par boutique suffit)
      if (listing.shopName && shopsAnalyzed.has(listing.shopName)) {
        analyzed++;
        send({ step: 'analyzing', totalShops: totalUniqueShops, message: '🔎 ' + analyzed + '/' + listings.length + ' — ' + dropshippers + ' dropshippers' });
        return;
      }
      if (listing.shopName) shopsAnalyzed.add(listing.shopName);

      try {
        if (!listing.image) return;

        // 1. Upload image Etsy → URL publique pour Serper Lens
        let etsyPublicUrl;
        try { etsyPublicUrl = await uploadCached(listing.image); }
        catch (e) { console.warn('ImgBB upload failed:', e.message); return; }
        if (!etsyPublicUrl) return;

        // 2. Google Lens — chercher un produit AliExpress visuellement similaire
        await new Promise(r => setTimeout(r, 150));
        let aliResult = null;
        try {
          const lensRes = await axios.post(
            'https://google.serper.dev/lens',
            { url: etsyPublicUrl, gl: 'us', hl: 'en' },
            { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
          );
          const all = [...(lensRes.data.visual_matches || []), ...(lensRes.data.organic || [])];
          aliResult = all.find(r => {
            const u = r.link || r.url || '';
            return u.includes('aliexpress.com') && u.includes('/item/') && (r.imageUrl || r.thumbnailUrl);
          });
        } catch (e) {
          if (e.response?.status === 401) { send({ step: 'error', message: '❌ Serper key invalid' }); throw new Error('abort'); }
          console.warn('Lens error:', e.message); return;
        }

        if (!aliResult) { console.log('No AliExpress match for', listing.shopName); return; }

        const aliImageUrl = aliResult.imageUrl || aliResult.thumbnailUrl;
        const aliUrl      = aliResult.link || aliResult.url;

        // 3. Lens match AliExpress = dropshipping confirmé
        dropshippers++;
        if (listing.shopName && !dropshipperNames.has(listing.shopName)) {
          dropshipperNames.add(listing.shopName);
          dropshipperShops.push({
            shopName: listing.shopName,
            shopUrl:  'https://www.etsy.com/shop/' + listing.shopName,
          });
        }
        console.log('✅ Dropshipper confirmed —', listing.shopName, '(score ' + score + ')');
        send({ step: 'match', totalShops: totalUniqueShops, message: '🛒 ' + listing.shopName + ' (' + dropshippers + ' dropshippers)' });

      } catch (e) {
        if (e.message === 'abort') throw e;
        console.warn('analyzeOne error:', e.message);
      } finally {
        analyzed++;
        send({ step: 'analyzing', totalShops: totalUniqueShops, message: '🔎 ' + analyzed + '/' + listings.length + ' — ' + dropshippers + ' dropshippers' });
      }
    }

    // 2 workers en parallèle (Gemini a des rate limits)
    const queue = [...listings];
    async function worker() {
      while (queue.length > 0) {
        const listing = queue.shift();
        if (listing) await analyzeOne(listing);
      }
    }
    await Promise.all(Array.from({ length: 2 }, worker));

    // ── STEP 4 : Score et sauvegarde ────────────────────────────────
    const score = computeDropshipScore(dropshippers, totalUniqueShops);

    await SavedShop.findByIdAndUpdate(req.params.id, {
      $set: {
        'lastCompetition.runAt':            new Date(),
        'lastCompetition.keyword':          keyword,
        'lastCompetition.totalShops':       totalUniqueShops,
        'lastCompetition.dropshippers':     dropshippers,
        'lastCompetition.dropshipperShops': dropshipperShops,
        'lastCompetition.label':            score.label,
        'lastCompetition.color':            score.color,
        'lastCompetition.description':      score.description,
        'lastCompetition.saturation':       score.saturation,
      }
    }, { new: true });

    console.log('Competition done — shops:', totalUniqueShops, 'dropshippers:', dropshippers, 'saturation:', score.saturation + '%');
    send({ step: 'complete', keyword, totalShops: totalUniqueShops, dropshippers, dropshipperShops, score,
      label: score.label, color: score.color, description: score.description, saturation: score.saturation });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + (err.message || 'Unexpected error') });
    res.end();
  }
});

// Scrape Etsy search results — all listings, skip if shop already seen, max 400 total
async function scrapeEtsyListingsForCompetition(apiKey, keyword, onPage) {
  const MAX_LISTINGS = 150; // 150 suffisant statistiquement, 3x plus rapide
  const shopsSeen   = new Set(); // shops already analyzed
  const listings    = [];
  let page = 1;

  while (listings.length < MAX_LISTINGS) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
    let html = '';
    try {
      html = await scrapingbeeFetch(etsyUrl, {
        stealth_proxy: 'true',
        wait:          '3000',
      });
    } catch (e) {
      console.warn('Competition scrape page', page, '— scraping failed:', e.message);
      break;
    }

    const rawListings = parseSearchResultListings(html);

    let addedOnPage = 0;
    for (const l of rawListings) {
      if (listings.length >= MAX_LISTINGS) break;
      if (!l.image) continue;

      // Skip if this shop was already analyzed
      if (l.shopName && shopsSeen.has(l.shopName)) continue;

      // Mark shop as seen, add listing
      if (l.shopName) shopsSeen.add(l.shopName);
      listings.push({ shopName: l.shopName || null, image: l.image, link: l.link });
      addedOnPage++;
    }

    onPage(page, listings.length);

    // Stop si rien de nouveau sur cette page, pas de page suivante, ou limite atteinte
    const hasNext = html.includes('pagination-next') || html.includes(`page=${page + 1}`);
    if (!hasNext || listings.length >= MAX_LISTINGS) break;
    // Stop anticipé : 2 pages consécutives sans nouvelles boutiques
    if (addedOnPage === 0) break;
    page++;
    await new Promise(r => setTimeout(r, 400)); // réduit de 800ms
  }

  console.log('Competition: total listings to analyze:', listings.length);
  return listings;
}

// Extract listings from Etsy search result HTML (covers all 3 strategies)
function parseSearchResultListings(html) {
  const results = [];
  const seen = new Set();

  // Strategy 1: JSON-LD
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data  = JSON.parse(raw);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const url  = item.url || item['@id'];
        const img  = item.image?.[0] || item.image;
        const name = item.name;
        if (!url || !url.includes('/listing/') || !img || !name) continue;
        const cleanUrl = url.split('?')[0];
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);
        // Try all possible shopName fields in JSON-LD
        const shopName = item.seller?.name
          || item.brand?.name
          || item.offers?.seller?.name
          || item.manufacturer?.name
          || item.provider?.name
          || null;
        // Also try to extract shopName from the listing URL context in full HTML
        let resolvedShop = shopName;
        if (!resolvedShop) {
          const idx = html.indexOf(cleanUrl.split('/listing/')[1]?.split('/')[0] || '');
          if (idx > -1) {
            const ctx = html.slice(Math.max(0, idx - 2000), idx + 2000);
            const m = ctx.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/i)
                   || ctx.match(/"shopName"\s*:\s*"([^"]+)"/i);
            if (m) resolvedShop = m[1];
          }
        }
        const shopUrl = resolvedShop ? `https://www.etsy.com/shop/${resolvedShop}` : null;
        results.push({ title: name, link: cleanUrl, image: img, shopName: resolvedShop, shopUrl });
      }
    } catch {}
  }
  if (results.filter(r => r.shopName).length >= 2) return results;

  // Strategy 2: data-listing-id blocks
  const blocks = [...html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)];
  for (const block of blocks) {
    const b = block[1];
    const linkM = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgM  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    const shopM = b.match(/data-shop-name="([^"]+)"/i);
    if (linkM && imgM && shopM && !seen.has(linkM[1])) {
      seen.add(linkM[1]);
      const shopName = shopM[1];
      results.push({ link: linkM[1], image: imgM[1].split('?')[0], shopName, shopUrl: `https://www.etsy.com/shop/${shopName}` });
    }
  }
  if (results.length >= 2) return results;

  // Strategy 3: proximity (links + images near each other in HTML)
  const allLinks  = [...html.matchAll(/href="(https:\/\/www\.etsy\.com\/listing\/(\d+)\/[^"?#]+)/g)];
  const allImages = [...html.matchAll(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const linkPos   = allLinks.map(m  => ({ url: m[1].split('?')[0], pos: m.index }));
  const imgPos    = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const link of linkPos) {
    if (seen.has(link.url)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - link.pos);
      if (d < minDist && d < 5000) { minDist = d; closest = img; }
    }
    if (closest) {
      seen.add(link.url);
      // Extract shopName from nearby HTML — wider context window
      const ctx = html.slice(Math.max(0, link.pos - 2000), link.pos + 2000);
      const shopM = ctx.match(/data-shop-name="([^"]+)"/i)
                 || ctx.match(/href="https:\/\/www\.etsy\.com\/shop\/([A-Za-z0-9_-]+)"/i)
                 || ctx.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/i)
                 || ctx.match(/"shopName"\s*:\s*"([^"]+)"/i)
                 || ctx.match(/"shop_name"\s*:\s*"([^"]+)"/i);
      const shopName = shopM ? shopM[1] : null;
      results.push({ link: link.url, image: closest.url, shopName, shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null });
    }
  }

  return results;
}


function extractAboutText(html) {
  const patterns = [
    // Etsy JSON data embedded in page
    /"shop_description"\s*:\s*"([^"]{30,1500})"/i,
    /"shopDescription"\s*:\s*"([^"]{30,1500})"/i,
    /"description"\s*:\s*"([^"]{30,1500})"/i,
    /"about_text"\s*:\s*"([^"]{30,1500})"/i,
    /"about"\s*:\s*\{[^}]*"text"\s*:\s*"([^"]{30,1500})"/i,
    // HTML sections
    /<div[^>]*class="[^"]*shop-about[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]*id="about"[^>]*>([\s\S]*?)<\/section>/i,
    /<div[^>]*data-region="about"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="about"[^>]*>([\s\S]*?)<\/div>/i,
    // Meta fallback
    /<meta[^>]+name="description"[^>]+content="([^"]{30,500})"/i,
    /<meta[^>]+content="([^"]{30,500})"[^>]+name="description"/i,
  ];
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const text = m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\n/g, ' ').replace(/\"/g, '"')
        .replace(/\s+/g, ' ').trim();
      if (text.length > 30) return text;
    }
  }
  // Last resort: all paragraph text
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const combined = paras
    .map(p => p[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 30)
    .join(' ');
  return combined.slice(0, 1500);
}

function computeDropshipScore(dropshippers, totalShops) {
  const pct = totalShops > 0 ? Math.round((dropshippers / totalShops) * 100) : 0;
  const saturation = pct;

  if (pct <= 10) return { label: 'Very Low',  color: '#22c55e', description: 'Almost no dropshippers — excellent original niche!',          saturation };
  if (pct <= 25) return { label: 'Low',        color: '#86efac', description: 'Few dropshippers — good opportunity with differentiation.',   saturation };
  if (pct <= 45) return { label: 'Moderate',   color: '#fbbf24', description: 'Some dropshipping presence. Stand out with quality.',         saturation };
  if (pct <= 65) return { label: 'High',        color: '#f97316', description: 'Many dropshippers in this niche. Tough competition.',         saturation };
  return                { label: 'Very High',   color: '#ef4444', description: 'Niche heavily flooded with dropshippers. Very hard to win.',  saturation };
    }







