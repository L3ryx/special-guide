const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const { uploadToImgBB } = require('../services/imgbbUploader');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  let { shopName, shopUrl, shopAvatar, productImage, productUrl } = req.body;
  if (!shopUrl) return res.status(400).json({ error: 'shopUrl requis' });
  if (shopUrl.includes('/listing/')) {
    const m = shopUrl.match(/etsy\.com\/shop\/([^/?#]+)/);
    shopUrl = m
      ? `https://www.etsy.com/shop/${m[1]}`
      : shopName
        ? `https://www.etsy.com/shop/${shopName}`
        : shopUrl.split('/listing/')[0].replace(/\/$/, '');
  } else {
    shopUrl = shopUrl.replace(/\/$/, '');
  }
  if (!shopName || shopName === 'Shop' || shopName === 'Boutique') {
    const m = shopUrl.match(/\/shop\/([^/?#]+)/);
    shopName = m ? m[1] : shopUrl.split('/').filter(Boolean).pop() || 'Shop';
  }
  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, shopUrl },
      { $set: { shopName, shopAvatar: shopAvatar || null, productImage: productImage || null, productUrl: productUrl || null, savedAt: new Date() }, $setOnInsert: { userId: req.user.id } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ ok: true, shop });
  } catch (err) {
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
  if (!shop) return res.status(404).json({ error: 'Boutique introuvable' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => res.write('data: ' + JSON.stringify(d) + '\n\n');

  // API key check
  if (!process.env.SERPER_API_KEY) {
    send({ step: 'error', message: '❌ SERPER_API_KEY manquante dans Render → Environment' });
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

async function scrapeShopListings(shopUrl) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  const reqUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}`
    + `&url=${encodeURIComponent(shopUrl)}`
    + `&render_js=true&premium_proxy=true&country_code=us&wait=2000&timeout=45000`;

  const res  = await axios.get(reqUrl, { timeout: 120000 });
  const html = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  const listings = [];

  const listingPattern = /"listing_id"\s*:\s*(\d+)[^}]*?"title"\s*:\s*"([^"]+)"[^}]*?"price"[^}]*?"amount"\s*:\s*(\d+)[^}]*?"divisor"\s*:\s*(\d+)/g;
  let m;
  while ((m = listingPattern.exec(html)) !== null && listings.length < 30) {
    const id    = m[1];
    const title = m[2];
    const price = parseInt(m[3]) / parseInt(m[4]);
    const url   = `https://www.etsy.com/listing/${id}/${title.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}`;
    listings.push({ id, title, price, url, image: null });
  }

  const imgMatches = [...html.matchAll(/https:\/\/i\.etsystatic\.com\/[^\s"']+(?:il|il_fullxfull)[^"'\s]*/g)];
  imgMatches.forEach((im, idx) => {
    if (listings[idx]) listings[idx].image = im[0];
    else if (idx < 30) listings.push({ image: im[0], title: '', url: shopUrl, price: null });
  });

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

  const geminiVisionRes = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{
        parts: [
          { inline_data: { mime_type: etsyMime, data: etsyB64 } },
          { inline_data: { mime_type: aliMime,  data: aliB64  } },
          { text: 'Are these two product images showing the same or very similar product? Reply with ONLY a number from 0 to 100 representing similarity percentage.' }
        ]
      }]
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

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
    const apiKey = process.env.SCRAPINGBEE_KEY;
    if (!apiKey) { send({ step: 'error', message: '❌ SCRAPINGBEE_KEY missing' }); return res.end(); }
    if (!process.env.GEMINI_API_KEY) { send({ step: 'error', message: '❌ GEMINI_API_KEY missing' }); return res.end(); }
    if (!process.env.SERPER_API_KEY) { send({ step: 'error', message: '❌ SERPER_API_KEY missing' }); return res.end(); }
    if (!process.env.IMGBB_API_KEY)  { send({ step: 'error', message: '❌ IMGBB_API_KEY missing' });  return res.end(); }

    // ── STEP 1 : Scrape shop About page → description ──
    send({ step: 'status', message: '🏪 Fetching shop About page...' });
    const aboutUrl = shop.shopUrl.replace(/\/?$/, '') + '/about';
    let aboutHtml = '';
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: apiKey, url: aboutUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '2500', timeout: '45000' },
        timeout: 120000,
      });
      aboutHtml = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } catch (e) {
      send({ step: 'error', message: '❌ Could not fetch About page: ' + e.message });
      return res.end();
    }

    const description = extractAboutText(aboutHtml);
    if (!description || description.length < 20) {
      send({ step: 'error', message: '❌ No shop description found on About page' });
      return res.end();
    }
    send({ step: 'status', message: '📝 Description found (' + description.length + ' chars). Analyzing with AI...' });

    // ── STEP 2 : Gemini → keyword ──
    let keyword = '';
    try {
      const aiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        { contents: [{ parts: [{ text: `Here is the "About" description of an Etsy shop:\n\n"${description.slice(0, 1200)}"\n\nWhat is the main product sold by this shop? Respond with ONLY a single short English keyword (1-3 words max) that best defines the niche of this shop. No explanation, no punctuation, just the keyword.` }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
      );
      keyword = (aiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      send({ step: 'error', message: '❌ Gemini failed (' + (e.response?.status || '') + '): ' + detail });
      return res.end();
    }

    if (!keyword) { send({ step: 'error', message: '❌ AI could not determine a keyword' }); return res.end(); }
    send({ step: 'keyword', message: '🔑 Keyword: "' + keyword + '"', keyword });

    // ── STEP 3 : Scrape Etsy listings (1 per unique shop) ──
    send({ step: 'status', message: '🔍 Scraping Etsy listings for "' + keyword + '"...' });

    const listings = await scrapeEtsyListingsForCompetition(apiKey, keyword, (page, count) => {
      send({ step: 'scraping', message: '📄 Page ' + page + ' — ' + count + ' unique shops found so far...' });
    });

    const totalShops = listings.length;
    if (totalShops === 0) {
      send({ step: 'error', message: '❌ No listings found on Etsy for this keyword' });
      return res.end();
    }
    send({ step: 'status', message: '✅ ' + totalShops + ' unique shops found. Starting reverse image search...' });

    // ── STEP 4 : Reverse image search for each listing ──
    const { uploadToImgBB } = require('../services/imgbbUploader');
    let dropshippers = 0;
    let analyzed = 0;

    for (const listing of listings) {
      analyzed++;
      send({ step: 'analyzing', message: '🔎 Analyzing ' + analyzed + '/' + totalShops + ' — ' + (listing.shopName || '...') });

      try {
        // Upload image to ImgBB
        const publicUrl = await uploadToImgBB(listing.image);

        // Serper Lens reverse image search
        const lensRes = await axios.post('https://google.serper.dev/lens',
          { url: publicUrl, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );

        const allMatches = [...(lensRes.data.visual_matches || []), ...(lensRes.data.organic || [])];
        const hasAli = allMatches.some(m => {
          const url = m.link || m.url || '';
          return url.includes('aliexpress.com') && url.includes('/item/');
        });

        if (hasAli) {
          dropshippers++;
          send({ step: 'match', message: '🛒 AliExpress match found for ' + (listing.shopName || 'shop') + ' (' + dropshippers + ' dropshippers so far)' });
        }
      } catch (e) {
        console.warn('Reverse image search failed for', listing.shopName, e.message);
      }

      // Small delay to avoid rate limits
      await new Promise(r => setTimeout(r, 300));
    }

    // ── STEP 5 : Compute score ──
    const score = computeDropshipScore(dropshippers, totalShops);

    send({
      step: 'complete',
      keyword,
      totalShops,
      dropshippers,
      score,
      label: score.label,
      color: score.color,
      description: score.description,
      saturation: score.saturation,
    });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + (err.message || 'Unexpected error') });
    res.end();
  }
});

// Scrape Etsy search results pages — 1 listing per unique shop (max 5 pages)
async function scrapeEtsyListingsForCompetition(apiKey, keyword, onPage) {
  const { scrapeEtsy } = require('../services/etsyScraper');
  const shopsSeen = new Set();
  const listings  = [];
  let page = 1;

  while (page <= 5) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
    let html = '';
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: apiKey, url: etsyUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '2000', block_ads: 'true', timeout: '45000' },
        timeout: 120000,
      });
      html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } catch (e) {
      console.warn('Competition scrape page', page, e.message);
      break;
    }

    // Parse listings from search result HTML
    const rawListings = parseSearchResultListings(html);
    let added = 0;

    for (const l of rawListings) {
      if (!l.image || !l.shopName) continue;
      if (shopsSeen.has(l.shopName)) continue; // skip already-seen shop
      shopsSeen.add(l.shopName);
      listings.push({ shopName: l.shopName, image: l.image, link: l.link });
      added++;
    }

    onPage(page, listings.length);

    // Stop if no new shops found or no next page
    const hasNext = html.includes('pagination-next') || html.includes(`page=${page + 1}`);
    if (!hasNext || added === 0) break;
    page++;
    await new Promise(r => setTimeout(r, 800));
  }

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
        const shopName = item.seller?.name || item.brand?.name || null;
        const shopUrl  = shopName ? `https://www.etsy.com/shop/${shopName}` : null;
        results.push({ title: name, link: cleanUrl, image: img, shopName, shopUrl });
      }
    } catch {}
  }
  if (results.length >= 2) return results;

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
      // Try to extract shopName from nearby HTML
      const ctx   = html.slice(Math.max(0, link.pos - 500), link.pos + 500);
      const shopM = ctx.match(/data-shop-name="([^"]+)"/i) || ctx.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/i);
      const shopName = shopM ? shopM[1] : null;
      results.push({ link: link.url, image: closest.url, shopName, shopUrl: shopName ? `https://www.etsy.com/shop/${shopName}` : null });
    }
  }

  return results;
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
