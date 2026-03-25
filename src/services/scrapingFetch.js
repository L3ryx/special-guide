const axios = require('axios');

async function scrapingbeeFetch(targetUrl, sbParams = {}) {
  const sbKey = process.env.SCRAPINGBEE_KEY;
  if (sbKey) {
    try {
      const r = await axios.get('https://app.scrapingbee.com/api/v1/', {
        params: { api_key: sbKey, url: targetUrl, country_code: 'us', timeout: '45000', ...sbParams },
        timeout: 120000,
      });
      const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
      if (html.length > 500) { console.log('ScrapingBee OK —', html.length, 'chars'); return html; }
    } catch (e) {
      console.warn('ScrapingBee failed (' + e.response?.status + ') — trying ScraperAPI:', e.message.slice(0, 80));
    }
  }
  const saKey = process.env.SCRAPEAPI_KEY;
  if (saKey) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const r = await axios.get('http://api.scraperapi.com', {
          params: { api_key: saKey, url: targetUrl, render: 'true', country_code: 'us' },
          timeout: 90000,
        });
        const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
        if (html.length > 500) { console.log('ScraperAPI OK —', html.length, 'chars'); return html; }
      } catch (e) {
        console.warn('ScraperAPI attempt', attempt, 'failed:', e.message.slice(0, 80));
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  throw new Error('All scrapers failed — check SCRAPINGBEE_KEY, SCRAPEAPI_KEY');
}

module.exports = { scrapingbeeFetch };
