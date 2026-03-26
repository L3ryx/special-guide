const axios = require('axios');

// Traduit les anciens paramètres ScraperAPI vers les équivalents ZenRows
function mapToZenRowsParams(extraParams) {
  const mapped = {};
  for (const [key, value] of Object.entries(extraParams)) {
    switch (key) {
      case 'stealth_proxy':
        // stealth_proxy=true → js_render=true + premium_proxy=true chez ZenRows
        if (value === 'true' || value === true) {
          mapped.js_render      = 'true';
          mapped.premium_proxy  = 'true';
        }
        break;
      case 'wait':
        // wait=ms → wait_for=ms (même sémantique)
        mapped.wait_for = String(value);
        break;
      case 'render':
        mapped.js_render = String(value);
        break;
      default:
        // Passe les paramètres ZenRows natifs tels quels
        mapped[key] = value;
    }
  }
  return mapped;
}

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.ZENROWS_API_KEY;
  if (!saKey) throw new Error('ZENROWS_API_KEY not configured');

  console.log(`ZenRows fetching: ${targetUrl}`);

  const zenParams = mapToZenRowsParams(extraParams);

  try {
    const r = await axios.get('https://api.zenrows.com/v1/', {
      params: {
        apikey: saKey,
        url:    targetUrl,
        ...zenParams,
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
