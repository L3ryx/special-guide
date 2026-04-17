/**
 * etsyScraper.js
 * Scrape les pages de résultats Etsy via Playwright + stealth.
 *
 * Fonctionnalités :
 *  - Playwright chromium avec playwright-extra + puppeteer-extra-plugin-stealth
 *  - Headers HTTP complets identiques à Chrome (Sec-Fetch-*, Sec-CH-UA, etc.)
 *  - Navigation de chauffe : homepage → catégorie → recherche (flow humain)
 *  - Délais variables à distribution naturelle (pas uniforme)
 *  - Scroll et mouvements souris réalistes
 *  - Stockage et réutilisation des cookies/session entre redémarrages
 *  - Pages leurres pendant la navigation
 *  - Fallback fetch si Playwright indisponible
 */

'use strict';

const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

// ── Chemins persistance ────────────────────────────────────────────────────────

const COOKIES_PATH = path.join(__dirname, '../../.etsy_cookies.json');
const STORAGE_PATH = path.join(__dirname, '../../.etsy_storage.json');
const SESSION_VERSION = 3; // incrémenter pour invalider les sessions périmées

// ── Pool user-agents + profils correspondants ─────────────────────────────────

const UA_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: '"macOS"',
    secCHUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    mobile: '?0',
    viewport: { width: 1440, height: 900 },
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    platform: '"macOS"',
    secCHUa: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
    mobile: '?0',
    viewport: { width: 1280, height: 800 },
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: '"Windows"',
    secCHUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    mobile: '?0',
    viewport: { width: 1366, height: 768 },
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    platform: '"Windows"',
    secCHUa: '"Chromium";v="123", "Google Chrome";v="123", "Not-A.Brand";v="99"',
    mobile: '?0',
    viewport: { width: 1920, height: 1080 },
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: '"Linux"',
    secCHUa: '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    mobile: '?0',
    viewport: { width: 1280, height: 1024 },
  },
];

// Pages leurres crédibles (navigation habituelle Etsy)
const DECOY_URLS = [
  'https://www.etsy.com/',
  'https://www.etsy.com/c/jewelry',
  'https://www.etsy.com/c/home-and-living',
  'https://www.etsy.com/c/art-and-collectibles',
  'https://www.etsy.com/c/clothing',
  'https://www.etsy.com/c/toys-and-games',
  'https://www.etsy.com/c/craft-supplies-and-tools',
  'https://www.etsy.com/featured',
];

// ── Utilitaires timing ─────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Délai à distribution naturelle (log-normale) — les humains ne font pas
 * des pauses parfaitement uniformes : parfois très courts, parfois longs.
 */
function humanDelay(minMs, maxMs) {
  if (minMs === undefined) minMs = 1200;
  if (maxMs === undefined) maxMs = 3800;
  const range  = maxMs - minMs;
  // Tire un temps plutôt vers le bas avec un biais log-normal
  const base   = minMs + range * Math.pow(Math.random(), 0.7);
  const jitter = randomInt(-250, 400);
  return sleep(Math.max(600, Math.round(base + jitter)));
}

/**
 * Pause "lecture" plus longue — simule un utilisateur qui lit les résultats.
 */
function readingDelay() {
  return humanDelay(2000, 6500);
}

// ── Stats ──────────────────────────────────────────────────────────────────────

const _stats = {
  pagesScraped: 0,
  itemsFound:   0,
  errors:       0,
  blocked:      0,
};

// ── Rate limiters ──────────────────────────────────────────────────────────────

class RateLimiter {
  constructor() { this.lastCallAt = 0; }
  async wait(minMs, maxMs) {
    if (minMs === undefined) minMs = 1200;
    if (maxMs === undefined) maxMs = 3500;
    const delay   = randomInt(minMs, maxMs);
    const elapsed = Date.now() - this.lastCallAt;
    const waiting = Math.max(0, delay - elapsed);
    if (waiting > 0) await sleep(waiting);
    this.lastCallAt = Date.now();
  }
}

const _rateLimiter     = new RateLimiter();
const _shopRateLimiter = new RateLimiter();

// ── Session Playwright (singleton) ────────────────────────────────────────────

let _browser      = null;
let _context      = null;
let _profile      = null;  // profil UA actif
let _pwReady      = false;
let _pwFailed     = false;
let _warmedUp     = false; // la session a-t-elle visité Etsy "en vrai" ?

async function initPlaywright() {
  if (_pwReady || _pwFailed) return;
  try {
    const { chromium } = require('playwright-extra');
    const stealth       = require('puppeteer-extra-plugin-stealth');
    chromium.use(stealth());

    _profile = pick(UA_PROFILES);

    // Restaurer session précédente si elle existe et est à la bonne version
    let storageState;
    if (fs.existsSync(STORAGE_PATH)) {
      try {
        const raw = JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
        if (raw._v === SESSION_VERSION) {
          storageState = raw;
          console.log('[etsyScraper] Session Playwright restaurée depuis disque');
        } else {
          console.log('[etsyScraper] Session périmée (v' + (raw._v || 0) + ' != v' + SESSION_VERSION + ') — nouvelle session');
          fs.unlinkSync(STORAGE_PATH);
          if (fs.existsSync(COOKIES_PATH)) fs.unlinkSync(COOKIES_PATH);
        }
      } catch (_) {}
    }

    _browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--window-size=' + _profile.viewport.width + ',' + _profile.viewport.height,
        '--lang=en-US,en',
      ],
    });

    const ctxOptions = {
      userAgent:   _profile.ua,
      locale:      'en-US',
      timezoneId:  'America/New_York',
      viewport:    _profile.viewport,
      colorScheme: 'light',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-CH-UA':          _profile.secCHUa,
        'Sec-CH-UA-Mobile':   _profile.mobile,
        'Sec-CH-UA-Platform': _profile.platform,
      },
    };

    if (storageState) {
      // storageState inclut cookies + localStorage — retirer la clé interne _v
      const { _v: _, ...realState } = storageState;
      ctxOptions.storageState = realState;
      _warmedUp = true; // session existante = déjà chaud
    }

    _context = await _browser.newContext(ctxOptions);

    // Restaurer cookies séparés si pas de storageState
    if (!storageState && fs.existsSync(COOKIES_PATH)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf8'));
        if (Array.isArray(cookies) && cookies.length > 0) {
          await _context.addCookies(cookies);
          console.log('[etsyScraper] ' + cookies.length + ' cookies Etsy restaurés');
        }
      } catch (_) {}
    }

    // Bloquer les ressources vraiment lourdes (vidéo, media) mais laisser
    // quelques images passer pour paraître moins suspect qu'un bot pur.
    let _imageCount = 0;
    await _context.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'media' || type === 'websocket') return route.abort();
      if (type === 'font') return route.abort();
      // Laisser passer 1 image sur 4 (les icônes, logo Etsy…)
      if (type === 'image') {
        _imageCount++;
        return _imageCount % 4 === 0 ? route.continue() : route.abort();
      }
      return route.continue();
    });

    _pwReady = true;
    console.log('[etsyScraper] Playwright stealth initialisé (profil: ' + _profile.platform + ')');

    // Chauffe la session si elle est neuve
    if (!_warmedUp) {
      warmUpSession().catch(() => {});
    }

  } catch (e) {
    _pwFailed = true;
    console.warn('[etsyScraper] Playwright indisponible, fallback fetch: ' + e.message);
  }
}

/**
 * Navigation de chauffe : visite la homepage Etsy puis une catégorie,
 * comme un utilisateur qui arrive via son historique/favoris.
 */
async function warmUpSession() {
  if (!_context || _warmedUp) return;
  _warmedUp = true;
  const page = await _context.newPage();
  try {
    console.log('[etsyScraper] Chauffe session : visite homepage Etsy...');
    await page.goto('https://www.etsy.com/', { timeout: 30000, waitUntil: 'domcontentloaded' });
    await humanBehavior(page);
    await readingDelay();

    // Visite une catégorie aléatoire
    const cat = pick(DECOY_URLS.filter(u => u.includes('/c/')));
    await page.goto(cat, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await humanBehavior(page);
    await humanDelay(1500, 3500);

    persistSession().catch(() => {});
    console.log('[etsyScraper] Session chauffée avec succès');
  } catch (e) {
    console.warn('[etsyScraper] Warm-up partiel: ' + e.message);
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

async function persistSession() {
  if (!_context) return;
  try {
    const cookies = await _context.cookies();
    fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
    const storage = await _context.storageState();
    // Ajouter la version pour détecter les sessions périmées
    const toSave = Object.assign({ _v: SESSION_VERSION }, storage);
    fs.writeFileSync(STORAGE_PATH, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.warn('[etsyScraper] Échec persistance session: ' + e.message);
  }
}

async function closeBrowser() {
  if (!_browser) return;
  try {
    await persistSession();
    await _browser.close();
  } catch (_) {}
  _browser  = null;
  _context  = null;
  _pwReady  = false;
  _warmedUp = false;
}

// ── Comportement humain : scroll + mouse réaliste ─────────────────────────────

async function humanBehavior(page) {
  try {
    const vp = _profile ? _profile.viewport : { width: 1366, height: 768 };

    // Scroll progressif vers le bas (lit les résultats)
    const scrollSteps = randomInt(3, 7);
    for (let i = 0; i < scrollSteps; i++) {
      await page.mouse.wheel(0, randomInt(150, 500));
      await sleep(randomInt(180, 550));
    }

    // Déplace la souris vers quelques positions aléatoires
    const moves = randomInt(2, 4);
    for (let i = 0; i < moves; i++) {
      await page.mouse.move(
        randomInt(80, vp.width - 80),
        randomInt(80, vp.height - 80),
        { steps: randomInt(5, 15) }
      );
      await sleep(randomInt(80, 280));
    }

    // Parfois remonte un peu (lecture non linéaire)
    if (Math.random() < 0.35) {
      await page.mouse.wheel(0, randomInt(-200, -80));
      await sleep(randomInt(300, 700));
    }
  } catch (_) {}
}

// ── Page leurre (arrière-plan) ────────────────────────────────────────────────

async function spawnDecoyPage() {
  if (!_context) return;
  if (Math.random() > 0.35) return; // 35% de chance
  const url = pick(DECOY_URLS);
  let decoyPage;
  try {
    decoyPage = await _context.newPage();
    await decoyPage.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
    await sleep(randomInt(1200, 3500));
    await humanBehavior(decoyPage);
  } catch (_) {
    // silencieux — la leurre n'est pas critique
  } finally {
    if (decoyPage && !decoyPage.isClosed()) {
      await decoyPage.close().catch(() => {});
    }
  }
}

// ── Headers fetch (fallback sans Playwright) ──────────────────────────────────

function buildHeaders(url, extraReferer) {
  const profile = _profile || pick(UA_PROFILES);
  const isShop  = url && url.includes('/shop/');
  const referer  = extraReferer || (isShop ? 'https://www.etsy.com/search' : 'https://www.etsy.com/');
  const isNav    = !isShop; // navigation top-level (Search)

  return {
    'User-Agent':              profile.ua,
    'Accept':                  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language':         'en-US,en;q=0.9',
    'Accept-Encoding':         'gzip, deflate, br, zstd',
    'Cache-Control':           'max-age=0',
    'Connection':              'keep-alive',
    'Referer':                 referer,
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':          'document',
    'Sec-Fetch-Mode':          'navigate',
    'Sec-Fetch-Site':          isNav ? 'same-origin' : 'none',
    'Sec-Fetch-User':          '?1',
    'Sec-CH-UA':               profile.secCHUa,
    'Sec-CH-UA-Mobile':        profile.mobile,
    'Sec-CH-UA-Platform':      profile.platform,
    'DNT':                     '1',
    'TE':                      'trailers',
  };
}

// ── Fetch avec Playwright ─────────────────────────────────────────────────────

async function fetchWithPlaywright(url) {
  const page = await _context.newPage();
  try {
    const isShop  = url.includes('/shop/');
    const referer = isShop ? 'https://www.etsy.com/search' : 'https://www.etsy.com/';

    await page.setExtraHTTPHeaders({
      'Referer':        referer,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
    });

    await page.goto(url, { timeout: 40000, waitUntil: 'domcontentloaded' });

    // Attendre que React rende les listing cards (Etsy est une SPA)
    // On attend le premier sélecteur qui se matérialise, avec un timeout généreux.
    const CARD_SELECTORS = [
      'div[data-listing-id]',
      'div.v2-listing-card',
      'li[data-palette-listing-id]',
      "script[type='application/ld+json']",
    ].join(', ');

    try {
      await page.waitForSelector(CARD_SELECTORS, { timeout: 12000 });
    } catch {
      // Pas grave : on lit quand même le HTML disponible
      console.warn('[etsyScraper] waitForSelector timeout sur ' + url.slice(0, 60));
    }

    await humanBehavior(page);
    await humanDelay(800, 2000);

    const html = await page.content();

    if (/captcha|i am not a robot|unusual traffic/i.test(html)) {
      _stats.blocked++;
      throw new Error('Etsy captcha détecté');
    }

    persistSession().catch(() => {});
    return html;
  } finally {
    if (!page.isClosed()) await page.close().catch(() => {});
  }
}

// ── Fetch principal (Playwright → fallback fetch) ─────────────────────────────

async function fetchPage(url, retries) {
  if (retries === undefined) retries = 2;
  if (!_pwReady && !_pwFailed) await initPlaywright();

  // ── Tentative Playwright ──
  if (_pwReady && _context) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await humanDelay(900, 2800);
        // Lance la leurre en parallèle (sans attendre)
        spawnDecoyPage().catch(() => {});
        return await fetchWithPlaywright(url);
      } catch (e) {
        _stats.errors++;
        console.warn('[etsyScraper] Playwright attempt ' + (attempt + 1) + ' échoué: ' + e.message);
        if (e.message.includes('captcha')) throw e;
        if (attempt < retries) await humanDelay(3500, 7000);
      }
    }
    console.warn('[etsyScraper] Playwright épuisé, tentative fetch direct');
  }

  // ── Fallback fetch HTTP ──
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await humanDelay(1800, 5000);
      const response = await fetch(url, { headers: buildHeaders(url) });

      if (response.status === 429 || response.status === 503) {
        _stats.blocked++;
        const wait = 5000 * (attempt + 1);
        console.warn('[etsyScraper] HTTP ' + response.status + ' — attente ' + wait + 'ms');
        await sleep(wait);
        continue;
      }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const html = await response.text();
      if (/captcha|i am not a robot|unusual traffic/i.test(html)) {
        _stats.blocked++;
        throw new Error('Etsy captcha détecté');
      }
      return html;
    } catch (e) {
      lastError = e;
      if (attempt < retries) await sleep(2500 * (attempt + 1));
    }
  }
  throw lastError;
}

// ── Parsers HTML ──────────────────────────────────────────────────────────────

function makeAbsoluteURL(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  return 'https://www.etsy.com' + (url.startsWith('/') ? url : '/' + url);
}

function cleanImage(url) {
  if (!url) return null;
  if (url.startsWith('//')) url = 'https:' + url;
  return url.split('?')[0].replace(/\/il_(fullxfull|\d+x\d+|[^/.]+)\.(jpg|jpeg|png|webp)/i, '/il_570xN.$2') || null;
}

function cleanText(text) {
  return String(text || '').replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim();
}

function extractListingId(url) {
  const m = url && url.match(/\/listing\/(\d+)/);
  return m ? m[1] : null;
}

function extractShopName(url) {
  const m = url && url.match(/etsy\.com\/shop\/([^/?#&]+)/);
  return m ? m[1] : null;
}

function isLikelyDigitalProduct(title) {
  return /\b(digital|download|printable|svg|template|pdf|excel|spreadsheet|tracker|planner|pattern|cricut|sublimation|clipart|png|jpg|canva|stl|editable|certificate|plans?|cnc)\b/i.test(title);
}

function extractShopNameFromJsonLd(item) {
  // Etsy met le shop name dans brand.name, seller.name ou offers.seller.name
  const sources = [
    item.brand,
    item.seller,
    item.offers && item.offers.seller,
    item.offers && Array.isArray(item.offers) && item.offers[0] && item.offers[0].seller,
  ];
  for (const src of sources) {
    if (!src) continue;
    const name = typeof src === 'string' ? src : (src.name || src['@name'] || null);
    if (name && typeof name === 'string' && name.trim().length > 0) return name.trim();
  }
  return null;
}

function extractImageFromJsonLd(rawImg) {
  if (!rawImg) return null;
  if (typeof rawImg === 'string') return rawImg;
  if (Array.isArray(rawImg) && rawImg.length) {
    const first = rawImg[0];
    return typeof first === 'string' ? first : (first.contentURL || first.url || null);
  }
  if (typeof rawImg === 'object') return rawImg.contentURL || rawImg.url || null;
  return null;
}

function parseEtsySearchPage(html) {
  const $       = cheerio.load(html);
  const results = [];
  const seenIds = new Set();

  // ── Méthode 1 : JSON-LD ─────────────────────────────────────────────────
  $("script[type='application/ld+json']").each(function(_, el) {
    try {
      const data  = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : (data['@graph'] ? data['@graph'] : [data]);
      for (const item of items) {
        if (item['@type'] !== 'Product') continue;
        const link = (item.url || '').split('?')[0];
        const id   = extractListingId(link);
        if (!id || seenIds.has(id)) continue;
        const title = cleanText(item.name || '');
        if (isLikelyDigitalProduct(title)) continue;
        const image = cleanImage(extractImageFromJsonLd(item.image));
        if (!image) continue;
        const shopName = extractShopNameFromJsonLd(item);
        seenIds.add(id);
        results.push({
          listingId: id, title, link, image,
          shopName:  shopName || null,
          shopUrl:   shopName ? 'https://www.etsy.com/shop/' + shopName : null,
          source:    'etsy-jsonld',
        });
      }
    } catch (_) {}
  });

  // ── Méthode 2 : données __NEXT_DATA__ (Next.js / Etsy interne) ──────────
  if (results.length < 3) {
    $('script#__NEXT_DATA__').each(function(_, el) {
      try {
        const data     = JSON.parse($(el).text());
        const listings = (data.props?.pageProps?.listingSearchQuery?.hits) ||
                         (data.props?.pageProps?.results)                   ||
                         [];
        for (const hit of listings) {
          const id = String(hit.listing_id || hit.listingId || '');
          if (!id || seenIds.has(id)) continue;
          const title = cleanText(hit.title || '');
          if (isLikelyDigitalProduct(title)) continue;
          const image = cleanImage(
            hit.main_image?.url_570xN || hit.images?.[0]?.url_570xN ||
            hit.main_image?.url       || hit.images?.[0]?.url
          );
          if (!image) continue;
          const shopName = hit.shop?.shop_name || hit.shop_name || hit.sellerName || null;
          const link     = 'https://www.etsy.com/listing/' + id;
          seenIds.add(id);
          results.push({
            listingId: id, title, link, image,
            shopName:  shopName || null,
            shopUrl:   shopName ? 'https://www.etsy.com/shop/' + shopName : null,
            source:    'etsy-nextdata',
          });
        }
      } catch (_) {}
    });
  }

  // ── Méthode 3 : cartes HTML ──────────────────────────────────────────────
  if (results.length < 5) {
    const cardSelectors = [
      'div.v2-listing-card[data-listing-id]',
      'div[data-listing-id]',
      'li[data-palette-listing-id]',
      'article.listing-card',
    ].join(', ');

    $(cardSelectors).each(function(_, card) {
      const $card     = $(card);
      const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id') || null;
      if (!listingId || seenIds.has(listingId)) return;

      const linkEl  = $card.find('a[href*="/listing/"]').first();
      const rawHref = linkEl.attr('href') || '';
      const link    = rawHref ? makeAbsoluteURL(rawHref).split('?')[0] : '';
      if (!link) return;

      const title = cleanText($card.find('.v2-listing-card__title, [data-testid="listing-title"], h3, h2').first().text());
      if (isLikelyDigitalProduct(title)) return;

      const imgEl = $card.find('img[data-src], img[src]').first();
      const image = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
      if (!image || image.includes('placeholder') || image.startsWith('data:')) return;

      // Shop name : data-shop-name attr, puis lien /shop/, puis data-listing-shop-name
      let shopName = $card.attr('data-shop-name') ||
                     $card.attr('data-listing-shop-name') ||
                     null;
      if (!shopName) {
        const shopHref = $card.find('a[href*="/shop/"]').first().attr('href') || '';
        if (shopHref) shopName = extractShopName(makeAbsoluteURL(shopHref));
      }

      seenIds.add(listingId);
      results.push({
        listingId, title, link, image,
        shopName:  shopName || null,
        shopUrl:   shopName ? 'https://www.etsy.com/shop/' + shopName : null,
        source:    'etsy-html',
      });
    });
  }

  const withShop    = results.filter(r => r.shopName).length;
  const withoutShop = results.length - withShop;
  console.log(`[parseEtsySearchPage] ${results.length} listings | ${withShop} avec shopName | ${withoutShop} sans shopName`);

  return results;
}

// ── 2ème image boutique ───────────────────────────────────────────────────────

async function getSecondShopImage(shopUrl, excludeListingId) {
  if (!shopUrl) return null;
  try {
    await _shopRateLimiter.wait(1200, 3500);
    const html = await fetchPage(shopUrl);
    const $    = cheerio.load(html);
    let image2 = null;

    $("script[type='application/ld+json']").each(function(_, el) {
      if (image2) return false;
      try {
        const data  = JSON.parse($(el).text());
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item['@type'] !== 'Product') continue;
          const link = (item.url || '').split('?')[0];
          const id   = extractListingId(link);
          if (!id || id === String(excludeListingId)) continue;
          const rawImg = item.image;
          const img    = cleanImage(
            typeof rawImg === 'string' ? rawImg
            : (Array.isArray(rawImg) && rawImg.length
              ? (rawImg[0] && rawImg[0].contentURL ? rawImg[0].contentURL : rawImg[0])
              : null)
          );
          if (img) { image2 = img; break; }
        }
      } catch (_) {}
    });

    if (!image2) {
      const cardSelectors = [
        'div.v2-listing-card[data-listing-id]',
        'div[data-listing-id]',
        'li[data-palette-listing-id]',
      ].join(', ');
      $(cardSelectors).each(function(_, card) {
        if (image2) return false;
        const $card     = $(card);
        const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id');
        if (!listingId || listingId === String(excludeListingId)) return;
        const imgEl = $card.find('img[data-src], img[src]').first();
        const img   = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
        if (img && img.indexOf('placeholder') === -1 && img.indexOf('data:') === -1) {
          image2 = img;
        }
      });
    }

    console.log(image2
      ? '[etsyScraper] 2ème image boutique OK: ' + shopUrl.slice(0, 60)
      : '[etsyScraper] Pas de 2ème image pour: ' + shopUrl.slice(0, 60));
    return image2;
  } catch (e) {
    console.warn('[etsyScraper] getSecondShopImage failed (' + shopUrl + '): ' + e.message);
    return null;
  }
}

// ── API principale ────────────────────────────────────────────────────────────

async function searchEtsyPages(keyword, maxPages, onPage, isAborted) {
  if (maxPages === undefined) maxPages = 7;
  if (!onPage) onPage = null;
  if (!isAborted) isAborted = function() { return false; };

  if (!_pwReady && !_pwFailed) await initPlaywright();

  const BASE           = 'https://www.etsy.com/search';
  const allListings    = [];
  const seenListingIds = new Set();
  const seenShopNames  = new Set();

  for (let page = 1; page <= maxPages; page++) {
    if (isAborted()) break;
    if (page > 1) await humanDelay(2500, 6000);

    const url = BASE + '?q=' + encodeURIComponent(keyword) + '&page=' + page + '&explicit=1';
    console.log('[etsyScraper] Scrape Etsy page ' + page + '/' + maxPages);

    let html;
    try {
      html = await fetchPage(url);
      _stats.pagesScraped++;
    } catch (e) {
      _stats.errors++;
      console.error('[etsyScraper] page ' + page + ' échouée: ' + e.message);
      if (e.message.indexOf('captcha') !== -1) break;
      continue;
    }

    const pageResults = parseEtsySearchPage(html);
    console.log('[etsyScraper] page ' + page + ' → ' + pageResults.length + ' listings parsés');

    let newThisPage = 0;
    for (const listing of pageResults) {
      if (seenListingIds.has(listing.listingId)) continue;
      seenListingIds.add(listing.listingId);
      const shopKey = listing.shopName || listing.listingId;
      if (seenShopNames.has(shopKey)) continue;
      seenShopNames.add(shopKey);
      allListings.push(listing);
      newThisPage++;
    }

    _stats.itemsFound += newThisPage;
    console.log('[etsyScraper] +' + newThisPage + ' nouvelles boutiques | total: ' + allListings.length);
    if (onPage) onPage(page, allListings.length);
    if (pageResults.length === 0) { console.log('[etsyScraper] Page vide — arrêt'); break; }
  }

  persistSession().catch(() => {});
  console.log('[etsyScraper] searchEtsyPages terminé: ' + allListings.length + ' boutiques uniques');
  return allListings;
}

// ── Compat scrape.js ──────────────────────────────────────────────────────────

async function searchListingIds(keyword, limit, offset) {
  if (limit === undefined) limit = 48;
  if (offset === undefined) offset = 0;
  const page = Math.floor(offset / limit) + 1;
  await _rateLimiter.wait(1200, 3500);
  if (!_pwReady && !_pwFailed) await initPlaywright();
  const url = 'https://www.etsy.com/search?q=' + encodeURIComponent(keyword) + '&page=' + page + '&explicit=1';
  let html;
  try {
    html = await fetchPage(url);
    _stats.pagesScraped++;
  } catch (e) {
    _stats.errors++;
    console.error('[etsyScraper] searchListingIds page ' + page + ' échouée: ' + e.message);
    return [];
  }
  const results = parseEtsySearchPage(html);
  _stats.itemsFound += results.length;
  console.log('[etsyScraper] searchListingIds page ' + page + ': ' + results.length + ' listings | keyword="' + keyword + '"');
  return results.slice(0, limit).map(function(r) {
    return Object.assign({}, r, { hasRealShopName: !!r.shopName, shopId: null });
  });
}

async function searchListings(keyword, limit, offset) {
  return searchListingIds(keyword, limit, offset);
}

async function getShopListings(shopIdOrName, limit) {
  if (limit === undefined) limit = 5;
  const shopUrl = 'https://www.etsy.com/shop/' + shopIdOrName;
  try {
    await _shopRateLimiter.wait(1200, 3500);
    const html = await fetchPage(shopUrl);
    const $    = cheerio.load(html);
    const results = [];
    const seen    = new Set();
    $('div.v2-listing-card[data-listing-id], div[data-listing-id], li[data-palette-listing-id]').each(function(_, card) {
      if (results.length >= limit) return false;
      const $card     = $(card);
      const listingId = $card.attr('data-listing-id') || $card.attr('data-palette-listing-id');
      if (!listingId || seen.has(listingId)) return;
      seen.add(listingId);
      const imgEl  = $card.find('img[data-src], img[src]').first();
      const image  = cleanImage(imgEl.attr('data-src') || imgEl.attr('src') || null);
      const linkEl = $card.find('a[href*="/listing/"]').first();
      const link   = makeAbsoluteURL(linkEl.attr('href') || '').split('?')[0];
      results.push({ listingId, link, image, shopName: String(shopIdOrName), shopUrl, source: 'etsy-shop' });
    });
    return results;
  } catch (e) {
    console.warn('[etsyScraper] getShopListings failed for ' + shopIdOrName + ': ' + e.message);
    return [];
  }
}

async function getShopNameAndImage(shopId, listingId, listingId2) {
  return { shopName: null, shopUrl: null, image: null, image2: null };
}

async function getShopInfo(shopIdOrName) {
  return {
    shopId: null, shopName: String(shopIdOrName),
    title: String(shopIdOrName),
    shopUrl: 'https://www.etsy.com/shop/' + shopIdOrName,
    shopAvatar: null, numSales: 0, admirers: 0,
  };
}

async function getListingDetail(listingId) {
  return { title: null, price: null, images: [], shopName: null, shopId: null, totalSales: null, admirers: null };
}

async function getShopMetrics(shopIdOrName) {
  return { shopName: String(shopIdOrName), shopUrl: 'https://www.etsy.com/shop/' + shopIdOrName, numSales: 0, admirers: 0 };
}

async function scrapeProducts(opts) {
  if (!opts) opts = {};
  const keyword = (function() {
    try { return new URL(opts.baseUrl || '').searchParams.get('q') || 'etsy product'; }
    catch (_) { return 'etsy product'; }
  })();
  return searchEtsyPages(keyword, opts.maxPages || 7, opts.onPage);
}

function getStats() { return Object.assign({}, _stats); }

function handleEtsyError(e) {
  if (e && e.message) { console.error('[etsyScraper] Erreur:', e.message); throw e; }
  throw new Error('Erreur scraper Etsy inconnue');
}

async function isScraperAvailable() { return true; }

// Nettoyage propre à l'arrêt du processus
process.on('exit',    () => { if (_browser) _browser.close().catch(() => {}); });
process.on('SIGTERM', () => { closeBrowser().finally(() => process.exit(0)); });
process.on('SIGINT',  () => { closeBrowser().finally(() => process.exit(0)); });

module.exports = {
  searchEtsyPages,
  getSecondShopImage,
  searchListings,
  searchListingIds,
  getShopNameAndImage,
  getShopListings,
  getShopInfo,
  getListingDetail,
  scrapeProducts,
  getShopMetrics,
  getStats,
  handleEtsyError,
  isScraperAvailable,
  closeBrowser,
};
