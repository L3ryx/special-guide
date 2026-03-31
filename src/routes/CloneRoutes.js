/**
 * cloneRoutes.js
 * Pipeline complet : Boutique Etsy → Google Lens → AliExpress → Leonardo → Gemini → Etsy Listing
 *
 * Etsy data → API officielle Etsy (etsyApi.js)
 * AliExpress data → ScraperAPI (pas d'API officielle)
 */

require('dotenv').config();
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const { requireAuth } = require('./auth');
// ScraperAPI conservé UNIQUEMENT pour AliExpress
const { scraperApiFetch } = require('../services/scrapingFetch');
const { uploadToImgBB }   = require('../services/imgbbUploader');
const { getShopListings, getListingDetail, handleEtsyError } = require('../services/etsyApi');

// ══════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════

/**
 * Récupère les listings d'une boutique Etsy via l'API officielle.
 * Remplace le scraping HTML de https://www.etsy.com/shop/{shopName}
 */
async function scrapeShopListings(shopName) {
  try {
    const results = await getShopListings(shopName, 20);
    return results.map(l => ({
      url:   l.link,
      image: l.image,
      title: l.title,
      price: l.price,
    }));
  } catch (e) {
    handleEtsyError(e);
  }
}

/**
 * Récupère le détail d'un listing Etsy via l'API officielle.
 */
async function scrapeListingDetail(listingUrl) {
  const idMatch = listingUrl.match(/\/listing\/(\d+)\//);
  if (!idMatch) throw new Error('Invalid listing URL: ' + listingUrl);
  try {
    return await getListingDetail(idMatch[1]);
  } catch (e) {
    handleEtsyError(e);
  }
}

/**
 * Recherche inversée Google Lens via Serper avec filtre AliExpress
 * Retourne le premier résultat AliExpress ou null
 */
async function lensSearchAliExpress(imageUrl) {
  const pubUrl = await uploadToImgBB(imageUrl);
  if (!pubUrl) return null;

  const r = await axios.post(
    'https://google.serper.dev/lens',
    { url: pubUrl, gl: 'us', hl: 'en' },
    { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 30000 }
  );

  const all = [
    ...(r.data.visual_matches || []),
    ...(r.data.organic        || []),
    ...(r.data.shopping       || []),
  ];

  return all.find(x => {
    const u = x.link || x.url || '';
    return u.includes('aliexpress.com') && (u.includes('/item/') || u.includes('/i/'));
  }) || null;
}

/**
 * Scrape une page produit AliExpress et retourne les 4 images supplémentaires
 */
async function scrapeAliExpressImages(aliUrl) {
  const html = await scraperApiFetch(aliUrl);
  const images = [];

  // Images dans les données JSON embarquées
  for (const m of html.matchAll(/"imageUrl"\s*:\s*"(https:[^"]+)"/gi)) {
    const url = m[1].replace(/\\\//g, '/').split('?')[0];
    if (url.includes('alicdn') || url.includes('aliexpress')) {
      if (!images.includes(url)) images.push(url);
      if (images.length >= 5) break;
    }
  }
  // Fallback regex img src
  if (images.length < 4) {
    for (const m of html.matchAll(/src="(https:\/\/[^"]+alicdn[^"]+\.(?:jpg|jpeg|png|webp))"/gi)) {
      const url = m[1].split('?')[0];
      if (!images.includes(url)) images.push(url);
      if (images.length >= 5) break;
    }
  }

  return images.slice(1, 5); // Sauter la première (déjà utilisée), prendre les 4 suivantes
}

/**
 * Génère une image modifiée via Leonardo.ai
 * Analyse l'image, change fond + angle de vue
 */
async function transformImageWithLeonardo(imageUrl, index) {
  const LEONARDO_KEY = process.env.LEONARDO_API_KEY;
  if (!LEONARDO_KEY) throw new Error('LEONARDO_API_KEY missing');

  // 1. Upload de l'image source vers Leonardo
  const uploadRes = await axios.post(
    'https://cloud.leonardo.ai/api/rest/v1/init-image',
    { extension: 'jpg' },
    { headers: { Authorization: 'Bearer ' + LEONARDO_KEY, 'Content-Type': 'application/json' } }
  );
  const { url: presignedUrl, id: initImageId, fields } = uploadRes.data.uploadInitImage;

  // Télécharger l'image source
  const imgData = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
  const form = new (require('form-data'))();
  if (fields) {
    try { const f = typeof fields === 'string' ? JSON.parse(fields) : fields; Object.entries(f).forEach(([k,v]) => form.append(k, v)); }
    catch {}
  }
  form.append('file', Buffer.from(imgData.data), { filename: 'product.jpg', contentType: 'image/jpeg' });
  await axios.post(presignedUrl, form, { headers: form.getHeaders(), timeout: 30000 });

  // 2. Générer l'image transformée (Image2Image)
  const angleVariants = [
    'slightly elevated angle, soft studio lighting',
    'low angle perspective, dramatic side lighting',
    'top-down flat lay view, clean bright background',
    '45-degree angle, natural daylight background',
    'close-up detail shot, bokeh background',
  ];
  const anglePrompt = angleVariants[index % angleVariants.length];

  const genRes = await axios.post(
    'https://cloud.leonardo.ai/api/rest/v1/generations',
    {
      prompt: `Product photography, same product, ${anglePrompt}. Change the background to a clean, contextually relevant setting matching the product theme. Keep the product identical, only change background and viewing angle. Professional ecommerce photography, high quality.`,
      negative_prompt: 'blurry, distorted, watermark, text, low quality, deformed product',
      modelId: '6bef9f1b-29cb-40c7-b9df-32b51c1f67d3', // Leonardo Diffusion XL
      width: 1024,
      height: 1024,
      num_images: 1,
      guidance_scale: 7,
      init_image_id: initImageId,
      init_strength: 0.45,
      presetStyle: 'PRODUCT_PHOTOGRAPHY',
    },
    { headers: { Authorization: 'Bearer ' + LEONARDO_KEY, 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const generationId = genRes.data.sdGenerationJob?.generationId;
  if (!generationId) throw new Error('Leonardo: no generationId');

  // 3. Attendre la fin de la génération (polling)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const poll = await axios.get(
      'https://cloud.leonardo.ai/api/rest/v1/generations/' + generationId,
      { headers: { Authorization: 'Bearer ' + LEONARDO_KEY } }
    );
    const status = poll.data.generations_by_pk?.status;
    if (status === 'COMPLETE') {
      const imgs = poll.data.generations_by_pk?.generated_images || [];
      if (imgs.length > 0) return imgs[0].url;
      throw new Error('Leonardo: no images generated');
    }
    if (status === 'FAILED') throw new Error('Leonardo: generation failed');
  }
  throw new Error('Leonardo: timeout');
}

/**
 * Génère titre, description et tags SEO avec Gemini
 */
async function generateSEOWithGemini(originalTitle, price) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY missing');

  const prompt = `You are an expert Etsy SEO specialist. Given this product information:
- Original title: "${originalTitle}"
- Price: $${price}

Generate the following in JSON format:
{
  "title": "A highly optimized Etsy listing title (max 140 chars), with main keyword first, include long-tail keywords, use | or , as separators",
  "description": "A compelling Etsy product description in English (400-600 words). Start with an engaging hook. Include: main features, materials/quality, use cases, dimensions if relevant, why customers will love it. Use short paragraphs. Include natural keyword placement for SEO. End with a call to action.",
  "tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10","tag11","tag12","tag13"],
  "category": "The most appropriate Etsy product category (e.g.: Home & Living > Home Décor > Candles & Holders, or Jewelry > Necklaces, etc.)"
}

Rules:
- Title: 13 of the most searched keywords for this product on Etsy
- Tags: exactly 13 tags, each max 20 characters, highly searchable on Etsy, no duplicate words across tags
- Description: written for US buyers, conversational yet professional
- Category: use Etsy's actual category tree format

Respond ONLY with valid JSON, no markdown, no explanation.`;

  const r = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`,
    { contents: [{ parts: [{ text: prompt }] }] },
    { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
  );

  const raw = (r.data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

/**
 * Crée un listing Etsy via l'API officielle
 */
async function createEtsyListing(etsyToken, shopId, listingData) {
  const { title, description, tags, price, imageUrls } = listingData;

  // 1. Créer le brouillon de listing
  const createRes = await axios.post(
    `https://openapi.etsy.com/v3/application/shops/${shopId}/listings`,
    {
      quantity:               5,
      title:                  title.slice(0, 140),
      description,
      price:                  parseFloat(price) || 9.99,
      who_made:               'i_did',
      when_made:              'made_to_order',
      taxonomy_id:            listingData.taxonomyId || 68887469, // Home & Living par défaut
      state:                  'draft',
      is_supply:              false,
      is_customizable:        false,
      is_digital:             false,
      processing_min:         1,
      processing_max:         3,
      tags:                   tags.slice(0, 13).map(t => t.slice(0, 20)),
      materials:              [],
      shipping_profile_id:    null, // sera défini manuellement
      item_weight_unit:       'oz',
      item_dimensions_unit:   'in',
      production_partner_ids: [],
    },
    {
      headers: {
        'Authorization': 'Bearer ' + etsyToken,
        'x-api-key':     process.env.ETSY_CLIENT_ID,
        'Content-Type':  'application/json',
      },
    }
  );

  const listingId = createRes.data.listing_id;

  // 2. Upload des images
  for (let i = 0; i < Math.min(imageUrls.length, 5); i++) {
    try {
      // Télécharger l'image
      const imgResp = await axios.get(imageUrls[i], { responseType: 'arraybuffer', timeout: 20000 });
      const form    = new (require('form-data'))();
      form.append('image', Buffer.from(imgResp.data), { filename: `image_${i+1}.jpg`, contentType: 'image/jpeg' });
      form.append('rank', String(i + 1));

      await axios.post(
        `https://openapi.etsy.com/v3/application/shops/${shopId}/listings/${listingId}/images`,
        form,
        {
          headers: {
            ...form.getHeaders(),
            'Authorization': 'Bearer ' + etsyToken,
            'x-api-key':     process.env.ETSY_CLIENT_ID,
          },
          timeout: 60000,
        }
      );
    } catch (imgErr) {
      console.warn(`Image ${i+1} upload failed:`, imgErr.message);
    }
  }

  return listingId;
}

/**
 * Résout le shop_id Etsy à partir du token OAuth
 */
async function getEtsyShopId(etsyToken) {
  const r = await axios.get('https://openapi.etsy.com/v3/application/users/me', {
    headers: {
      'Authorization': 'Bearer ' + etsyToken,
      'x-api-key':     process.env.ETSY_CLIENT_ID,
    },
  });
  const shopId = r.data.shop_id;
  if (!shopId) throw new Error('No Etsy shop linked to this account');
  return shopId;
}

/**
 * Résout le taxonomy_id Etsy depuis le nom de catégorie fourni par Gemini
 */
async function resolveTaxonomyId(category, etsyToken) {
  try {
    const r = await axios.get('https://openapi.etsy.com/v3/application/seller-taxonomy/nodes', {
      headers: {
        'Authorization': 'Bearer ' + etsyToken,
        'x-api-key':     process.env.ETSY_CLIENT_ID,
      },
    });

    const nodes = r.data.results || [];
    const catLower = category.toLowerCase();

    // Cherche la meilleure correspondance
    let best = null, bestScore = 0;
    function walk(node) {
      const name = (node.name || '').toLowerCase();
      const fullPath = (node.full_path || '').toLowerCase();
      const score = catLower.includes(name) || fullPath.includes(catLower.split('>')[0].trim()) ? name.length : 0;
      if (score > bestScore) { bestScore = score; best = node; }
      for (const child of (node.children || [])) walk(child);
    }
    for (const node of nodes) walk(node);
    return best?.id || 68887469;
  } catch {
    return 68887469; // Home & Living fallback
  }
}

// ══════════════════════════════════════════════════════════════════
// ROUTE PRINCIPALE : POST /api/clone/start
// SSE stream : envoie les étapes en temps réel
// ══════════════════════════════════════════════════════════════════
router.post('/start', requireAuth, async (req, res) => {
  const { shopName, etsyToken } = req.body;

  if (!shopName)   return res.status(400).json({ error: 'shopName required' });
  if (!etsyToken)  return res.status(400).json({ error: 'etsyToken (Etsy OAuth token) required' });

  // Vérifications clés API
  const missing = [];
  if (!process.env.SERPER_API_KEY)   missing.push('SERPER_API_KEY');
  if (!process.env.IMGBB_API_KEY)    missing.push('IMGBB_API_KEY');
  if (!process.env.GEMINI_API_KEY)   missing.push('GEMINI_API_KEY');
  if (!process.env.LEONARDO_API_KEY) missing.push('LEONARDO_API_KEY');
  if (!process.env.ETSY_CLIENT_ID)   missing.push('ETSY_CLIENT_ID');
  if (missing.length) return res.status(500).json({ error: 'Missing API keys: ' + missing.join(', ') });

  // ── SSE setup ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch {}
  };

  try {
    // ── ÉTAPE 1 : Récupérer les annonces de la boutique ──
    send({ step: 'scrape_shop', status: 'running', message: '🛍 Scraping shop listings for ' + shopName + '...' });

    let shopListings;
    try {
      shopListings = await scrapeShopListings(shopName);
    } catch (e) {
      send({ step: 'error', message: '❌ Failed to scrape shop: ' + e.message });
      return res.end();
    }

    if (!shopListings.length) {
      send({ step: 'error', message: '❌ No listings found in shop ' + shopName });
      return res.end();
    }
    send({ step: 'scrape_shop', status: 'done', message: '✅ Found ' + shopListings.length + ' listings', count: shopListings.length });

    // ── ÉTAPE 2 : Résoudre le shop_id Etsy ──
    send({ step: 'etsy_auth', status: 'running', message: '🔑 Verifying Etsy access...' });
    let etsyShopId;
    try {
      etsyShopId = await getEtsyShopId(etsyToken);
      send({ step: 'etsy_auth', status: 'done', message: '✅ Etsy shop verified (id: ' + etsyShopId + ')' });
    } catch (e) {
      send({ step: 'error', message: '❌ Etsy auth failed: ' + e.message });
      return res.end();
    }

    // ══════════════════════════════════════════════════════════════
    // BOUCLE SUR LES ANNONCES
    // ══════════════════════════════════════════════════════════════
    let listingsCreated = 0;
    let listingIndex    = 0;

    for (const listing of shopListings) {
      listingIndex++;
      send({
        step: 'listing_start',
        status: 'running',
        message: `📋 Listing ${listingIndex}/${shopListings.length}: analyzing...`,
        listingIndex,
      });

      try {
        // ── ÉTAPE 3 : Scrape du listing (titre, prix, 5 images) ──
        send({ step: 'listing_detail', status: 'running', message: '🔍 Fetching listing details...' });
        let detail;
        try {
          detail = await scrapeListingDetail(listing.url);
        } catch (e) {
          send({ step: 'listing_skip', message: `⏩ Listing ${listingIndex}: scrape failed (${e.message}), skipping` });
          continue;
        }

        const firstImage = detail.images[0] || listing.image;
        if (!firstImage) {
          send({ step: 'listing_skip', message: `⏩ Listing ${listingIndex}: no image found, skipping` });
          continue;
        }

        const title = detail.title || listing.title || 'Product';
        const price = detail.price || '9.99';
        send({ step: 'listing_detail', status: 'done', message: `✅ Title: "${title.slice(0,60)}..." | Price: $${price}` });

        // ── ÉTAPE 4 : Google Lens → AliExpress check ──
        send({ step: 'lens_search', status: 'running', message: '🔍 Reverse image search on Google Lens...' });
        let aliMatch;
        try {
          aliMatch = await lensSearchAliExpress(firstImage);
        } catch (e) {
          send({ step: 'listing_skip', message: `⏩ Listing ${listingIndex}: Lens search failed (${e.message}), skipping` });
          continue;
        }

        if (!aliMatch) {
          send({ step: 'listing_skip', message: `⏩ Listing ${listingIndex}: not found on AliExpress, trying next listing...` });
          continue;
        }

        const aliUrl = aliMatch.link || aliMatch.url;
        send({ step: 'lens_search', status: 'done', message: '✅ Found on AliExpress: ' + aliUrl.slice(0, 80) + '...' });

        // ── ÉTAPE 5 : Récupérer les 4 images AliExpress supplémentaires ──
        send({ step: 'ali_images', status: 'running', message: '📸 Fetching AliExpress product images...' });
        let aliImages = [];
        try {
          aliImages = await scrapeAliExpressImages(aliUrl);
        } catch (e) {
          send({ step: 'ali_images', status: 'warn', message: '⚠️ Could not fetch AliExpress images, using Etsy images' });
        }

        // Combiner : image Etsy + images AliExpress (max 5)
        const sourceImages = [firstImage, ...aliImages].slice(0, 5);
        // Compléter avec les autres images Etsy si pas assez
        for (const img of detail.images.slice(1)) {
          if (sourceImages.length >= 5) break;
          if (!sourceImages.includes(img)) sourceImages.push(img);
        }
        send({ step: 'ali_images', status: 'done', message: `✅ ${sourceImages.length} source images collected` });

        // ── ÉTAPE 6 : Transformation avec Leonardo.ai ──
        send({ step: 'leonardo', status: 'running', message: '🎨 Transforming images with Leonardo AI...' });
        const generatedImages = [];
        for (let i = 0; i < sourceImages.length; i++) {
          try {
            send({ step: 'leonardo_progress', message: `🎨 Generating image ${i+1}/${sourceImages.length}...` });
            const genUrl = await transformImageWithLeonardo(sourceImages[i], i);
            generatedImages.push(genUrl);
          } catch (e) {
            console.warn(`Leonardo image ${i+1} failed:`, e.message);
            // Fallback: utiliser l'image source si Leonardo échoue
            generatedImages.push(sourceImages[i]);
          }
        }
        send({ step: 'leonardo', status: 'done', message: `✅ ${generatedImages.length} images generated` });

        // ── ÉTAPE 7 : Génération SEO avec Gemini ──
        send({ step: 'gemini', status: 'running', message: '✍️ Generating SEO content with Gemini...' });
        let seo;
        try {
          seo = await generateSEOWithGemini(title, price);
        } catch (e) {
          send({ step: 'error', message: '❌ Gemini SEO generation failed: ' + e.message });
          return res.end();
        }
        send({
          step: 'gemini', status: 'done',
          message: `✅ SEO generated | Category: ${seo.category}`,
          seo: { title: seo.title, tags: seo.tags, category: seo.category }
        });

        // ── ÉTAPE 8 : Résolution de la catégorie Etsy ──
        send({ step: 'taxonomy', status: 'running', message: '🗂 Resolving Etsy category...' });
        let taxonomyId;
        try {
          taxonomyId = await resolveTaxonomyId(seo.category, etsyToken);
        } catch {
          taxonomyId = 68887469;
        }
        send({ step: 'taxonomy', status: 'done', message: '✅ Taxonomy ID: ' + taxonomyId });

        // ── ÉTAPE 9 : Création du listing Etsy ──
        send({ step: 'create_listing', status: 'running', message: '🛒 Creating Etsy listing...' });
        let newListingId;
        try {
          newListingId = await createEtsyListing(etsyToken, etsyShopId, {
            title:       seo.title,
            description: seo.description,
            tags:        seo.tags,
            price,
            imageUrls:   generatedImages,
            taxonomyId,
          });
        } catch (e) {
          send({ step: 'error', message: '❌ Failed to create Etsy listing: ' + e.message });
          return res.end();
        }

        listingsCreated++;
        send({
          step: 'listing_done',
          status: 'done',
          message: `✅ Listing created on Etsy! (id: ${newListingId}) — ${listingsCreated} total`,
          listingId:    newListingId,
          listingIndex,
          total:        shopListings.length,
          seo,
          aliUrl,
          imagesGenerated: generatedImages.length,
        });

      } catch (listingErr) {
        send({ step: 'listing_error', message: `⚠️ Error on listing ${listingIndex}: ${listingErr.message}, skipping...` });
        continue;
      }
    }

    // ── FIN ──
    send({
      step: 'complete',
      status: 'done',
      message: `🎉 Done! ${listingsCreated} listing(s) created from ${shopListings.length} analyzed.`,
      listingsCreated,
      total: shopListings.length,
    });
    res.end();

  } catch (err) {
    send({ step: 'error', message: '❌ Fatal error: ' + err.message });
    res.end();
  }
});

module.exports = router;



