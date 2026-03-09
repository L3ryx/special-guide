const express = require('express');
const router = express.Router();

const { scrapeEtsy } = require('../services/etsyScraper');
const { reverseImageSearch } = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress } = require('../services/imageSimilarity');

// GET /api/debug
router.get('/debug', (req, res) => {
  const keys = ['SCRAPEAPI_KEY', 'SERPER_API_KEY', 'OPENAI_API_KEY'];
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
  const { keyword, similarityThreshold = 60, maxCount = 10 } = req.body;

  if (!keyword || keyword.trim() === '') {
    return res.status(400).json({ error: 'Le mot-clé est requis' });
  }

  const missingKeys = [];
  if (!process.env.SCRAPEAPI_KEY || process.env.SCRAPEAPI_KEY.includes('your_')) missingKeys.push('SCRAPEAPI_KEY');
  if (!process.env.SERPER_API_KEY || process.env.SERPER_API_KEY.includes('your_')) missingKeys.push('SERPER_API_KEY');
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('your_')) missingKeys.push('OPENAI_API_KEY');

  if (missingKeys.length > 0) {
    return res.status(500).json({
      error: 'Clés API manquantes : ' + missingKeys.join(', '),
      instructions: 'Sur Render → onglet Environment → ajoutez les variables → Save Changes'
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (step, message, data = null) =>
    res.write('data: ' + JSON.stringify({ step, message, data }) + '\n\n');
  const sendError = msg => { res.write('data: ' + JSON.stringify({ step: 'error', message: msg }) + '\n\n'); res.end(); };
  const sendComplete = results => { res.write('data: ' + JSON.stringify({ step: 'complete', results }) + '\n\n'); res.end(); };

  try {
    // ÉTAPE 1 : Scraping Etsy
    send('scraping_etsy', `🔍 Scraping Etsy pour "${keyword}"...`);
    const etsyListings = await scrapeEtsy(keyword, maxCount);
    if (etsyListings.length === 0) return sendError('Aucune annonce Etsy trouvée');
    send('etsy_done', `✅ ${etsyListings.length} annonces Etsy trouvées`);

    // ÉTAPE 2-5 : Recherche inversée + filtre AliExpress + comparaison IA
    const allResults = [];

    for (let i = 0; i < etsyListings.length; i++) {
      const listing = etsyListings[i];
      if (!listing.image) continue;

      send('reverse_search', `🔎 Recherche inversée ${i + 1}/${etsyListings.length}...`);

      let aliexpressMatches = [];
      try {
        // Recherche directe par image (base64) — pas besoin d'ImgBB
        aliexpressMatches = await reverseImageSearch(listing.image);
        send('aliexpress_found', `🛒 ${aliexpressMatches.length} résultat(s) AliExpress`);
      } catch (err) {
        send('aliexpress_found', `⚠️ Aucun résultat AliExpress pour l'annonce ${i + 1}`);
      }

      if (aliexpressMatches.length === 0) continue;

      send('comparing', `🤖 Comparaison IA pour l'annonce ${i + 1}...`);
      try {
        const comparisons = await compareEtsyWithAliexpress(listing, aliexpressMatches, similarityThreshold);
        if (comparisons.length > 0) {
          allResults.push(...comparisons);
          send('match_found', `✅ ${comparisons.length} correspondance(s) ≥${similarityThreshold}%`);
        }
      } catch (err) {
        console.error('Erreur comparaison:', err.message);
      }

      await new Promise(r => setTimeout(r, 300));
    }

    send('finalizing', `📊 Terminé ! ${allResults.length} correspondance(s)`);
    sendComplete(allResults);

  } catch (error) {
    sendError(error.message || 'Erreur inattendue');
  }
});

// GET /api/health
router.get('/health', (req, res) => {
  const keys = {
    SCRAPEAPI_KEY: !!process.env.SCRAPEAPI_KEY && !process.env.SCRAPEAPI_KEY.includes('your_'),
    SERPER_API_KEY: !!process.env.SERPER_API_KEY && !process.env.SERPER_API_KEY.includes('your_'),
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_')
  };
  const allConfigured = Object.values(keys).every(Boolean);
  res.json({
    status: allConfigured ? 'ready' : 'missing_keys',
    keys,
    message: allConfigured ? '✅ Toutes les clés configurées.' : '⚠️ Clés manquantes.'
  });
});

module.exports = router;
