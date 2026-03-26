const axios = require('axios');

/**
 * Fetch a URL via ScraperAPI with retry + exponential backoff.
 * FIX: render=false pour Etsy (moins de bans), session sticky, https
 */
async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.SCRAPEAPI_KEY;
  if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');

  const MAX_ATTEMPTS = 3;

  // Session sticky : même IP pour toute la session (réduit les bans Etsy)
  const sessionNumber = Math.floor(Math.random() * 9999);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get('https://api.scraperapi.com', {  // ✅ HTTPS
        params: {
          api_key:        saKey,
          url:            targetUrl,
          render:         'false',       // ✅ false = moins de bans, 10x plus rapide
          country_code:   'us',
          session_number: sessionNumber, // ✅ IP sticky entre les pages
          keep_headers:   'true',
          ...extraParams,
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
        timeout: 70000,
      });

      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) {
        console.log(`ScraperAPI OK — ${html.length} chars (attempt ${attempt})`);
        return html;
      }
      console.warn(`ScraperAPI attempt ${attempt} — response too short: ${html.length} chars`);
    } catch (e) {
      const status = e.response?.status;

      if (status === 401) throw new Error('SCRAPEAPI_KEY invalid (401)');
      if (status === 403) throw new Error('ScraperAPI credits exhausted (403)');
      if (status === 404) throw new Error('URL not found (404)');

      console.warn(`ScraperAPI attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e.message.slice(0, 120)}`);

      if (attempt < MAX_ATTEMPTS) {
        const delay = 8000 * attempt; // Backoff : 8s, 16s
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  throw new Error(`ScraperAPI failed after ${MAX_ATTEMPTS} attempts — check your SCRAPEAPI_KEY and credits`);
}

module.exports = { scraperApiFetch };
