const express = require('express');
const router = express.Router();

const { scrapeEtsy } = require('../services/etsyScraper');
const { reverseImageSearch } = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress } = require('../services/imageSimilarity');

// Exécute N tâches en parallèle avec concurrence limitée
async function parallel(items, concurrency, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

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
  const { keyword, similarityThreshold = 40, maxCount = 10 } = req.body;

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
  const sendError = msg => {
    res.write('data: ' + JSON.stringify({ step: 'error', message: msg }) + '\n\n');
    res.end();
  };
  const sendComplete = results => {
    res.write('data: ' + JSON.stringify({ step: 'complete', results }) + '\n\n');
    res.end();
  };

  try {
    // ÉTAPE 1 : Scraping Etsy
    send('scraping_etsy', `🔍 Scraping Etsy pour "${keyword}"...`);
    const etsyListings = await scrapeEtsy(keyword, maxCount);
    if (etsyListings.length === 0) return sendError('Aucune annonce Etsy trouvée');
    send('etsy_done', `✅ ${etsyListings.length} annonces Etsy trouvées`);

    // ÉTAPE 2 : Recherche inversée — toutes en parallèle (3 à la fois)
    send('reverse_search', `🔎 Recherche inversée sur ${etsyListings.length} annonces en parallèle...`);

    let searchDone = 0;
    const searchResults = await parallel(
      etsyListings.filter(l => l.image),
      3, // 3 requêtes Serper simultanées
      async (listing) => {
        try {
          const matches = await reverseImageSearch(listing.image, listing.title || '');
          searchDone++;
          send('aliexpress_found', `🛒 ${searchDone}/${etsyListings.length} — ${matches.length} résultat(s) AliExpress`);
          return { listing, matches };
        } catch {
          searchDone++;
          return { listing, matches: [] };
        }
      }
    );

    // Garder uniquement les annonces avec des résultats AliExpress
    const withMatches = searchResults.filter(r => r.matches.length > 0);
    send('comparing', `🤖 Comparaison IA sur ${withMatches.length} annonce(s)...`);

    // ÉTAPE 3 : Comparaison IA — SÉQUENTIELLE pour éviter rate limit OpenAI
    let compareDone = 0;
    const allResults = [];

    for (const { listing, matches } of withMatches) {
      try {
        compareDone++;
        send('comparing', `🤖 Comparaison ${compareDone}/${withMatches.length}...`);
        const comparisons = await compareEtsyWithAliexpress(listing, matches, similarityThreshold);
        if (comparisons.length > 0) {
          allResults.push(...comparisons);
          send('match_found', `✅ Match trouvé — ${allResults.length} total`);
        }
      } catch (err) {
        console.error('Erreur comparaison:', err.message);
      }
      // Délai entre chaque appel OpenAI
      await new Promise(r => setTimeout(r, 1000));
    }

    send('finalizing', `📊 Terminé ! ${allResults.length} correspondance(s)`);

    // Dédupliquer : une seule paire Etsy+AliExpress unique
    const seen = new Set();
    const deduplicated = allResults
      .sort((a, b) => b.similarity - a.similarity)
      .filter(r => {
        const key = (r.etsy.link || '') + '||' + (r.aliexpress.link || '');
        if (seen.has(key)) return false;
        seen.add(key);
        // Aussi dédupliquer par lien AliExpress seul (évite même produit Ali avec différents Etsy)
        const aliKey = r.aliexpress.link || '';
        if (seen.has('ali:' + aliKey)) return false;
        seen.add('ali:' + aliKey);
        return true;
      });

    sendComplete(deduplicated);

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
