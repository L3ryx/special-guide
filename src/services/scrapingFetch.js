const axios = require('axios');

// Détecte si la page retournée est un vrai blocage anti-bot
// NE PAS rejeter sur l'absence de mots-clés métier : Etsy embarque ses données
// en JSON dans des balises <script> sans texte visible "listing" / "product"
function isHardBlocked(html) {
  if (!html || html.length < 2000) return true;
  const lower = html.toLowerCase();
  // Vrais indicateurs de blocage
  const blocked =
    lower.includes('cf-browser-verification') ||
    lower.includes('just a moment...')         ||
    lower.includes('checking your browser')    ||
    lower.includes('enable javascript and cookies') ||
    lower.includes('_cf_chl_opt')              ||
    lower.includes('captcha')                  ||
    (lower.includes('access denied') && lower.length < 20000);
  return blocked;
}

async function scraperApiFetch(targetUrl, extraParams = {}) {
  const apiToken = process.env.DECODO_API_TOKEN;
  if (!apiToken) throw new Error('DECODO_API_TOKEN not configured');

  // Decodo API : POST https://scraper-api.decodo.com/v2/scrape
  // Auth : Authorization: Basic <token>
  // headless: 'html' active le rendu JS (headless Chrome)
  const body = {
    url:      targetUrl,
    target:   'universal',
    headless: 'html',
    ...extraParams,
  };

  console.log(`Decodo fetching: ${targetUrl}`);
  try {
    const r = await axios.post('https://scraper-api.decodo.com/v2/scrape', body, {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${apiToken}`,
      },
      timeout: 150000,
    });

    // La réponse Decodo : { results: [{ content, status_code, ... }] }
    const result     = r.data?.results?.[0];
    const statusCode = result?.status_code;
    const html       = typeof result?.content === 'string' ? result.content : JSON.stringify(r.data);

    console.log(`Decodo response — status_code: ${statusCode}, size: ${html.length} chars`);

    if (statusCode && statusCode >= 400) {
      throw new Error(`Decodo → status HTTP ${statusCode} reçu pour ${targetUrl}`);
    }

    if (isHardBlocked(html)) {
      throw new Error(`Decodo → page bloquée (anti-bot détecté, ${html.length} chars)`);
    }

    console.log(`Decodo OK — ${html.length} chars`);
    return html;

  } catch (e) {
    if (e.message.includes('Decodo →')) throw e; // re-throw nos erreurs métier
    const status  = e.response?.status;
    const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
    if (status === 401) throw new Error('DECODO_API_TOKEN invalide (401)');
    if (status === 403) throw new Error('Crédits Decodo épuisés (403)');
    if (status === 400) throw new Error(`Decodo requête invalide (400): ${errBody}`);
    throw new Error(`Decodo failed [${status || e.code}]: ${e.message}`);
  }
}

module.exports = { scraperApiFetch };

