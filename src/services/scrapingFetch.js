const axios = require('axios');

// ─────────────────────────────────────────────────────────────────────────────
// Zyte API — fetch avec stratégie de fallback en cascade
//
// Zyte API utilise l'authentification HTTP Basic (clé en username, password vide)
// et un endpoint POST unique : https://api.zyte.com/v1/extract
//
// Stratégie par type de page :
//
//   Pages de recherche Etsy (/search?) — très protégées :
//     1. browserHtml  (rendu JS, proxy standard)
//     2. browserHtml  + actions wait (rendu JS avec attente étendue)
//     3. browserHtml  + geolocation US (proxy résidentiel US)
//
//   Pages boutique Etsy (/shop/) — plus légères :
//     1. httpResponseBody  (pas de JS — rapide et peu coûteux)
//     2. browserHtml       (rendu JS si le rendu simple échoue)
//     3. browserHtml       + geolocation US
// ─────────────────────────────────────────────────────────────────────────────

const ZYTE_ENDPOINT = 'https://api.zyte.com/v1/extract';
const TIMEOUT_MS    = 90_000;

// ── Détection anti-bot ───────────────────────────────────────────────────────
function isBlocked(html, label) {
  if (!html || html.length < 2000) {
    console.warn(`[Zyte] ${label} → réponse trop courte (${html?.length ?? 0} chars)`);
    return true;
  }
  const lower = html.toLowerCase();
  const blocked = (
    lower.includes('cf-browser-verification')       ||
    lower.includes('just a moment...')              ||
    lower.includes('checking your browser')         ||
    lower.includes('enable javascript and cookies') ||
    lower.includes('access denied')                 ||
    lower.includes('<title>403</title>')            ||
    lower.includes('captcha')
  );
  if (blocked) {
    console.warn(`[Zyte] ${label} → mur anti-bot détecté (${html.length} chars)`);
  }
  return blocked;
}

// ── Requête Zyte API unique ──────────────────────────────────────────────────
async function zyteRequest(targetUrl, payload, label) {
  const apiKey = process.env.ZYTE_API_KEY;
  if (!apiKey) throw new Error('ZYTE_API_KEY non configurée');

  console.log(`Zyte [${label}] fetching: ${targetUrl}`);

  let response;
  try {
    response = await axios.post(
      ZYTE_ENDPOINT,
      { url: targetUrl, ...payload },
      {
        auth:    { username: apiKey, password: '' },
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (e) {
    const status = e.response?.status;
    const body   = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    if (status === 401) throw new Error('ZYTE_API_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits Zyte épuisés ou accès refusé (403)');
    if (status === 400) throw new Error(`Zyte requête invalide (400): ${body}`);
    if (status === 429) throw new Error('Zyte rate limit (429)');
    if (status === 422) throw new Error(`Zyte unprocessable (422): ${body}`);
    throw new Error(`Zyte failed [${status ?? e.code}]: ${e.message}`);
  }

  // Zyte renvoie le HTML dans `browserHtml` ou `httpResponseBody` (base64)
  let html = null;

  if (payload.browserHtml && response.data.browserHtml) {
    html = response.data.browserHtml;
  } else if (payload.httpResponseBody && response.data.httpResponseBody) {
    // httpResponseBody est encodé en base64
    html = Buffer.from(response.data.httpResponseBody, 'base64').toString('utf-8');
  }

  if (!html) {
    throw new Error(`Zyte [${label}] → champ HTML absent dans la réponse`);
  }

  if (isBlocked(html, label)) {
    throw new Error(`Zyte [${label}] → page bloquée ou vide (${html.length} chars)`);
  }

  console.log(`Zyte [${label}] OK — ${html.length} chars`);
  return html;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function isFatal(e) {
  const msg = e.message || '';
  return (
    msg.includes('401') ||
    msg.includes('ZYTE_API_KEY invalide') ||
    msg.includes('Crédits Zyte épuisés')
  );
}

function extractStatus(e) {
  const m = (e.message || '').match(/\b([45]\d{2})\b/);
  return m ? m[1] : 'err';
}

// ── Point d'entrée principal ─────────────────────────────────────────────────
async function scraperApiFetch(targetUrl /*, extraParams ignorés */) {
  const isSearchPage = targetUrl.includes('/search?') || targetUrl.includes('/search/');
  const isShopPage   = targetUrl.includes('/shop/');

  // ── Pages boutique (légères) ──
  if (isShopPage && !isSearchPage) {
    // Tentative 1 : httpResponseBody (pas de JS — rapide)
    try {
      return await zyteRequest(targetUrl, {
        httpResponseBody: true,
        httpResponseHeaders: true,
      }, 'httpBody');
    } catch (e) {
      if (isFatal(e)) throw e;
      console.warn(`Zyte [httpBody] erreur (${extractStatus(e)}), passage en browserHtml…`);
    }

    // Tentative 2 : browserHtml (rendu JS complet)
    try {
      return await zyteRequest(targetUrl, {
        browserHtml: true,
      }, 'browserHtml');
    } catch (e) {
      if (isFatal(e)) throw e;
      console.warn(`Zyte [browserHtml] erreur (${extractStatus(e)}), passage en browserHtml+géoloc…`);
    }

    // Tentative 3 : browserHtml + proxy US
    return await zyteRequest(targetUrl, {
      browserHtml:  true,
      geolocation:  'US',
    }, 'browserHtml+US');
  }

  // ── Pages de recherche (très protégées) ──
  // Tentative 1 : browserHtml standard
  try {
    return await zyteRequest(targetUrl, {
      browserHtml: true,
    }, 'browserHtml');
  } catch (e) {
    if (isFatal(e)) throw e;
    console.warn(`Zyte [browserHtml] échec, essai avec actions wait…`);
  }

  // Tentative 2 : browserHtml + actions (attendre que les listings chargent)
  try {
    return await zyteRequest(targetUrl, {
      browserHtml: true,
      actions: [
        { action: 'waitForSelector', selector: { type: 'css', value: '[data-listing-id]' }, timeout: 10 },
      ],
    }, 'browserHtml+wait');
  } catch (e) {
    if (isFatal(e)) throw e;
    console.warn(`Zyte [browserHtml+wait] échec, passage en browserHtml+géoloc US…`);
  }

  // Tentative 3 : browserHtml + proxy résidentiel US
  return await zyteRequest(targetUrl, {
    browserHtml: true,
    geolocation: 'US',
    actions: [
      { action: 'waitForSelector', selector: { type: 'css', value: '[data-listing-id]' }, timeout: 10 },
    ],
  }, 'browserHtml+US');
}

module.exports = { scraperApiFetch };

