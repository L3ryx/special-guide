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
  shopUrl = shopUrl.split('/listing/')[0].replace(/\/$/, '');
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
    // ── STEP 1 : Scrape shop "About" page ──
    send({ step: 'status', message: '🏪 Fetching shop About page...' });

    const apiKey = process.env.SCRAPINGBEE_KEY;
    if (!apiKey) { send({ step: 'error', message: '❌ SCRAPINGBEE_KEY missing' }); return res.end(); }
    if (!process.env.GEMINI_API_KEY) { send({ step: 'error', message: '❌ GEMINI_API_KEY missing — add it in Render Environment Variables' }); return res.end(); }

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

    // Extract text from About section
    const description = extractAboutText(aboutHtml);
    if (!description || description.length < 20) {
      send({ step: 'error', message: '❌ No shop description found on About page' });
      return res.end();
    }
    send({ step: 'status', message: '📝 Description found (' + description.length + ' chars). Analyzing with AI...' });

    // ── STEP 2 : Ask Claude/GPT for keyword ──
    let keyword = '';
    try {
      const aiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          contents: [{
            parts: [{ text: `Here is the "About" description of an Etsy shop:\n\n"${description.slice(0, 1200)}"\n\nWhat is the main product sold by this shop? Respond with ONLY a single short English keyword (1-3 words max) that best defines the niche of this shop. No explanation, no punctuation, just the keyword.` }]
          }]
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 20000 }
      );
      keyword = (aiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      send({ step: 'error', message: '❌ Gemini analysis failed (' + (e.response?.status || '') + '): ' + detail });
      return res.end();
    }

    if (!keyword) { send({ step: 'error', message: '❌ AI could not determine a keyword' }); return res.end(); }
    send({ step: 'keyword', message: '🔑 Keyword identified: "' + keyword + '"', keyword });

    // ── STEP 3 : Scrape all Etsy shop names for this keyword ──
    send({ step: 'status', message: '🔍 Searching Etsy for "' + keyword + '"...' });

    const { scrapeEtsyShopNames } = require('../services/etsyScraper');
    let allShopNames = [];
    let pagesDone = 0;

    // We wrap scrapeEtsyShopNames to emit progress
    const etsyUrl = keyword;
    const scrapeResult = await scrapeEtsyAllShops(apiKey, etsyUrl, (page, count) => {
      pagesDone = page;
      send({ step: 'scraping', message: '📄 Page ' + page + ' scraped — ' + count + ' unique shops so far...' });
    }, keyword);
    allShopNames = scrapeResult.shops;

    send({ step: 'status', message: '✅ Scraping complete — ' + allShopNames.length + ' unique shops found' });

    // ── STEP 4 : Compute competition score ──
    const totalShops    = allShopNames.length;
    const totalListings = scrapeResult.totalListings;
    const similarTitles = scrapeResult.similarTitles;
    const score = computeCompetitionScore(totalShops, totalListings, similarTitles);

    send({
      step: 'complete',
      keyword,
      totalShops,
      totalListings,
      similarTitles,
      score,
      label: score.label,
      color: score.color,
      description: score.description,
      saturation: score.saturation,
      shopNames: allShopNames,
    });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + (err.message || 'Unexpected error') });
    res.end();
  }
});

// Scrape all pages of Etsy search and collect unique shop names, with progress callback
async function scrapeEtsyAllShops(apiKey, keyword, onPage, rawKeyword) {
  const allShops = new Set();
  let page = 1;
  let totalListings = 0;
  let similarTitles = 0;

  while (page <= 20) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
    let html = '';
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: apiKey, url: etsyUrl, render_js: 'true', premium_proxy: 'true', country_code: 'us', wait: '2000', block_ads: 'true', timeout: '45000' },
        timeout: 120000,
      });
      html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    } catch (e) {
      console.warn('scrapeEtsyAllShops page', page, e.message);
      break;
    }

    // On page 1 only: extract total listings count displayed by Etsy
    if (page === 1) {
      const listingMatch = html.match(/([0-9][0-9,]*)\s*results?/i) ||
                           html.match(/"totalResults"\s*:\s*(\d+)/) ||
                           html.match(/(\d[\d,]*)\s*résultats?/i);
      if (listingMatch) {
        totalListings = parseInt(listingMatch[1].replace(/,/g, ''), 10) || 0;
      }
    }

    // Count listing titles that contain the keyword words
    const kw = (rawKeyword || keyword).toLowerCase();
    const kwWords = kw.split(/\s+/).filter(w => w.length > 2);
    const titleMatches = [
      ...html.matchAll(/data-listing-title="([^"]+)"/gi),
      ...html.matchAll(/"title"\s*:\s*"([^"]{5,120})"/g),
      ...html.matchAll(/<h3[^>]*>\s*([^<]{5,120})\s*<\/h3>/gi),
    ];
    for (const m of titleMatches) {
      const title = m[1].toLowerCase();
      if (kwWords.some(w => title.includes(w))) similarTitles++;
    }

    // Extract shop names
    const shops = extractShopNamesFromHtml(html);
    if (shops.length === 0) break;

    shops.forEach(s => allShops.add(s));
    onPage(page, allShops.size);

    // Check for next page
    const hasNext = html.includes('pagination-next') ||
                    html.includes(`page=${page + 1}`) ||
                    shops.length >= 40;
    if (!hasNext) break;

    page++;
    await new Promise(r => setTimeout(r, 800));
  }

  return { shops: Array.from(allShops), totalListings, similarTitles };
}

function extractShopNamesFromHtml(html) {
  const shops = new Set();

  // JSON-LD seller names
  const jsonBlocks = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of jsonBlocks) {
    try {
      const data = JSON.parse(b[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const seller = item.seller?.name || item.brand?.name;
        if (seller) shops.add(seller);
      }
    } catch {}
  }

  // data-shop-name attributes
  const shopAttrs = [...html.matchAll(/data-shop-name="([^"]+)"/gi)];
  shopAttrs.forEach(m => shops.add(m[1]));

  // /shop/ URLs
  const shopUrls = [...html.matchAll(/etsy\.com\/shop\/([A-Za-z0-9_]+)/g)];
  shopUrls.forEach(m => shops.add(m[1]));

  return Array.from(shops).filter(s => s && s.length > 1);
}

function extractAboutText(html) {
  // Try to find the About section text
  const patterns = [
    // Common Etsy About section containers
    /<div[^>]*class="[^"]*shop-about[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<section[^>]*id="about"[^>]*>([\s\S]*?)<\/section>/i,
    /<div[^>]*data-region="about"[^>]*>([\s\S]*?)<\/div>/i,
    // JSON embedded description
    /"description"\s*:\s*"([^"]{30,1500})"/,
    /"about"\s*:\s*"([^"]{30,1500})"/,
    /"shopDescription"\s*:\s*"([^"]{30,1500})"/,
    // Meta description fallback
    /<meta[^>]+name="description"[^>]+content="([^"]{30,500})"/i,
    /<meta[^>]+content="([^"]{30,500})"[^>]+name="description"/i,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      // Strip HTML tags and decode entities
      let text = m[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\\n/g, ' ').replace(/\\"/g, '"')
        .replace(/\s+/g, ' ').trim();
      if (text.length > 30) return text;
    }
  }

  // Last resort: grab all paragraph text
  const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)];
  const combined = paras
    .map(p => p[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 30)
    .join(' ');
  return combined.slice(0, 1500);
}

function computeCompetitionScore(totalShops, totalListings, similarTitles) {
  // 4-metric weighted score (0–100)
  const shopScore    = Math.min(100, (totalShops    / 500)   * 100); // 30%
  const listingScore = Math.min(100, (totalListings / 50000) * 100); // 30%
  const ratioScore   = totalShops > 0
    ? Math.min(100, (totalListings / totalShops) / 2)                // 25%
    : 0;
  const similarScore = Math.min(100, (similarTitles / 200)   * 100); // 15%

  const saturation = Math.round(
    shopScore    * 0.30 +
    listingScore * 0.30 +
    ratioScore   * 0.25 +
    similarScore * 0.15
  );

  if (saturation <= 20)  return { label: 'Very Low',  color: '#22c55e', description: 'Excellent niche — very few competitors. Great opportunity!',      saturation };
  if (saturation <= 40)  return { label: 'Low',       color: '#86efac', description: 'Good niche — limited competition. Solid opportunity.',             saturation };
  if (saturation <= 60)  return { label: 'Moderate',  color: '#fbbf24', description: 'Medium competition. Differentiation is key.',                      saturation };
  if (saturation <= 80)  return { label: 'High',      color: '#f97316', description: 'High competition. Need a strong unique angle.',                    saturation };
  return                        { label: 'Very High', color: '#ef4444', description: 'Extremely saturated niche. Hard to stand out.',                    saturation };
}
