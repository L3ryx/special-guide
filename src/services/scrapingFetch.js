const axios = require('axios');

// Paramètres compatibles avec mode=auto (Adaptive Stealth Mode).
// Tout paramètre absent de cette liste est silencieusement ignoré
// pour éviter les erreurs 400 REQS004.
const AUTO_MODE_ALLOWED = new Set([
  'wait',
  'wait_for',
  'css_extractor',
  'autoparse',
  'response_type',
  'screenshot',
  'screenshot_fullpage',
  'screenshot_selector',
  'screenshot_format',
  'screenshot_quality',
  'json_response',
  'original_status',
  'allowed_status_codes',
  'outputs',
]);

// Filtre et traduit les extraParams vers les paramètres ZenRows compatibles
// avec mode=auto. Les anciens paramètres ScraperAPI sont ignorés proprement.
function mapToZenRowsParams(extraParams) {
  const mapped = {};
  for (const [key, value] of Object.entries(extraParams)) {
    switch (key) {
      // Anciens paramètres ScraperAPI / manuels → ignorés (mode=auto gère tout)
      case 'stealth_proxy':
      case 'render':
      case 'js_render':
      case 'premium_proxy':
      case 'proxy_country':
      case 'session_id':
      case 'custom_headers':
      case 'block_resources':
        break;

      case 'wait':
        mapped.wait = parseInt(value, 10);
        break;

      case 'wait_for':
        mapped.wait_for = String(value);
        break;

      default:
        if (AUTO_MODE_ALLOWED.has(key)) {
          mapped[key] = value;
        } else {
          console.warn(`ZenRows: paramètre ignoré (incompatible mode=auto): ${key}`);
        }
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

