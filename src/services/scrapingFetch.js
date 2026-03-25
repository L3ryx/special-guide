const axios = require('axios');

/**
 * Fetch a URL via ScraperAPI with retry + exponential backoff.
 * Handles 499 (target closed connection) by retrying up to 3 times.
 */
async function scraperApiFetch(targetUrl, sbParams = {}) {
  const saKey = process.env.SCRAPEAPI_KEY;
  if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');

  const MAX_ATTEMPTS = 4;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get('https://api.scraperapi.com', {
        params: {
          api_key:      saKey,
          url:          targetUrl,
          render:       'true',      // rendu JS (headless browser)
          country_code: 'us',        // IPs US pour Etsy
          keep_headers: 'true',      // conserve les headers d'origine
        },
        timeout: 75000, // 75s > les 70s de retry ScraperAPI
      });

      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) {
        console.log('ScraperAPI OK —', html.length, 'chars (attempt', attempt + ')');
        return html;
      }
      console.warn('ScraperAPI attempt', attempt, '— response too short:', html.length, 'chars');
    } catch (e) {
      const status = e.response?.status;

      // Erreurs fatales — inutile de réessayer
      if (status === 401) throw new Error('SCRAPEAPI_KEY invalid (401)');
      if (status === 403) throw new Error('ScraperAPI credits exhausted (403)');

      console.warn(`ScraperAPI attempt ${attempt}/${MAX_ATTEMPTS} failed:`, e.message.slice(0, 100));

      if (attempt < MAX_ATTEMPTS) {
        // Backoff : 5s, 10s, 20s
        const delay = 5000 * attempt;
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`ScraperAPI failed after ${MAX_ATTEMPTS} attempts — check SCRAPEAPI_KEY`);
}

module.exports = { scraperApiFetch };
