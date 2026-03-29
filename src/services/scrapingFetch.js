/**
 * scrapingFetch.js
 * Utilisé UNIQUEMENT pour les pages AliExpress (pas d'API officielle).
 * Toutes les requêtes Etsy passent désormais par etsyApi.js.
 */
const axios = require('axios');

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.SCRAPEAPI_KEY;
  if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');

  console.log(`ScraperAPI fetching (AliExpress): ${targetUrl}`);

  try {
    const r = await axios.get('https://api.scraperapi.com', {
      params: {
        api_key: saKey,
        url:     targetUrl,
        ...extraParams,
      },
      timeout: 60000,
    });

    const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`ScraperAPI OK — ${html.length} chars`);
    return html;

  } catch (e) {
    const status = e.response?.status;
    if (status === 401) throw new Error('SCRAPEAPI_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits ScraperAPI épuisés (403)');
    throw new Error(`ScraperAPI failed [${status || e.code}]: ${e.message}`);
  }
}

module.exports = { scraperApiFetch };
