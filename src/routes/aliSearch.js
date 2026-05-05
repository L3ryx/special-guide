const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { uploadImageFree } = require('../services/freeImageUploader');
const { uploadAliImageFree } = require('../services/aliImageUploader');

// ── Clés Serper ──────────────────────────────────────────────────────────────
const SERPER_KEYS = [
  process.env.SERPER_API_KEY,
  process.env.SERPER_API_KEY_2,
].filter(Boolean);
let _serperKeyIndex = 0;
function getSerperKey() {
  const key = SERPER_KEYS[_serperKeyIndex % SERPER_KEYS.length];
  _serperKeyIndex++;
  return key;
}

// ── Catégories AliExpress disponibles (hors hi-tech) ─────────────────────────
const ALI_CATEGORIES = [
  // Maison & Déco
  'home decor trending',
  'wall art prints boho',
  'candles holders decor',
  'macrame wall hanging',
  'aesthetic room decor',
  'vase ceramic minimalist',
  'fairy lights bedroom decor',
  // Bijoux & Accessoires
  'jewelry accessories women',
  'minimalist necklace pendant',
  'crystal bracelet gemstone',
  'earrings boho statement',
  'rings vintage aesthetic',
  // Mode & Vêtements
  'clothing women aesthetic',
  'oversized hoodie women',
  'cottagecore dress women',
  'accessories scrunchies hair',
  'tote bag canvas printed',
  // Animaux
  'pet accessories dog cat',
  'cat collar bandana cute',
  'dog accessories gift',
  // Bébé & Enfants
  'baby kids toys educational',
  'baby shower gift cute',
  'kids room decor nursery',
  // Bien-être & Nature
  'crystal healing stones set',
  'yoga accessories meditation',
  'essential oil diffuser',
  'dried flowers bouquet',
  // Cuisine & Maison
  'kitchen gadgets unique',
  'personalized cutting board',
  'mug cute aesthetic',
  // Papeterie & Art
  'stationery cute aesthetic',
  'stickers pack journal',
  'art supply craft tools',
  // Outdoor & Sport
  'outdoor camping accessories',
  'hiking gear accessories',
  'beach accessories summer',
];

// ── Stop signal ───────────────────────────────────────────────────────────────
const activeSessions = new Map();

router.post('/stop-ali-search', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && activeSessions.has(sessionId)) {
    activeSessions.set(sessionId, true);
  }
  res.json({ ok: true });
});

// ── STEP 1 : Récupérer les produits AliExpress via Serper Images (même stratégie que scrape.js) ──
async function fetchAliExpressProducts(keyword, maxProducts = 10) {
  console.log(`[aliSearch] Serper Images: "${keyword}" (max ${maxProducts})`);
  const listings = [];
  const seen = new Set();

  try {
    const pagesNeeded = Math.ceil(maxProducts / 100);
    for (let page = 1; page <= pagesNeeded && listings.length < maxProducts; page++) {
      const r = await axios.post('https://google.serper.dev/images',
        { q: `aliexpress ${keyword}`, gl: 'us', hl: 'en', num: 100, page },
        { headers: { 'X-API-KEY': getSerperKey() }, timeout: 20000 }
      );
      const images = r.data.images || [];
      console.log(`[aliSearch] Images page ${page}: ${images.length} résultats`);

      for (const item of images) {
        if (listings.length >= maxProducts) break;
        const link = item.link || item.sourceUrl || '';
        if (!link.includes('aliexpress.com')) continue;
        const imageUrl = item.imageUrl || item.thumbnailUrl || null;
        if (!imageUrl) continue;
        if (seen.has(imageUrl)) continue;
        seen.add(imageUrl);
        const itemMatch = link.match(/\/item\/(\d+)/);
        listings.push({
          title:    item.title || keyword,
          aliUrl:   itemMatch ? `https://www.aliexpress.com/item/${itemMatch[1]}.html` : link,
          imageUrl,
          price:    null,
        });
      }
      if (images.length < 10) break;
    }
  } catch (e) {
    const status = e.response?.status;
    if (status === 401) throw new Error('serper_401');
    const detail = e.response?.data;
    if (status === 400 && detail?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
    throw e;
  }

  console.log(`[aliSearch] ✅ ${listings.length} produits AliExpress pour "${keyword}"`);
  return listings;
}

// ── STEP 2 : Google Lens sur image AliExpress → trouver boutiques Etsy ───────
const { getListingDetail, getShopInfo } = require('../services/etsyApi');

/**
 * Recherche Google Lens → résultats Etsy → résolution shopName + avatar via API Etsy.
 * Retourne une liste de { listingUrl, listingImage, listingId, shopName, shopUrl, shopAvatar }
 */
async function findEtsyListingsFromImage(aliImageUrl, isAborted) {
  if (isAborted()) return [];

  // ── 1. Upload image AliExpress ──
  const pubUrl = await uploadAliImageFree(aliImageUrl);
  if (!pubUrl || isAborted()) return [];

  // ── 2. Google Lens via Serper ──
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      r = await axios.post(
        'https://google.serper.dev/lens',
        { url: pubUrl, gl: 'us', hl: 'en' },
        { headers: { 'X-API-KEY': getSerperKey() }, timeout: 25000 }
      );
      break;
    } catch (e) {
      const status = e.response?.status;
      const detail = e.response?.data;
      if (status === 400) {
        if (detail?.message?.toLowerCase().includes('not enough credits')) throw new Error('serper_no_credits');
        throw e;
      }
      if (status === 429 && attempt < 2) {
        await new Promise(res => setTimeout(res, 1500 * Math.pow(2, attempt)));
        continue;
      }
      return [];
    }
  }
  if (isAborted()) return [];

  // ── 3. Filtrer résultats Etsy ──
  const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];
  const etsyResults = all.filter(x => (x.link || x.url || '').includes('etsy.com'));

  console.log(`[aliSearch] Lens → ${etsyResults.length} résultats Etsy trouvés`);
  etsyResults.slice(0, 3).forEach((x, i) =>
    console.log(`  [${i}] ${(x.link || x.url || '').slice(0, 80)}`)
  );

  if (!etsyResults.length) return [];

  // ── 4. Pour chaque résultat Etsy : résoudre shopName + récupérer avatar ──
  const resolved = [];
  const seenShops = new Set();

  for (const x of etsyResults) {
    if (isAborted()) break;
    const link  = x.link || x.url || '';
    const image = x.imageUrl || x.thumbnailUrl || null;

    let shopName   = null;
    let shopUrl    = null;
    let shopAvatar = null;
    let listingId  = null;

    // 4a. URL /shop/ShopName → résolution immédiate
    const shopMatch = link.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/);
    if (shopMatch && !['ca','uk','fr','de'].includes(shopMatch[1])) {
      shopName = shopMatch[1];
      shopUrl  = `https://www.etsy.com/shop/${shopName}`;
    }

    // 4b. URL /listing/{id} → API Etsy : listing_id → shop_id → shop_name
    const lm = link.match(/etsy\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/listing\/(\d+)/);
    if (lm) listingId = lm[1];

    let resolvedShopId = null;
    if (!shopName && listingId) {
      try {
        const detail = await getListingDetail(listingId);
        if (detail.shopName) {
          shopName      = detail.shopName;
          resolvedShopId = detail.shopId || null;
          shopUrl       = `https://www.etsy.com/shop/${shopName}`;
          console.log(`[aliSearch] shopName via API listing ${listingId}: ${shopName}`);
        }
      } catch(e) {
        console.warn(`[aliSearch] getListingDetail(${listingId}) échoué:`, e.message);
      }
    }

    // 4c. Fallback scraping HTML page listing
    if (!shopName && listingId && !isAborted()) {
      try {
        const pageRes = await axios.get(`https://www.etsy.com/listing/${listingId}`, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          maxRedirects: 3,
        });
        const html = pageRes.data || '';
        const jsMatch    = html.match(/"shop_name"\s*:\s*"([^"]+)"/);
        const canonMatch = html.match(/etsy\.com\/shop\/([A-Za-z0-9_-]+)/);
        const found = (jsMatch?.[1]) || (canonMatch?.[1]) || null;
        if (found && found.length > 2 && !['etsy','ca','uk','fr','de'].includes(found)) {
          shopName = found;
          shopUrl  = `https://www.etsy.com/shop/${shopName}`;
          console.log(`[aliSearch] shopName via scraping HTML: ${shopName}`);
        }
      } catch(e) {
        console.warn(`[aliSearch] scraping HTML listing ${listingId} échoué:`, e.message);
      }
    }

    // Skip si toujours pas de shopName
    if (!shopName) {
      console.log(`[aliSearch] ❌ shopName non résolu pour: ${link.slice(0, 60)}`);
      continue;
    }

    // Dédupliquer par shopName
    if (seenShops.has(shopName)) continue;
    seenShops.add(shopName);

    // 5. Récupérer avatar via API Etsy getShopInfo (on passe l'ID numérique si dispo)
    if (!isAborted()) {
      try {
        const info = await getShopInfo(resolvedShopId || shopName);
        shopAvatar = info.shopAvatar || null;
        shopUrl    = info.shopUrl || shopUrl;
        console.log(`[aliSearch] ✅ ${shopName} | avatar: ${shopAvatar ? 'oui' : 'non'}`);
      } catch(e) {
        console.warn(`[aliSearch] getShopInfo(${shopName}) échoué:`, e.message);
      }
    }

    resolved.push({
      listingUrl:   listingId ? `https://www.etsy.com/listing/${listingId}` : link,
      listingImage: image,
      listingId,
      shopName,
      shopUrl,
      shopAvatar,
    });
  }

  console.log(`[aliSearch] ${resolved.length}/${etsyResults.length} boutiques résolues`);
  return resolved;
}

// ── STEP 3 : Pipeline DINOv2 pour confirmer la similarité ────────────────────
async function runVisualPipeline(aliImageUrl, etsyImageUrl) {
  if (!process.env.VISUAL_API_URL) return null;
  try {
    // STEP 3a — Segmentation SAM
    const samRes = await axios.post(
      `${process.env.VISUAL_API_URL}/segment`,
      { images: [aliImageUrl, etsyImageUrl] },
      { timeout: 30000 }
    );
    const masks = samRes.data?.masks || [];

    // STEP 3b — Extraction fond blanc
    const extractRes = await axios.post(
      `${process.env.VISUAL_API_URL}/extract`,
      { images: [aliImageUrl, etsyImageUrl], masks, background: 'white' },
      { timeout: 30000 }
    );
    const croppedImages = extractRes.data?.croppedImages || [];

    // STEP 3c — Features DINOv2
    const dinoRes = await axios.post(
      `${process.env.VISUAL_API_URL}/features`,
      { images: croppedImages },
      { timeout: 30000 }
    );
    const features = dinoRes.data?.features || [];

    // STEP 3d — Patch filtering
    const patchRes = await axios.post(
      `${process.env.VISUAL_API_URL}/filter-patches`,
      { features, masks },
      { timeout: 30000 }
    );
    const filteredPatches = patchRes.data?.filteredPatches || [];

    // STEP 3e — Score similarité
    if (features.length >= 2 && filteredPatches.length >= 2) {
      const scoreRes = await axios.post(
        `${process.env.VISUAL_API_URL}/similarity`,
        {
          featuresA: { cls_embedding: features[0]?.cls_embedding, patch_tokens: filteredPatches[0] },
          featuresB: { cls_embedding: features[1]?.cls_embedding, patch_tokens: filteredPatches[1] },
        },
        { timeout: 15000 }
      );
      return scoreRes.data; // { similarity, is_dropship, threshold }
    }
    return null;
  } catch (e) {
    console.warn('[visualPipeline] ⚠️ Erreur (non bloquant):', e.message);
    return null;
  }
}

// ── ROUTE PRINCIPALE ─────────────────────────────────────────────────────────
router.post('/search-from-ali', async (req, res) => {
  const { category, sessionId, productsPerCategory = 8 } = req.body;

  if (!SERPER_KEYS.length) return res.status(500).json({ error: 'SERPER_API_KEY missing' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = d => { try { res.write('data: ' + JSON.stringify(d) + '\n\n'); } catch {} };

  // Session abort
  for (const [key, val] of activeSessions.entries()) {
    if (val === true) activeSessions.delete(key);
  }
  const sid = sessionId?.trim() || (Date.now() + Math.random()).toString(36);
  activeSessions.set(sid, false);
  const isAborted = () => activeSessions.get(sid) === true;

  try {
    // Catégories à analyser
    const categories = category
      ? [category]
      : ALI_CATEGORIES;

    send({ step: 'start', message: `🚀 Analyse de ${categories.length} catégorie(s) AliExpress...`, categories });

    const dropshippers = [];
    const seenShops    = new Set();
    const seenListings = new Set();
    let globalDone = 0; // compteur global cross-catégories
    const globalTotal = categories.length * productsPerCategory;
    send({ step: 'init', total: globalTotal });

    for (const cat of categories) {
      if (isAborted()) break;

      send({ step: 'category', message: `📦 Catégorie : "${cat}"` });

      // ── STEP 1 : Produits AliExpress ───────────────────────────────────────
      let aliProducts = [];
      try {
        aliProducts = await fetchAliExpressProducts(cat, productsPerCategory);
      } catch (e) {
        if (e.message === 'serper_no_credits') {
          send({ step: 'error', message: '❌ Crédits Serper épuisés' });
          break;
        }
        send({ step: 'warning', message: `⚠️ Erreur récupération produits "${cat}": ${e.message}` });
        continue;
      }

      if (!aliProducts.length) {
        send({ step: 'warning', message: `⚠️ Aucun produit AliExpress trouvé pour "${cat}"` });
        continue;
      }

      send({ step: 'products', message: `✅ ${aliProducts.length} produits AliExpress trouvés`, products: aliProducts });

      // ── STEP 2 + 3 : Lens + DINOv2 pour chaque produit ────────────────────
      for (const [idx, product] of aliProducts.entries()) {
        if (isAborted()) break;

        send({
          step:    'analyzing',
          total:   globalTotal,
          done:    globalDone,
          message: `🔎 [${globalDone + 1}/${globalTotal}] Lens search...`,
        });

        // STEP 2 — Trouver boutiques Etsy via Lens
        let etsyListings = [];
        try {
          etsyListings = await findEtsyListingsFromImage(product.imageUrl, isAborted);
        } catch (e) {
          if (e.message === 'serper_no_credits') {
            send({ step: 'error', message: '❌ Crédits Serper épuisés' });
            activeSessions.delete(sid);
            return res.end();
          }
          console.warn('[search-from-ali] Lens error:', e.message);
          continue;
        }

        // shop_done : compteur global cross-catégories
        globalDone++;
        send({ step: 'shop_done', done: globalDone, total: globalTotal });

        if (!etsyListings.length) {
          continue;
        }

        send({ step: 'lens_match', message: `🎯 ${etsyListings.length} boutique(s) Etsy détectée(s) via Lens` });

        // STEP 3 — DINOv2 pour confirmer chaque résultat Etsy
        for (const listing of etsyListings) {
          if (isAborted()) break;
          if (!listing.listingImage) continue;

          // Dédupliquer par listing URL
          if (seenListings.has(listing.listingUrl)) continue;
          seenListings.add(listing.listingUrl);

          const pipelineResult = await runVisualPipeline(product.imageUrl, listing.listingImage);

          // Si pas de pipeline visuel → on se fie à Lens seul
          const confirmed  = !pipelineResult || pipelineResult.is_dropship;
          const similarity = pipelineResult?.similarity ?? null;

          if (!confirmed) {
            console.log(`[search-from-ali] ❌ DINOv2 reject — sim: ${similarity}`);
            continue;
          }

          const shopKey = listing.shopName || listing.listingUrl;
          if (seenShops.has(shopKey)) continue;
          seenShops.add(shopKey);

          const match = {
            // Source AliExpress
            aliUrl:     product.aliUrl,
            aliImage:   product.imageUrl,
            aliTitle:   product.title,
            aliPrice:   product.price,
            category:   cat,
            // Boutique Etsy
            shopName:   listing.shopName,
            shopUrl:    listing.shopUrl || (listing.shopName ? `https://www.etsy.com/shop/${listing.shopName}` : null),
            shopAvatar: listing.shopAvatar || null,
            listingUrl: listing.listingUrl,
            listingId:  listing.listingId || null,
            shopImage:  listing.listingImage,
            // Score DINOv2
            visualSimilarity: similarity,
          };

          dropshippers.push(match);

          const simLabel = similarity !== null
            ? ` | DINOv2 : ${(similarity * 100).toFixed(1)}%`
            : ' | Lens only';

          send({
            step:    'match',
            message: `✅ ${listing.shopName || listing.listingUrl} — "${product.title.slice(0, 30)}"${simLabel}`,
            shop:    match,
          });
        }

        // Pause entre produits pour ne pas flooder Serper
        await new Promise(r => setTimeout(r, 400));
      }
    }

    if (isAborted()) {
      send({ step: 'stopped', message: '🛑 Recherche arrêtée.' });
    } else {
      send({
        step:         'complete',
        dropshippers,
        total:        dropshippers.length,
        message:      `✅ Terminé — ${dropshippers.length} boutique(s) dropshippers trouvée(s)`,
      });
    }

    activeSessions.delete(sid);
    res.end();

  } catch (err) {
    activeSessions.delete(sid);
    send({ step: 'error', message: '❌ ' + err.message });
    res.end();
  }
});

// ── Catégories disponibles ────────────────────────────────────────────────────
router.get('/ali-categories', (req, res) => {
  res.json({ categories: ALI_CATEGORIES });
});

module.exports = router;
