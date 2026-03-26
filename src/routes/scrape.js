const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const mongoose = require('mongoose');

// ── MongoDB connection ──
if (mongoose.connection.readyState === 0) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/finder_niche')
    .then(() => console.log('✅ MongoDB connected'))
    .catch(err => console.error('❌ MongoDB:', err.message));
}



// ── NICHE KEYWORD (dice button) ──
router.post('/niche-keyword', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY missing' });
  try {
    const now = new Date();
    const month = now.toLocaleString('en', { month: 'long' });
    const year = now.getFullYear();
    const usedKeywords = req.body?.usedKeywords || [];
    const excludeList = usedKeywords.length > 0
      ? `\nDo NOT include any of these already-used keywords: ${usedKeywords.join(', ')}.`
      : '';

    const prompt = `It is ${month} ${year}. Generate a list of exactly 50 unique English niche keywords for Etsy product searches.

Rules:
- Each keyword must be 2-4 words
- ALL must be PHYSICAL products only (no digital, no printables, no SVG, no downloads, no templates)
- All 50 must be DIFFERENT product types — no variations of the same product
- Mix categories: home decor, jewelry, clothing, accessories, ceramics, candles, toys, stationery, wellness, outdoors, pets, baby, kitchen, garden, etc.
- Each must be specific and searchable (not generic like "handmade gift")
- Prioritize products trending in ${month} ${year}${excludeList}

Respond with ONLY a JSON array of 50 strings, no explanation, no markdown, no numbering.
Example format: ["keyword one","keyword two","keyword three"]`;

    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    const parts = r.data.candidates?.[0]?.content?.parts || [];
    const rawText = parts.map(p => p.text || '').join(' ').trim();
    const clean = rawText.replace(/```json|```/g, '').trim();
    let keywords = JSON.parse(clean);
    if (!Array.isArray(keywords)) throw new Error('Invalid response format');
    // Nettoyer et dédupliquer
    keywords = [...new Set(keywords.map(k => k.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()))].filter(k => k.length > 2).slice(0, 50);
    res.json({ keywords });
  } catch(e) {
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    res.status(500).json({ error: detail });
  }
});


// ── SEARCH ──


function parseListingsFromHtml(html) {
  const results = [], seen = new Set(), shopMap = new Map();
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(raw);
      for (const el of (data.itemListElement || [])) {
        const p = el.item || el;
        const url = p.url || p['@id'] || '';
        const idM = url.match(/\/listing\/(\d+)\//);
        if (!idM) continue;
        const sn = p.brand?.name || p.seller?.name;
        if (sn && !shopMap.has(idM[1])) shopMap.set(idM[1], sn);
      }
      for (const item of (Array.isArray(data) ? data : (data['@graph'] || []))) {
        const url = item.url || item['@id'] || '';
        const idM = url.match(/\/listing\/(\d+)\//);
        if (!idM) continue;
        const sn = item.brand?.name || item.seller?.name;
        if (sn && !shopMap.has(idM[1])) shopMap.set(idM[1], sn);
      }
    } catch {}
  }
  for (const m of html.matchAll(/"listing_id"\s*:\s*"?(\d+)"?[\s\S]{0,400}?"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/g))
    if (!shopMap.has(m[1])) shopMap.set(m[1], m[2]);
  for (const m of html.matchAll(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"[\s\S]{0,400}?"listing_id"\s*:\s*"?(\d+)"?/g))
    if (!shopMap.has(m[2])) shopMap.set(m[2], m[1]);
  for (const m of html.matchAll(/\/listing\/(\d+)\/[^"'\s]{0,100}[\s\S]{0,600}?\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )/g))
    if (!shopMap.has(m[1])) shopMap.set(m[1], m[2]);
  for (const m of html.matchAll(/\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )[\s\S]{0,600}?\/listing\/(\d+)\//g))
    if (!shopMap.has(m[2])) shopMap.set(m[2], m[1]);

  function resolveShop(id, ctx) {
    if (id && shopMap.has(id)) return shopMap.get(id);
    if (!ctx) return null;
    const m = ctx.match(/\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )/i)
           || ctx.match(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i);
    return m ? m[1] : null;
  }

  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(raw);
      const items = [];
      for (const el of (data.itemListElement || [])) items.push(el.item || el);
      for (const item of (Array.isArray(data) ? data : (data['@graph'] || []))) items.push(item);
      for (const p of items) {
        const url = p.url || p['@id'] || '';
        const img = Array.isArray(p.image) ? p.image[0] : p.image;
        if (!url.includes('/listing/') || !img) continue;
        const clean = url.split('?')[0];
        if (seen.has(clean)) continue;
        seen.add(clean);
        const idM = clean.match(/\/listing\/(\d+)\//);
        const sn = p.brand?.name || p.seller?.name || resolveShop(idM?.[1], null);
        results.push({ link: clean, image: img, shopName: sn || null });
      }
    } catch {}
  }
  if (results.filter(r => r.shopName).length >= 2) return results;

  const lms = [...html.matchAll(/\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g)];
  const imgs = [...html.matchAll(/(https:\/\/i\.etsystatic\.com\/[^"'\s,]+\.(?:jpg|jpeg|png|webp))/gi)].map(m => ({ url: m[1].split('?')[0], pos: m.index }));
  for (const lm of lms) {
    const fullUrl = 'https://www.etsy.com/listing/' + lm[1] + '/' + lm[2];
    if (seen.has(fullUrl)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgs) { const d = Math.abs(img.pos - lm.index); if (d < minDist && d < 8000) { minDist = d; closest = img; } }
    if (!closest) continue;
    seen.add(fullUrl);
    const ctx = html.slice(Math.max(0, lm.index - 2000), lm.index + 2000);
    const sn = resolveShop(lm[1], ctx);
    results.push({ link: fullUrl, image: closest.url, shopName: sn || null });
  }
  return results;
}

async function scrapeEtsyForDropship(apiKey, keyword, onPage, fetchFn) {
  const MAX_PAGES = 5, shopsSeen = new Set(), listings = [];
  let page = 1, emptyPages = 0;
  while (page <= MAX_PAGES) {
    const url = 'https://www.etsy.com/search?q=' + encodeURIComponent(keyword) + '&page=' + page;
    let html;
    try { html = await fetchFn(url, { stealth_proxy: 'true', wait: '1500' }); }
    catch (e) { console.warn('Scrape page', page, 'failed:', e.message); break; }
    const raw = parseListingsFromHtml(html);
    let added = 0;
    for (const l of raw) {
      if (!l.image || !l.shopName) continue;
      if (shopsSeen.has(l.shopName)) continue;
      shopsSeen.add(l.shopName);
      listings.push(l);
      added++;
    }
    if (onPage) onPage(page, listings.length);
    const hasNext = html.includes('pagination-next') || html.includes('page=' + (page + 1));
    if (!hasNext) break;
    if (added === 0) { emptyPages++; if (emptyPages >= 2) break; } else emptyPages = 0;
    page++;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log('scrapeEtsyForDropship done:', listings.length, 'shops');
  return listings;
}

// ── SEARCH DROPSHIP ──
// Fonctionne exactement comme la recherche de compétition :
// scrape Etsy → page boutique → 2 images → Google Lens → dropshipping confirmé si 2 matches
router.post('/search-dropship', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword?.trim()) return res.status(400).json({ error: 'Keyword required' });

  const apiKey = process.env.SCRAPEAPI_KEY;
  if (!apiKey)                     return res.status(500).json({ error: 'SCRAPEAPI_KEY missing' });
  if (!process.env.SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY missing' });
  if (!process.env.IMGBB_API_KEY)  return res.status(500).json({ error: 'IMGBB_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  try {
    const { uploadToImgBB } = require('../services/imgbbUploader');
    const axios = require('axios');

    // ── STEP 1 : Scraper les résultats Etsy (même méthode que la compétition)
    send({ step: 'scraping', message: '🔍 Scraping Etsy for "' + keyword + '"...' });

    // Utiliser la même fonction que la compétition dans shopRoutes
    let listings = [];
    try {
      listings = await scrapeEtsyForDropship(
        apiKey, keyword,
        (page, count) => send({ step: 'scraping', message: '📄 Page ' + page + ' — ' + count + ' listings...' }),
        scraperApiFetch
      );
    } catch(e) {
      send({ step: 'error', message: '❌ Scraping failed: ' + e.message }); return res.end();
    }

    listings = listings.filter(l => l.shopName);
    console.log('[search-dropship] listings with shopName:', listings.length);

    if (!listings.length) {
      send({ step: 'error', message: '❌ No shop names found in Etsy results' });
      return res.end();
    }
    send({ step: 'analyzing', message: '✅ ' + listings.length + ' unique shops. Analyzing...' });

    // ── STEP 2 : Scraper la page boutique + 2 images + Google Lens
    const imgbbCache = new Map();
    async function uploadCached(url) {
      if (imgbbCache.has(url)) return imgbbCache.get(url);
      const r = await uploadToImgBB(url);
      imgbbCache.set(url, r);
      return r;
    }

    async function scraperApiFetch(targetUrl, extraParams = {}) {
      const saKey = process.env.SCRAPEAPI_KEY;
      if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');
      const sessionNumber = Math.floor(Math.random() * 9999);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const isShop = targetUrl.includes('etsy.com/shop');
          const r = await axios.get('https://api.scraperapi.com', {
            params: {
              api_key:        saKey,
              url:            targetUrl,
              render:         isShop ? 'true' : 'false',
              country_code:   'us',
              session_number: sessionNumber,
              keep_headers:   'true',
              ...extraParams,
            },
            timeout: 70000,
          });
          const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
          if (html.length > 500) return html;
        } catch (e) {
          const status = e.response?.status;
          if (status === 401) throw new Error('SCRAPEAPI_KEY invalid (401)');
          if (status === 403) throw new Error('ScraperAPI credits exhausted (403)');
          console.warn('ScraperAPI attempt', attempt, 'failed:', e.message.slice(0, 80));
          if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 5000));
          else throw new Error('ScraperAPI failed after 3 attempts: ' + e.message);
        }
      }
    }

    async function scrapeShopImages(shopName) {
      try {
        const html = await scraperApiFetch('https://www.etsy.com/shop/' + shopName);

        // ── Extraire l'avatar réel de la boutique ──
        let shopAvatar = null;

        // 1. __NEXT_DATA__ JSON — source la plus fiable sur Etsy moderne
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextDataMatch) {
          try {
            const nd = JSON.parse(nextDataMatch[1]);
            const str = JSON.stringify(nd);
            // Chercher icon_url ou shop_icon_url dans le JSON complet
            const iconPatterns = [
              /"icon_url"\s*:\s*"([^"]+)"/,
              /"shop_icon_url"\s*:\s*"([^"]+)"/,
              /"iconUrl"\s*:\s*"([^"]+)"/,
              /"shopIconUrl"\s*:\s*"([^"]+)"/,
              /"profile_image"\s*:\s*"([^"]+)"/,
              /"avatarUrl"\s*:\s*"([^"]+)"/,
            ];
            for (const pat of iconPatterns) {
              const m = str.match(pat);
              if (m?.[1]?.startsWith('http') && (m[1].includes('etsystatic') || m[1].includes('etsy.com'))) {
                shopAvatar = m[1].replace(/\\/g, '').split('?')[0];
                break;
              }
            }
          } catch {}
        }

        // 2. Patterns directs dans le HTML brut
        if (!shopAvatar) {
          const rawPatterns = [
            /"icon_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"/,
            /"shop_icon_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"/,
            /"iconUrl"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"/,
            /"profile_image_url"\s*:\s*"([^"\\]+(?:\\.[^"\\]*)*)"/,
          ];
          for (const pat of rawPatterns) {
            const m = html.match(pat);
            if (m?.[1]) {
              const url = m[1].replace(/\\/g, '');
              if (url.startsWith('http')) { shopAvatar = url.split('?')[0]; break; }
            }
          }
        }

        // 3. Balises <img> avec attributs liés au profil/avatar de la boutique
        if (!shopAvatar) {
          const imgPatterns = [
            /src="(https:\/\/[^"]+etsystatic[^"]+)"[^>]*(?:alt="[^"]*(?:shop|owner|profil)[^"]*"|class="[^"]*(?:avatar|icon|profile|shop)[^"]*")/i,
            /(?:alt="[^"]*(?:shop|owner|profil)[^"]*"|class="[^"]*(?:avatar|icon|profile|shop)[^"]*")[^>]*src="(https:\/\/[^"]+etsystatic[^"]+)"/i,
            /class="[^"]*shop-?(?:icon|avatar|logo|image)[^"]*"[^>]*src="(https:\/\/[^"]+)"/i,
            /src="(https:\/\/[^"]+etsystatic[^"]+)"[^>]*class="[^"]*shop-?(?:icon|avatar)[^"]*"/i,
          ];
          for (const pat of imgPatterns) {
            const m = html.match(pat);
            if (m?.[1]?.startsWith('http')) { shopAvatar = m[1].split('?')[0]; break; }
          }
        }

        // 4. Fallback : petites images etsystatic (format avatar : il_75x75, il_100x100)
        if (!shopAvatar) {
          for (const m of html.matchAll(/https:\/\/i\.etsystatic\.com\/[^"'\s,]+\.(?:jpg|jpeg|png|webp)/gi)) {
            const url = m[0];
            if (url.includes('il_75x75') || url.includes('il_100x100') || url.includes('_75x75') || url.includes('avatar')) {
              shopAvatar = url.split('?')[0]; break;
            }
          }
        }

        console.log('[scrapeShopImages] ' + shopName + ' avatar:', shopAvatar ? shopAvatar.slice(0,60) : 'null');

        // ── Extraire les 2 premières images de listing (pour Google Lens) ──
        const images = [], links = [];
        for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
          try {
            const d = JSON.parse(raw);
            for (const el of (d.itemListElement || [])) {
              const p = el.item || el;
              const img = Array.isArray(p.image) ? p.image[0] : p.image;
              if (img && p.url?.includes('/listing/')) { images.push(img); links.push(p.url.split('?')[0]); if (images.length >= 2) break; }
            }
          } catch {}
          if (images.length >= 2) break;
        }
        if (images.length < 2) {
          for (const m of html.matchAll(/https:\/\/i\.etsystatic\.com\/[^"'\s,]+\.(?:jpg|jpeg|png|webp)/gi)) {
            if (!images.includes(m[0])) { images.push(m[0].split('?')[0]); links.push(null); }
            if (images.length >= 2) break;
          }
        }

        return { images: images.slice(0, 2).map((img, i) => ({ image: img, link: links[i] || null })), shopAvatar };
      } catch { return { images: [], shopAvatar: null }; }
    }

    async function lensMatch(imageUrl) {
      try {
        const pub = await uploadCached(imageUrl);
        if (!pub) return null;
        const r = await axios.post('https://google.serper.dev/lens',
          { url: pub, gl: 'us', hl: 'en' },
          { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
        );
        const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
        return all.find(x => { const u = x.link || x.url || ''; return u.includes('aliexpress.com') && u.includes('/item/') && (x.imageUrl || x.thumbnailUrl); }) || null;
      } catch (e) {
        if (e.response?.status === 401) throw new Error('serper_401');
        return null;
      }
    }

    const dropshippers = [];
    let analyzed = 0;
    const queue = [...listings];

    async function worker() {
      while (queue.length > 0) {
        const listing = queue.shift();
        if (!listing) continue;
        analyzed++;
        send({ step: 'analyzing', total: listings.length, done: analyzed, message: '🔎 ' + analyzed + '/' + listings.length + ' — ' + dropshippers.length + ' dropshippers' });
        try {
          const { images: shopImages, shopAvatar } = await scrapeShopImages(listing.shopName);
          if (shopImages.length < 2) continue;
          const [m1, m2] = await Promise.all([lensMatch(shopImages[0].image), lensMatch(shopImages[1].image)]);
          if (m1 && m2) {
            dropshippers.push({
              shopName:   listing.shopName,
              shopUrl:    'https://www.etsy.com/shop/' + listing.shopName,
              shopAvatar: shopAvatar || shopImages[0].image,
              shopImage:  shopImages[0].image,
              listingUrl: shopImages[0].link || listing.link,
            });
            send({ step: 'match', message: '✅ ' + listing.shopName + ' (' + dropshippers.length + ' dropshippers)', shop: dropshippers[dropshippers.length - 1] });
          }
        } catch (e) {
          if (e.message === 'serper_401') { send({ step: 'error', message: '❌ Serper key invalid' }); return; }
        }
      }
    }

    await Promise.all([worker(), worker(), worker(), worker()]);
    send({ step: 'complete', dropshippers, total: listings.length });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ ' + err.message });
    res.end();
  }
});



router.get('/health', (req, res) => {
  const keys = {
    SCRAPEAPI_KEY:     !!process.env.SCRAPEAPI_KEY,
    SERPER_API_KEY:    !!process.env.SERPER_API_KEY,
    IMGBB_API_KEY:     !!process.env.IMGBB_API_KEY,
    SCRAPEAPI_KEY:     !!process.env.SCRAPEAPI_KEY,
  };
  res.json({ status: Object.values(keys).every(Boolean) ? 'ready' : 'missing_keys', keys });
});

// ── AUTH + SHOPS ──
const { router: authRouter }  = require('./auth');
const shopRouter               = require('./shopRoutes');
router.use('/auth',  authRouter);
router.use('/shops', shopRouter);

module.exports = router;





