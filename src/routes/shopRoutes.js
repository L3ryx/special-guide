const express      = require('express');
const router       = express.Router();
const axios        = require('axios');
const { requireAuth } = require('./auth');
const SavedShop    = require('../models/shopModel');
const { uploadToImgBB } = require('../services/imgbbUploader');

// ── SAVE SHOP ──
router.post('/save', requireAuth, async (req, res) => {
  const { productUrl, productImage } = req.body;
  if (!productUrl) return res.status(400).json({ error: 'productUrl requis' });
  try {
    const shop = await SavedShop.findOneAndUpdate(
      { userId: req.user.id, productUrl },
      { $set: {
          productUrl,
          productImage: productImage || null,
          keyword:      null,
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

    // ── STEP 1 : Scraper le titre de l'annonce via ScrapingBee puis Gemini ──
    if (!process.env.GEMINI_API_KEY) { send({ step: 'error', message: '❌ GEMINI_API_KEY missing' }); return res.end(); }
    if (!shop.productUrl) { send({ step: 'error', message: '❌ No product URL saved for this listing' }); return res.end(); }

    send({ step: 'keyword', message: '🔍 Fetching listing details...' });

    let keyword = '';
    try {
      // 1a. ScrapingBee scrape la page de l'annonce Etsy
      const listingHtml = await scrapingbeeFetch(shop.productUrl, { stealth_proxy: 'true', wait: '2000' });

      // Extraire le titre depuis JSON-LD ou balise title
      let listingTitle = '';
      try {
        for (const [, raw] of listingHtml.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
          const d = JSON.parse(raw);
          const items = Array.isArray(d) ? d : (d['@graph'] || [d]);
          for (const item of items) {
            if (item.name && item.url?.includes('/listing/')) { listingTitle = item.name; break; }
          }
          if (listingTitle) break;
        }
      } catch {}
      if (!listingTitle) {
        const titleM = listingHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
        if (titleM) listingTitle = titleM[1].replace(/\s*[|\-].*$/, '').trim();
      }
      if (!listingTitle) throw new Error('Could not extract listing title');

      console.log('[Competition] Listing title:', listingTitle);
      send({ step: 'keyword', message: '📝 Title: "' + listingTitle.slice(0, 60) + '"' });

      // 1b. Gemini génère le mot-clé Etsy optimal
      const geminiRes = await axios.post(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=' + process.env.GEMINI_API_KEY,
        { contents: [{ parts: [{ text: 'From this Etsy listing title, extract the best 2-4 word search keyword that represents the core product. The keyword must be short, generic, and suitable for an Etsy product search. Reply with ONLY the keyword, no punctuation, no explanation.\n\nTitle: ' + listingTitle }] }] },
        { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
      );
      keyword = (geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
      if (!keyword) throw new Error('Gemini returned empty keyword');

    } catch (e) {
      console.warn('[Competition] Gemini keyword failed:', e.message, '— falling back to saved keyword');
      // Fallback : keyword sauvegardé ou slug URL
      if (shop.keyword && shop.keyword.trim().length > 1) {
        keyword = shop.keyword.trim().toLowerCase();
      } else if (shop.productUrl) {
        const m = shop.productUrl.match(/\/listing\/\d+\/([^/?#]+)/);
        if (m) keyword = m[1].replace(/-/g, ' ').replace(/[^a-z0-9 ]/gi, ' ').trim().toLowerCase().split(/\s+/).slice(0, 4).join(' ');
      }
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
    // totalShops = nombre réel de listings scrapés (pas seulement ceux avec shopName)
    const totalUniqueShops = listings.length;
    send({ step: 'analyzing', totalShops: totalUniqueShops, message: '✅ ' + totalUniqueShops + ' listings found. Analyzing...' });

    // ── STEP 3 : Comparaison image par image ──────────────────────────

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
            shopName:     listing.shopName,
            shopUrl:      'https://www.etsy.com/shop/' + listing.shopName,
            listingImage: listing.image  || null,
            listingUrl:   listing.link   || null,
            aliImage:     aliImageUrl    || null,
            aliUrl:       aliUrl         || null,
          });
        }
        console.log('✅ Dropshipper confirmed —', listing.shopName);
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

// Scrape Etsy search results — 1 listing par boutique unique, toutes les pages disponibles
async function scrapeEtsyListingsForCompetition(apiKey, keyword, onPage) {
  const MAX_PAGES  = 5;   // max 5 pages Etsy
  const shopsSeen  = new Set();
  const listings   = [];
  let page = 1;
  let emptyPages = 0;

  while (page <= MAX_PAGES) {
    const etsyUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&page=${page}`;
    let html = '';
    try {
      html = await scrapingbeeFetch(etsyUrl, { stealth_proxy: 'true', wait: '3000' });
    } catch (e) {
      console.warn('Competition scrape page', page, '— failed:', e.message);
      break;
    }

    const rawListings = parseSearchResultListings(html);
    let addedOnPage = 0;

    for (const l of rawListings) {
      if (!l.image) continue;
      // Une seule annonce par boutique — si shopName connu et déjà vu, skip
      if (l.shopName && shopsSeen.has(l.shopName)) continue;
      if (l.shopName) shopsSeen.add(l.shopName);
      listings.push({ shopName: l.shopName || null, image: l.image, link: l.link });
      addedOnPage++;
    }

    onPage(page, listings.length);
    console.log(`Page ${page}: ${rawListings.length} raw, ${addedOnPage} new unique shops, total: ${listings.length}`);

    // Arrêt si plus de page suivante
    const hasNext = html.includes('pagination-next') || html.includes('page=' + (page + 1));
    if (!hasNext) { console.log('No next page — stopping'); break; }

    // Arrêt anticipé si 2 pages consécutives sans nouvelles boutiques
    if (addedOnPage === 0) {
      emptyPages++;
      if (emptyPages >= 2) { console.log('2 empty pages — stopping'); break; }
    } else {
      emptyPages = 0;
    }

    page++;
    await new Promise(r => setTimeout(r, 400));
  }

  console.log(`Competition scrape done: ${listings.length} unique shops across ${page} pages`);
  return listings;
}

// Extract listings from Etsy search result HTML (covers all 3 strategies)
function parseSearchResultListings(html) {
  const results = [];
  const seen    = new Set();

  // ── Pré-scan JSON-LD Etsy ──
  // Structure : {"@type":"ItemList","itemListElement":[{"@type":"ListItem","item":{"@type":"Product","brand":{"name":"ShopName"},"url":"..."}}]}
  const shopMap = new Map();

  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(raw);
      // ItemList > ListItem > item (Product)
      for (const el of (data.itemListElement || [])) {
        const product = el.item || el;
        const url = product.url || product['@id'] || '';
        const idM = url.match(/\/listing\/(\d+)\//);
        if (!idM) continue;
        const sn = product.brand?.name || product.seller?.name || product.manufacturer?.name;
        if (sn && !shopMap.has(idM[1])) shopMap.set(idM[1], sn);
      }
      // @graph ou array direct
      for (const item of (Array.isArray(data) ? data : (data['@graph'] || []))) {
        const url = item.url || item['@id'] || '';
        const idM = url.match(/\/listing\/(\d+)\//);
        if (!idM) continue;
        const sn = item.brand?.name || item.seller?.name;
        if (sn && !shopMap.has(idM[1])) shopMap.set(idM[1], sn);
      }
    } catch {}
  }

  // JSON inline
  for (const m of html.matchAll(/"listing_id"\s*:\s*"?(\d+)"?[\s\S]{0,400}?"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/g))
    if (!shopMap.has(m[1])) shopMap.set(m[1], m[2]);
  for (const m of html.matchAll(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"[\s\S]{0,400}?"listing_id"\s*:\s*"?(\d+)"?/g))
    if (!shopMap.has(m[2])) shopMap.set(m[2], m[1]);

  // /shop/Name voisin de /listing/ID
  for (const m of html.matchAll(/\/listing\/(\d+)\/[^"'\s]{0,100}[\s\S]{0,600}?\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )/g))
    if (!shopMap.has(m[1])) shopMap.set(m[1], m[2]);
  for (const m of html.matchAll(/\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )[\s\S]{0,600}?\/listing\/(\d+)\//g))
    if (!shopMap.has(m[2])) shopMap.set(m[2], m[1]);

  console.log('[shopMap] ' + shopMap.size + ' entries');

  function resolveShop(listingId, localCtx) {
    if (listingId && shopMap.has(listingId)) return shopMap.get(listingId);
    if (!localCtx) return null;
    const m = localCtx.match(/\/shop\/([A-Za-z0-9][A-Za-z0-9._-]{1,49})(?:\/|\?|"|'| )/i)
           || localCtx.match(/"shop_name"\s*:\s*"([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i)
           || localCtx.match(/data-shop-name="([A-Za-z0-9][A-Za-z0-9._-]{1,49})"/i);
    return m ? m[1] : null;
  }

  // Strategy 1: JSON-LD ItemList (structure Etsy principale)
  for (const [, raw] of html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(raw);
      const toProcess = [];
      // ItemList
      for (const el of (data.itemListElement || [])) toProcess.push(el.item || el);
      // @graph ou direct
      for (const item of (Array.isArray(data) ? data : (data['@graph'] || []))) toProcess.push(item);

      for (const product of toProcess) {
        const url  = product.url || product['@id'] || '';
        const rawImg = product.image;
        const img  = Array.isArray(rawImg) ? rawImg[0] : rawImg;
        if (!url.includes('/listing/') || !img) continue;
        const cleanUrl = url.split('?')[0];
        if (seen.has(cleanUrl)) continue;
        seen.add(cleanUrl);
        const idM = cleanUrl.match(/\/listing\/(\d+)\//);
        const shopName = product.brand?.name || product.seller?.name || resolveShop(idM?.[1], null);
        results.push({ link: cleanUrl, image: img, shopName: shopName || null,
          shopUrl: shopName ? 'https://www.etsy.com/shop/' + shopName : null });
      }
    } catch {}
  }
  if (results.filter(r => r.shopName).length >= 2) return results;

  // Strategy 2: data-listing-id blocks
  for (const [, b] of html.matchAll(/(<(?:li|div)[^>]*data-listing-id[^>]*>[\s\S]*?<\/(?:li|div)>)/gi)) {
    const linkM = b.match(/href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?#]+)/);
    const imgM  = b.match(/(?:src|data-src|srcset)="(https:\/\/i\.etsystatic\.com\/[^"\s,]+)"/i);
    if (!linkM || !imgM || seen.has(linkM[1])) continue;
    seen.add(linkM[1]);
    const idM = linkM[1].match(/\/listing\/(\d+)\//);
    const shopName = resolveShop(idM?.[1], b);
    results.push({ link: linkM[1], image: imgM[1].split('?')[0], shopName,
      shopUrl: shopName ? 'https://www.etsy.com/shop/' + shopName : null });
  }
  if (results.filter(r => r.shopName).length >= 2) return results;

  // Strategy 3: proximity etsystatic images + listing IDs dans le HTML
  const allListingMatches = [...html.matchAll(/\/listing\/(\d+)\/([A-Za-z0-9_-]+)/g)];
  const allImages = [...html.matchAll(/(https:\/\/i\.etsystatic\.com\/[^"'\s,]+\.(?:jpg|jpeg|png|webp))/gi)];
  const imgPos = allImages.map(m => ({ url: m[1].split('?')[0], pos: m.index }));

  for (const lm of allListingMatches) {
    const fullUrl = 'https://www.etsy.com/listing/' + lm[1] + '/' + lm[2];
    if (seen.has(fullUrl)) continue;
    let closest = null, minDist = Infinity;
    for (const img of imgPos) {
      const d = Math.abs(img.pos - lm.index);
      if (d < minDist && d < 8000) { minDist = d; closest = img; }
    }
    if (!closest) continue;
    seen.add(fullUrl);
    const ctx = html.slice(Math.max(0, lm.index - 2000), lm.index + 2000);
    const shopName = resolveShop(lm[1], ctx);
    results.push({ link: fullUrl, image: closest.url, shopName,
      shopUrl: shopName ? 'https://www.etsy.com/shop/' + shopName : null });
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

module.exports = router;

