const axios = require('axios');

// Traduit les anciens paramètres ScraperAPI vers les équivalents ZenRows
function mapToZenRowsParams(extraParams) {
  const mapped = {};
  for (const [key, value] of Object.entries(extraParams)) {
    switch (key) {
      case 'stealth_proxy':
        if (value === 'true' || value === true) {
          mapped.js_render     = 'true';
          mapped.premium_proxy = 'true';
        }
        break;
      case 'wait':
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
    lower.includes('enable javascript') ||
    lower.includes('access denied') ||
    lower.includes('just a moment') ||       // Cloudflare
    lower.includes('checking your browser') ||
    lower.includes('captcha') ||
    lower.includes('robot') ||
    (lower.includes('<title>') && lower.includes('403')) ||
    // Page Etsy vide = pas de listing
    (!lower.includes('listing') && !lower.includes('product'))
  );
}

async function zenRowsRequest(targetUrl, params, timeoutMs) {
  const r = await axios.get('https://api.zenrows.com/v1/', {
    params,
    timeout: timeoutMs,
  });
  return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
}

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const saKey = process.env.ZENROWS_API_KEY;
  if (!saKey) throw new Error('ZENROWS_API_KEY not configured');

  const zenParams = mapToZenRowsParams(extraParams);
  const forceJsRender = zenParams.js_render === 'true';

  // ── TENTATIVE 1 : requête légère (sans js_render) sauf si forcé
  if (!forceJsRender) {
    console.log(`ZenRows [mode léger] fetching: ${targetUrl}`);
    try {
      const html = await zenRowsRequest(targetUrl, {
        apikey: saKey,
        url:    targetUrl,
        ...zenParams,
      }, 60000);

      if (!isBlockedOrEmpty(html)) {
        console.log(`ZenRows [mode léger] OK — ${html.length} chars`);
        return html;
      }
      console.warn(`ZenRows [mode léger] → page bloquée/vide, passage en mode furtif…`);
    } catch (e) {
      const status = e.response?.status;
      // Erreurs fatales : on ne réessaie pas
      if (status === 401) throw new Error('ZENROWS_API_KEY invalide (401)');
      if (status === 403) throw new Error('Crédits ZenRows épuisés (403)');
      if (status === 400) {
        const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
        throw new Error(`ZenRows requête invalide (400): ${errBody}`);
      }
      console.warn(`ZenRows [mode léger] erreur (${status || e.code}), passage en mode furtif…`);
    }
  }

  // ── TENTATIVE 2 : mode furtif complet (js_render + premium_proxy)
  console.log(`ZenRows [mode furtif] fetching: ${targetUrl}`);
  try {
    const html = await zenRowsRequest(targetUrl, {
      apikey:        saKey,
      url:           targetUrl,
      js_render:     'true',
      premium_proxy: 'true',
      wait_for:      zenParams.wait_for || '1500',
    }, 120000);

    console.log(`ZenRows [mode furtif] OK — ${html.length} chars`);
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
