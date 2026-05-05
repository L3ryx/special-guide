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

// ── STEP 1 : Récupérer les produits AliExpress trending via Serper Shopping ──
async function fetchAliExpressProducts(keyword, maxProducts = 10) {
  console.log(`[aliSearch] Recherche AliExpress trending: "${keyword}"`);

  const r = await axios.post(
    'https://google.serper.dev/shopping',
    { q: `site:aliexpress.com ${keyword} bestseller`, gl: 'us', hl: 'en', num: 20 },
    { headers: { 'X-API-KEY': getSerperKey() }, timeout: 20000 }
  );

  const items = (r.data.shopping || [])
    .filter(x => {
      const link = x.link || x.url || '';
      return link.includes('aliexpress.com') && (x.imageUrl || x.thumbnailUrl);
    })
    .slice(0, maxProducts)
    .map(x => ({
      title:    x.title || 'Unknown',
      aliUrl:   x.link  || x.url,
      imageUrl: x.imageUrl || x.thumbnailUrl,
      price:    x.price || null,
    }));

  console.log(`[aliSearch] ${items.length} produits AliExpress trouvés pour "${keyword}"`);
  return items;
}

// ── STEP 2 : Google Lens sur image AliExpress → trouver boutiques Etsy ───────
function extractShopName(etsyUrl) {
  // https://www.etsy.com/shop/ShopName ou /listing/123?ref=...
  const shopMatch = etsyUrl.match(/etsy\.com\/shop\/([^/?#]+)/i);
  if (shopMatch) return shopMatch[1];
  // Depuis une URL listing, on ne peut pas extraire le shop_name directement
  return null;
}

async function findEtsyListingsFromImage(aliImageUrl, isAborted) {
  if (isAborted()) return [];

  // Upload l'image AliExpress vers un hébergeur public
  const pubUrl = await uploadAliImageFree(aliImageUrl);
  if (!pubUrl || isAborted()) return [];

  let r;
  const SERPER_RETRIES = 3;
  for (let attempt = 0; attempt < SERPER_RETRIES; attempt++) {
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
      if (status === 429 && attempt < SERPER_RETRIES - 1) {
        const wait = 1500 * Math.pow(2, attempt);
        await new Promise(res => setTimeout(res, wait));
        continue;
      }
      return [];
    }
  }

  const all = [...(r.data.visual_matches || []), ...(r.data.organic || [])];

  // Garder uniquement les résultats Etsy avec une image
  const etsyResults = all.filter(x => {
    const link = x.link || x.url || '';
    return link.includes('etsy.com') && (x.imageUrl || x.thumbnailUrl);
  });

  console.log(`[aliSearch] Lens → ${etsyResults.length} résultats Etsy trouvés`);

  return etsyResults.map(x => ({
    listingUrl:   x.link || x.url,
    listingImage: x.imageUrl || x.thumbnailUrl,
    listingTitle: x.title || null,
    shopName:     extractShopName(x.link || x.url || ''),
  }));
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
          message: `🔎 [${idx + 1}/${aliProducts.length}] Lens sur "${product.title.slice(0, 40)}"...`,
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

        if (!etsyListings.length) {
          send({ step: 'no_match', message: `❌ Aucune boutique Etsy trouvée pour ce produit` });
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
            shopUrl:    listing.shopName ? `https://www.etsy.com/shop/${listing.shopName}` : null,
            listingUrl: listing.listingUrl,
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
