const express = require('express');
const router = express.Router();

const { scrapeEtsy } = require('../services/etsyScraper');
const { uploadMultipleToImgBB } = require('../services/imgbbUploader');
const { reverseImageSearch } = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress } = require('../services/imageSimilarity');

// GET /api/debug — vérifie les variables d'environnement
router.get('/debug', (req, res) => {
  const keys = ['SCRAPEAPI_KEY', 'IMGBB_API_KEY', 'SERPER_API_KEY', 'OPENAI_API_KEY'];
  const status = {};
  for (const key of keys) {
    const val = process.env[key];
    if (!val) status[key] = 'UNDEFINED';
    else if (val.includes('your_')) status[key] = 'VALEUR_PAR_DEFAUT';
    else status[key] = 'OK (' + val.substring(0, 6) + '...)';
  }
  res.json({ keys: status, port: process.env.PORT || '3000' });
});

// POST /api/search
router.post('/search', async (req, res) => {
  const { keyword, similarityThreshold = 60 } = req.body;

  if (!keyword || keyword.trim() === '') {
    return res.status(400).json({ error: 'Le mot-clé est requis' });
  }

  const missingKeys = [];
  if (!process.env.SCRAPEAPI_KEY || process.env.SCRAPEAPI_KEY.includes('your_')) missingKeys.push('SCRAPEAPI_KEY');
  if (!process.env.IMGBB_API_KEY || process.env.IMGBB_API_KEY.includes('your_')) missingKeys.push('IMGBB_API_KEY');
  if (!process.env.SERPER_API_KEY || process.env.SERPER_API_KEY.includes('your_')) missingKeys.push('SERPER_API_KEY');
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('your_')) missingKeys.push('OPENAI_API_KEY');

  if (missingKeys.length > 0) {
    return res.status(500).json({
      error: 'Clés API manquantes : ' + missingKeys.join(', '),
      instructions: 'Sur Render → onglet Environment → ajoutez les variables → Save Changes',
      debug_url: '/api/debug'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (step, message, data = null) => {
    res.write('data: ' + JSON.stringify({ step, message, data }) + '\n\n');
  };
  const sendError = (message) => {
    res.write('data: ' + JSON.stringify({ step: 'error', message }) + '\n\n');
    res.end();
  };
  const sendComplete = (results) => {
    res.write('data: ' + JSON.stringify({ step: 'complete', results }) + '\n\n');
    res.end();
  };

  try {
    sendProgress('scraping_etsy', '🔍 Scraping Etsy pour "' + keyword + '"...');
    const etsyListings = await scrapeEtsy(keyword);
    if (etsyListings.length === 0) return sendError('Aucune annonce Etsy trouvée');
    sendProgress('etsy_done', '✅ ' + etsyListings.length + ' annonces Etsy trouvées');

    sendProgress('uploading_images', '📤 Upload des images sur ImgBB...');
    const imageUrls = etsyListings.map(l => l.image).filter(Boolean);
    const hostedUrls = await uploadMultipleToImgBB(imageUrls);
    let imgIdx = 0;
    for (const listing of etsyListings) {
      if (listing.image) { listing.hostedImageUrl = hostedUrls[imgIdx] || listing.image; imgIdx++; }
    }
    sendProgress('images_uploaded', '✅ Images hébergées sur ImgBB');

    const allResults = [];
    for (let i = 0; i < etsyListings.length; i++) {
      const listing = etsyListings[i];
      if (!listing.hostedImageUrl && !listing.image) continue;

      sendProgress('reverse_search', '🔎 Recherche inversée ' + (i+1) + '/' + etsyListings.length);
      let aliexpressMatches = [];
      try {
        aliexpressMatches = await reverseImageSearch(listing.hostedImageUrl || listing.image);
        sendProgress('aliexpress_found', '🛒 ' + aliexpressMatches.length + ' résultat(s) AliExpress');
      } catch (err) {
        sendProgress('aliexpress_found', '⚠️ Aucun résultat AliExpress');
      }

      if (aliexpressMatches.length === 0) continue;

      sendProgress('comparing', '🤖 Comparaison IA en cours...');
      try {
        const comparisons = await compareEtsyWithAliexpress(listing, aliexpressMatches, similarityThreshold);
        if (comparisons.length > 0) {
          allResults.push(...comparisons);
          sendProgress('match_found', '✅ ' + comparisons.length + ' correspondance(s) ≥' + similarityThreshold + '%');
        }
      } catch (err) {
        console.error('Erreur comparaison:', err.message);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    sendProgress('finalizing', '📊 Terminé ! ' + allResults.length + ' correspondance(s)');
    sendComplete(allResults);
  } catch (error) {
    sendError(error.message || 'Erreur inattendue');
  }
});

// GET /api/health
router.get('/health', (req, res) => {
  const keys = {
    SCRAPEAPI_KEY: !!process.env.SCRAPEAPI_KEY && !process.env.SCRAPEAPI_KEY.includes('your_'),
    IMGBB_API_KEY: !!process.env.IMGBB_API_KEY && !process.env.IMGBB_API_KEY.includes('your_'),
    SERPER_API_KEY: !!process.env.SERPER_API_KEY && !process.env.SERPER_API_KEY.includes('your_'),
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_')
  };
  const allConfigured = Object.values(keys).every(Boolean);
  res.json({
    status: allConfigured ? 'ready' : 'missing_keys',
    keys,
    message: allConfigured ? '✅ Toutes les clés configurées.' : '⚠️ Clés manquantes — vérifiez Render > Environment.'
  });
});

module.exports = router;
