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
        // 'wait' ZenRows = millisecondes fixes après le chargement (integer)
        mapped.wait = parseInt(value, 10);
        break;
      case 'wait_for':
        // 'wait_for' ZenRows = CSS selector à attendre dans le DOM
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
    lower.includes('just a moment')            || // Cloudflare
    lower.includes('checking your browser')    ||
    lower.includes('captcha')                  ||
    lower.includes('robot')                    ||
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

  // ── Gestion des erreurs fatales partagée ──────────────────────────────────
  function handleFatalErrors(e, label) {
    const status  = e.response?.status;
    const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
    if (status === 401) throw new Error('ZENROWS_API_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits ZenRows épuisés (403)');
    if (status === 400) throw new Error(`ZenRows requête invalide (400) [${label}]: ${errBody}`);
    return status; // non fatal → on continue
  }

  // ── TENTATIVE 1 : requête légère (sans js_render) sauf si forcé ──────────
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
      console.warn('ZenRows [mode léger] → page bloquée/vide, passage en mode adaptatif…');
    } catch (e) {
      const status = handleFatalErrors(e, 'mode léger');
      console.warn(`ZenRows [mode léger] erreur (${status || e.code}), passage en mode adaptatif…`);
    }
  }

  // ── TENTATIVE 2 : Adaptive Stealth Mode (mode=auto) ──────────────────────
  // ZenRows choisit automatiquement les meilleurs paramètres anti-bot.
  // Moins coûteux en crédits que js_render + premium_proxy manuels.
  console.log(`ZenRows [mode adaptatif] fetching: ${targetUrl}`);
  try {
    const html = await zenRowsRequest(targetUrl, {
      apikey: saKey,
      url:    targetUrl,
      mode:   'auto',          // Adaptive Stealth Mode
      ...(zenParams.wait     ? { wait:     zenParams.wait     } : {}),
      ...(zenParams.wait_for ? { wait_for: zenParams.wait_for } : {}),
    }, 90000);

    if (!isBlockedOrEmpty(html)) {
      console.log(`ZenRows [mode adaptatif] OK — ${html.length} chars`);
      return html;
    }
    console.warn('ZenRows [mode adaptatif] → page bloquée/vide, passage en mode furtif complet…');
  } catch (e) {
    const status = handleFatalErrors(e, 'mode adaptatif');
    console.warn(`ZenRows [mode adaptatif] erreur (${status || e.code}), passage en mode furtif complet…`);
  }

  // ── TENTATIVE 3 : mode furtif complet (js_render + premium_proxy) ─────────
  console.log(`ZenRows [mode furtif] fetching: ${targetUrl}`);
  try {
    const html = await zenRowsRequest(targetUrl, {
      apikey:        saKey,
      url:           targetUrl,
      js_render:     'true',
      premium_proxy: 'true',
      ...(zenParams.wait     ? { wait:     zenParams.wait     } : {}),
      ...(zenParams.wait_for ? { wait_for: zenParams.wait_for } : { wait: 1500 }),
    }, 120000);

    console.log(`ZenRows [mode furtif] OK — ${html.length} chars`);
    return html;

  } catch (e) {
    const status  = e.response?.status;
    const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
    if (status === 401) throw new Error('ZENROWS_API_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits ZenRows épuisés (403)');
    if (status === 400) throw new Error(`ZenRows requête invalide (400) [mode furtif]: ${errBody}`);
    throw new Error(`ZenRows failed [${status || e.code}]: ${e.message}`);
  }
}

module.exports = { scraperApiFetch };

