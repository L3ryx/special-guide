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
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) throw new Error('SCRAPINGDOG_API_KEY not configured');

  // ScrapingDog params
  // dynamic=true active le rendu JS (headless Chrome)
  // premium=true active les proxies premium pour les sites difficiles
  const params = {
    api_key: apiKey,
    url:     targetUrl,
    dynamic: true,
    premium: false,
    ...extraParams,
  };

  console.log(`ScrapingDog fetching: ${targetUrl}`);
  try {
    const r = await axios.get('https://api.scrapingdog.com/scrape', {
      params,
      timeout: 90000,
    });

    const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);

    if (isBlockedOrEmpty(html)) {
      // Retry avec premium=true si bloqué
      console.warn(`ScrapingDog → page bloquée ou vide (${html.length} chars), retry premium...`);
      const r2 = await axios.get('https://api.scrapingdog.com/scrape', {
        params: { ...params, premium: true },
        timeout: 90000,
      });
      const html2 = typeof r2.data === 'string' ? r2.data : JSON.stringify(r2.data);
      if (isBlockedOrEmpty(html2)) {
        throw new Error(`ScrapingDog → page bloquée ou vide même en premium (${html2.length} chars)`);
      }
      console.log(`ScrapingDog premium OK — ${html2.length} chars`);
      return html2;
    }

    console.log(`ScrapingDog OK — ${html.length} chars`);
    return html;

  } catch (e) {
    if (e.message.includes('ScrapingDog →')) throw e; // re-throw nos erreurs métier
    const status  = e.response?.status;
    const errBody = e.response?.data ? JSON.stringify(e.response.data) : '';
    if (status === 401) throw new Error('SCRAPINGDOG_API_KEY invalide (401)');
    if (status === 403) throw new Error('Crédits ScrapingDog épuisés (403)');
    if (status === 400) throw new Error(`ScrapingDog requête invalide (400): ${errBody}`);
    throw new Error(`ScrapingDog failed [${status || e.code}]: ${e.message}`);
  }
}

module.exports = { scraperApiFetch };


