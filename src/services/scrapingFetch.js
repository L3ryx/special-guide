const axios = require('axios');

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
    const content = r.data?.results?.[0]?.content;
    const html = typeof content === 'string' ? content : JSON.stringify(r.data);

    if (isBlockedOrEmpty(html)) {
      throw new Error(`Decodo → page bloquée ou vide (${html.length} chars)`);
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

