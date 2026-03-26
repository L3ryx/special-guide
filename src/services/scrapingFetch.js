const axios = require('axios');

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.SCRAPEAPI_KEY;
  if (!saKey) throw new Error('SCRAPEAPI_KEY not configured');

  const sessionNumber = Math.floor(Math.random() * 9999);
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const r = await axios.get('https://api.scraperapi.com', {
        params: {
          api_key:        saKey,
          url:            targetUrl,
          render:         'false',
          country_code:   'us',
          session_number: sessionNumber,
          keep_headers:   'true',
          ...extraParams,
        },
        timeout: 70000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) {
        console.log('ScraperAPI OK —', html.length, 'chars (attempt', attempt + ')');
        return html;
      }
      console.warn('ScraperAPI attempt', attempt, '— response too short:', html.length, 'chars');
    } catch (e) {
      const status = e.response?.status;
      if (status === 401) throw new Error('SCRAPEAPI_KEY invalid (401)');
      if (status === 403) throw new Error('ScraperAPI credits exhausted (403)');
      console.warn(`ScraperAPI attempt ${attempt}/${MAX_ATTEMPTS} failed:`, e.message.slice(0, 100));
      if (attempt < MAX_ATTEMPTS) {
        const delay = 5000 * attempt;
        console.log(`Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error('ScraperAPI failed after ' + MAX_ATTEMPTS + ' attempts — check SCRAPEAPI_KEY');
}

module.exports = { scraperApiFetch };
