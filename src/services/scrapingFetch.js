const axios = require('axios');

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.SCRAPEAPI_KEY;
  if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');

  console.log(`ScraperAPI fetching: ${targetUrl}`);

  // Pages de recherche Etsy : render=true obligatoire pour bypasser Cloudflare
  const isEtsySearch = targetUrl.includes('etsy.com/search');

  try {
    const r = await axios.get('https://api.scraperapi.com', {
      params: {
        api_key:      saKey,
        url:          targetUrl,
        render:       isEtsySearch ? 'true' : undefined,
        country_code: isEtsySearch ? 'us'   : undefined,
        ...extraParams,
      },
      timeout: isEtsySearch ? 90000 : 60000,
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
