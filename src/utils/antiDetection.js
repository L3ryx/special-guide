'use strict';

const axios = require('axios');

// ── USER AGENTS (navigateurs réels, mis à jour 2024) ──
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

// ── ACCEPT-LANGUAGE ──
const ACCEPT_LANGUAGES = [
  'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
  'en-US,en;q=0.9,fr;q=0.8',
  'en-GB,en;q=0.9,fr-FR;q=0.8,fr;q=0.7',
  'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7',
  'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
  'fr-FR,fr;q=0.9,en;q=0.8',
  'en-US,en;q=0.8,fr-FR;q=0.5,fr;q=0.3',
];

// ── ACCEPT ──
const ACCEPT_HEADERS = [
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
];

// ── REFERERS ──
const REFERERS = [
  'https://www.google.com/',
  'https://www.google.fr/',
  'https://www.bing.com/',
  'https://duckduckgo.com/',
  'https://www.google.co.uk/',
  'https://search.yahoo.com/',
  'https://www.ecosia.org/',
  'https://www.qwant.com/',
  null,
  null,
];

// ── PROXY SCRAPE ──

let _proxies      = [];
let _proxyIndex   = 0;
let _lastFetch    = 0;
const PROXY_TTL   = 20 * 60 * 1000; // recharge toutes les 20 min

async function fetchProxies() {
  const now = Date.now();
  if (_proxies.length > 0 && now - _lastFetch < PROXY_TTL) return;

  const apiKey  = process.env.PROXYSCRAPE_API_KEY || '';
  const proto   = process.env.PROXYSCRAPE_PROTOCOL  || 'http';
  const anon    = process.env.PROXYSCRAPE_ANONYMITY  || 'elite';
  const country = process.env.PROXYSCRAPE_COUNTRY    || 'all';
  const timeout = process.env.PROXYSCRAPE_TIMEOUT    || '10000';

  const url = apiKey
    ? `https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=${proto}&anonymity=${anon}&country=${country}&timeout=${timeout}&apikey=${apiKey}`
    : `https://api.proxyscrape.com/v2/?request=displayproxies&protocol=${proto}&anonymity=${anon}&country=${country}&timeout=${timeout}`;

  try {
    const r = await axios.get(url, { timeout: 15000 });
    const lines = r.data.trim().split('\n').map(l => l.trim()).filter(l => l.includes(':'));
    _proxies = lines.map(l => `${proto}://${l}`);
    shuffle(_proxies);
    _lastFetch = now;
    console.log(`[antiDetection] ${_proxies.length} proxies chargés depuis ProxyScrape`);
  } catch (e) {
    console.warn('[antiDetection] ProxyScrape fetch failed:', e.message);
    _proxies = [];
  }
}

function getNextProxy() {
  if (!_proxies.length) return null;
  const proxy = _proxies[_proxyIndex % _proxies.length];
  _proxyIndex++;
  if (_proxyIndex >= _proxies.length) {
    shuffle(_proxies);
    _proxyIndex = 0;
  }
  return proxy;
}

function removeProxy(proxy) {
  const idx = _proxies.indexOf(proxy);
  if (idx !== -1) {
    _proxies.splice(idx, 1);
    console.warn(`[antiDetection] Proxy retiré: ${proxy} (${_proxies.length} restants)`);
  }
}

// ── HELPERS ──

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Délai non-linéaire avec comportement humain (distribution gaussienne tronquée).
 * @param {number} minMs
 * @param {number} maxMs
 * @returns {Promise<void>}
 */
function humanDelay(minMs = 1500, maxMs = 5000) {
  const mu    = (minMs + maxMs) / 2;
  const sigma = (maxMs - minMs) / 4;
  let delay   = gaussRandom(mu, sigma);
  delay       = Math.max(minMs, Math.min(maxMs, delay));

  // 5% de chance : pause longue (lecture / distraction)
  if (Math.random() < 0.05) {
    delay = Math.random() * 20000 + 10000;
  }
  return new Promise(r => setTimeout(r, delay));
}

/**
 * Nombre aléatoire selon loi normale (Box-Muller).
 */
function gaussRandom(mu, sigma) {
  const u = 1 - Math.random();
  const v = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return z * sigma + mu;
}

/**
 * Construit un objet headers complet simulant un navigateur réel.
 * @param {object} overrides  Clés supplémentaires à fusionner
 * @returns {object}
 */
function buildHeaders(overrides = {}) {
  const ua      = pick(USER_AGENTS);
  const referer = pick(REFERERS);
  const isChrome = ua.includes('Chrome') && !ua.includes('Edg');

  const headers = {
    'User-Agent':      ua,
    'Accept':          pick(ACCEPT_HEADERS),
    'Accept-Language': pick(ACCEPT_LANGUAGES),
    'Accept-Encoding': Math.random() > 0.3 ? 'gzip, deflate, br' : 'gzip, deflate',
    'Connection':      'keep-alive',
  };

  if (referer) headers['Referer'] = referer;
  if (Math.random() > 0.5) headers['DNT'] = '1';

  if (isChrome) {
    headers['sec-ch-ua']          = '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';
    headers['sec-ch-ua-mobile']   = '?0';
    headers['sec-ch-ua-platform'] = pick(['"Windows"', '"macOS"', '"Linux"']);
    headers['Sec-Fetch-Dest']     = 'document';
    headers['Sec-Fetch-Mode']     = 'navigate';
    headers['Sec-Fetch-Site']     = pick(['none', 'same-origin', 'cross-site']);
    headers['Sec-Fetch-User']     = '?1';
    headers['Upgrade-Insecure-Requests'] = '1';
  }

  return { ...headers, ...overrides };
}

/**
 * Effectue une requête GET axios avec rotation proxy + headers complets + délai.
 * Retire automatiquement un proxy défaillant et retente avec un autre.
 *
 * @param {string} url
 * @param {object} axiosOptions  Options axios supplémentaires (params, timeout, etc.)
 * @param {object} headerOverrides
 * @returns {Promise<AxiosResponse>}
 */
async function getWithAntiDetection(url, axiosOptions = {}, headerOverrides = {}) {
  await fetchProxies();
  await humanDelay(800, 3000);

  const MAX_TRIES = 3;
  let lastError;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const proxy   = getNextProxy();
    const headers = buildHeaders(headerOverrides);

    const config = {
      timeout: 30000,
      ...axiosOptions,
      headers: { ...headers, ...(axiosOptions.headers || {}) },
    };

    if (proxy) {
      const proxyUrl = new URL(proxy);
      config.proxy = {
        protocol: proxyUrl.protocol.replace(':', ''),
        host:     proxyUrl.hostname,
        port:     parseInt(proxyUrl.port, 10),
      };
    }

    try {
      const r = await axios.get(url, config);
      return r;
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      if (proxy && (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' || status === 407)) {
        removeProxy(proxy);
      }
      if (attempt < MAX_TRIES - 1) {
        console.warn(`[antiDetection] Tentative ${attempt + 1}/${MAX_TRIES} échouée (${e.code || status}) — retry`);
        await humanDelay(1000 * (attempt + 1), 3000 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

/**
 * Effectue une requête POST axios avec rotation proxy + headers complets.
 *
 * @param {string} url
 * @param {any}    data
 * @param {object} axiosOptions
 * @param {object} headerOverrides
 * @returns {Promise<AxiosResponse>}
 */
async function postWithAntiDetection(url, data, axiosOptions = {}, headerOverrides = {}) {
  await fetchProxies();
  await humanDelay(500, 2000);

  const MAX_TRIES = 3;
  let lastError;

  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const proxy   = getNextProxy();
    const headers = buildHeaders(headerOverrides);

    const config = {
      timeout: 30000,
      ...axiosOptions,
      headers: { ...headers, ...(axiosOptions.headers || {}) },
    };

    if (proxy) {
      const proxyUrl = new URL(proxy);
      config.proxy = {
        protocol: proxyUrl.protocol.replace(':', ''),
        host:     proxyUrl.hostname,
        port:     parseInt(proxyUrl.port, 10),
      };
    }

    try {
      const r = await axios.post(url, data, config);
      return r;
    } catch (e) {
      lastError = e;
      const status = e.response?.status;
      if (proxy && (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT' || e.code === 'ENOTFOUND' || status === 407)) {
        removeProxy(proxy);
      }
      if (attempt < MAX_TRIES - 1) {
        console.warn(`[antiDetection] POST tentative ${attempt + 1}/${MAX_TRIES} échouée — retry`);
        await humanDelay(1500 * (attempt + 1), 4000 * (attempt + 1));
      }
    }
  }

  throw lastError;
}

module.exports = {
  buildHeaders,
  humanDelay,
  getWithAntiDetection,
  postWithAntiDetection,
  fetchProxies,
  getNextProxy,
};
