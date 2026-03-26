const axios = require('axios');

// Traduit les anciens paramètres ScraperAPI vers les équivalents ZenRows
function mapToZenRowsParams(extraParams) {
  const mapped = {};
  for (const [key, value] of Object.entries(extraParams)) {
    switch (key) {
      case 'wait':
        mapped.wait = parseInt(value, 10);
        break;
      case 'wait_for':
        mapped.wait_for = String(value);
        break;
      case 'render':
        mapped.js_render = String(value);
        break;
      default:
        mapped[key] = value;
    }
  }
  return mapped;
}

// Détecte si la page retournée est un bloc anti-bot ou une page vide
function isBlockedOrEmpty(html) {
  if (!html || html.length < 500) return true;
  const lower = html.toLowerCase();
  return (
    lower.includes('cf-browser-verification') ||
    lower.includes('enable javascript')        ||
    lower.includes('access denied')            ||
    lower.includes('just a moment')            ||
    lower.includes('checking your browser')    ||
    lower.includes('captcha')                  ||
    lower.includes('robot')                    ||
    (lower.includes('<title>') && lower.includes('403')) ||
    (!lower.includes('listing') && !lower.includes('product'))
  );
}

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.ZENROWS_API_KEY;
  if (!saKey) throw new Error('ZENROWS_API_KEY not configured');

  const zenParams = mapToZenRowsParams(extraParams);

  console.log(`ZenRows [mode auto] fetching: ${targetUrl}`);
  try {
    const r = await axios.get('https://api.zenrows.com/v1/', {
      params: {
        apikey: saKey,
        url:    targetUrl,
        mode:   'auto',
        ...zenParams,
      },
      timeout: 90000,
    });

    const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);

    if (isBlockedOrEmpty(html)) {
      throw new Error(`ZenRows [mode auto] → page bloquée ou vide (${html.length} chars)`);
    }

    console.log(`ZenRows [mode auto] OK — ${html.length} chars`);
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

