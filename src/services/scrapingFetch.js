const axios = require('axios');

// Traduit les anciens paramètres ScraperAPI vers les équivalents ZenRows
function mapToZenRowsParams(extraParams) {
  const mapped = {};
  for (const [key, value] of Object.entries(extraParams)) {
    switch (key) {
      case 'stealth_proxy':
        // stealth_proxy=true → js_render=true + premium_proxy=true chez ZenRows
        if (value === 'true' || value === true) {
          mapped.js_render     = 'true';
          mapped.premium_proxy = 'true';
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

  const zenParams = mapToZenRowsParams(extraParams);
  const hasJsRender = zenParams.js_render === 'true';

  console.log(`ZenRows fetching: ${targetUrl}${hasJsRender ? ' [js_render]' : ''}`);

  try {
    const r = await axios.get('https://api.zenrows.com/v1/', {
      params: {
        apikey: saKey,
        url:    targetUrl,
        ...zenParams,
      },
      // js_render (rendu headless) nécessite plus de temps
      timeout: hasJsRender ? 120000 : 60000,
    });

    const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`ZenRows OK — ${html.length} chars`);
    return html;

  } catch (e) {
    const status  = e.response?.status;
    const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
    if (status === 401) throw new Error('ZENROWS_API_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits ZenRows épuisés (403)');
    if (status === 400) throw new Error(`ZenRows requête invalide (400): ${errBody}`);
    throw new Error(`ZenRows failed [${status || e.code}]: ${e.message}`);
  }
}

module.exports = { scraperApiFetch };
