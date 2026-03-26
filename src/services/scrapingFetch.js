const axios = require('axios');

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.ZENROWS_API_KEY;
  if (!saKey) throw new Error('ZENROWS_API_KEY not configured');

  console.log(`ZenRows fetching: ${targetUrl}`);

  try {
    const r = await axios.get('https://api.zenrows.com/v1/', {
      params: {
        apikey:  saKey,
        url:     targetUrl,
        ...extraParams,
      },
      timeout: 60000,
    });

    const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`ZenRows OK — ${html.length} chars`);
    return html;

  } catch (e) {
    const status = e.response?.status;
    if (status === 401) throw new Error('ZENROWS_API_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits ZenRows épuisés (403)');
    throw new Error(`ZenRows failed [${status || e.code}]: ${e.message}`);
  }
}

module.exports = { scraperApiFetch };
