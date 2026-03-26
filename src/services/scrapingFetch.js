const axios = require('axios');

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.SCRAPEAPI_KEY;
  if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');

  const isShop   = targetUrl.includes('etsy.com/shop');
  const isSearch = targetUrl.includes('etsy.com/search');
  const sessionNumber = Math.floor(Math.random() * 99999);

  // Stratégies progressives : chaque tentative est plus agressive
  const strategies = [
    { render: 'false', premium_proxy: 'false', country_code: 'us', timeout: 60000 },
    { render: 'false', premium_proxy: 'true',  country_code: 'us', timeout: 70000 },
    { render: (isShop || isSearch) ? 'true' : 'false', premium_proxy: 'true', country_code: 'us', timeout: 90000 },
    { render: 'true',  premium_proxy: 'true',  country_code: 'fr', timeout: 90000 },
  ];

  let lastError = null;

  for (let attempt = 0; attempt < strategies.length; attempt++) {
    const strat = strategies[attempt];
    try {
      const r = await axios.get('https://api.scraperapi.com', {
        params: {
          api_key:        saKey,
          url:            targetUrl,
          session_number: sessionNumber,
          keep_headers:   'true',
          ...strat,
          ...extraParams,
        },
        timeout: strat.timeout,
      });

      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);

      if (html.length > 500 && !html.includes('"error"') && !html.includes('Access Denied')) {
        console.log(`ScraperAPI OK — attempt ${attempt + 1}, ${html.length} chars`);
        return html;
      }
      console.warn(`ScraperAPI attempt ${attempt + 1} — bad response (${html.length} chars)`);
      lastError = new Error('Response too short or blocked');

    } catch (e) {
      const status = e.response?.status;
      const code   = e.code;

      if (status === 401) throw new Error('SCRAPEAPI_KEY invalide (401)');
      if (status === 403) throw new Error('Crédits ScraperAPI épuisés (403) — rechargez votre compte');

      if (status === 504 || code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        console.warn(`ScraperAPI attempt ${attempt + 1} timeout (${status || code}) — next strategy`);
      } else if (status === 500) {
        console.warn(`ScraperAPI attempt ${attempt + 1} server error 500 — retrying`);
      } else {
        console.warn(`ScraperAPI attempt ${attempt + 1} failed [${status || code}]:`, e.message.slice(0, 100));
      }
      lastError = e;
    }

    if (attempt < strategies.length - 1) {
      const delay = 3000 * (attempt + 1);
      console.log(`Retrying in ${delay / 1000}s... (strategy ${attempt + 2})`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error(`ScraperAPI failed after ${strategies.length} attempts — ${lastError?.message || 'unknown error'}`);
}

module.exports = { scraperApiFetch };
