/**
 * dinoCompare.js — Client Node.js pour le microservice SigLIP (app.py)
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilise google/siglip-base-patch16-224 à la place de DINOv2 :
 *   - Sigmoid loss → embeddings plus discriminants que CLIP et DINOv2
 *   - Meilleure précision objet-à-objet sur produits e-commerce
 *   - Interface HTTP identique : /compare-images, /compare-hybrid, /health
 *
 * Ce module expose :
 *   - compareImages(etsyUrl, aliUrl, options)         → { similarity, match, scales }
 *   - compareImagesHybrid(etsyUrl, aliUrl, options)   → { similarity, clip_score, structure_score, match }
 *   - findBestAliMatch(etsyUrl, aliUrls, options)     → { bestUrl, similarity, match }
 *   - getAdaptiveThreshold(productTitle)              → number
 *   - isClipAvailable()                               → true si le service répond
 */

const axios = require('axios');

// URL du microservice Python DINOv2 (HuggingFace Space)
// ⚠️  IMPORTANT : le sous-domaine HuggingFace est ENTIÈREMENT en minuscules
const CLIP_BASE = process.env.SIGLIP_SERVICE_URL || process.env.CLIP_SERVICE_URL || 'http://localhost:7860';

// Seuil de similarité cosinus par défaut
const DEFAULT_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.75');

// 90s max — HuggingFace Spaces peut avoir un cold start de 60-90s
const TIMEOUT_MS = 90000;

// Timeout court pour le health check
const HEALTH_TIMEOUT_MS = 8000;

// FIX : 4 retries avec backoff long pour absorber les cold starts HuggingFace (60-90s)
// Séquence d'attente : 15s → 30s → 45s → 60s = max 150s de tentatives
const MAX_RETRIES = 4;
const RETRY_DELAYS_MS = [15000, 30000, 45000, 60000];


/**
 * Retourne un seuil de similarité adapté à la catégorie produit détectée dans le titre.
 *
 * @param {string} productTitle
 * @returns {number} Seuil cosinus entre 0.68 et 0.82
 */
function getAdaptiveThreshold(productTitle = '') {
  const title = productTitle.toLowerCase();

  if (/ring|necklace|earring|bracelet|jewelry|pendant|charm|bangle|brooch/.test(title)) {
    return 0.68;
  }
  if (/bag|purse|wallet|handbag|tote|clutch|backpack|pouch/.test(title)) {
    return 0.76;
  }
  if (/dress|shirt|pants|jeans|hoodie|jacket|coat|skirt|blouse|sweater|legging/.test(title)) {
    return 0.78;
  }
  if (/phone|case|charger|cable|led|lamp|keyboard|mouse|headphone|earphone/.test(title)) {
    return 0.82;
  }
  if (/print|poster|art|painting|decor|candle|frame|pillow|cushion/.test(title)) {
    return 0.70;
  }

  return DEFAULT_THRESHOLD;
}


/**
 * Vérifie si le microservice DINOv2 est disponible.
 * Retourne aussi le status brut pour que server.js puisse distinguer "loading" vs "ready".
 * @returns {Promise<{ available: boolean, status: string|null }>}
 */
async function isClipAvailable() {
  try {
    const r = await axios.get(`${CLIP_BASE}/health`, { timeout: HEALTH_TIMEOUT_MS });
    const status = r.data?.status;
    return {
      available: status === 'ready' || status === 'loading',
      status,
    };
  } catch {
    return { available: false, status: null };
  }
}


/**
 * Helper interne : attend le délai du retry en cours.
 */
async function _retryDelay(attempt) {
  const wait = RETRY_DELAYS_MS[attempt] ?? 60000;
  await new Promise(r => setTimeout(r, wait));
}


/**
 * Compare deux images via DINOv2 (/compare-images).
 *
 * @param {string} etsyUrl
 * @param {string} aliUrl
 * @param {object} options
 * @param {number} [options.threshold=0.75]
 * @returns {Promise<{similarity, match, scales, error, fallback}>}
 */
async function compareImages(etsyUrl, aliUrl, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (!etsyUrl || !aliUrl) {
    return { similarity: 0, match: false, scales: [], error: 'URLs manquantes', fallback: false };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await axios.post(
        `${CLIP_BASE}/compare-images`,
        { etsy_url: etsyUrl, ali_url: aliUrl, threshold },
        { timeout: TIMEOUT_MS }
      );

      return {
        similarity: r.data.similarity ?? 0,
        match:      r.data.match      ?? false,
        scales:     r.data.scales     ?? [],
        error:      r.data.error      ?? null,
        fallback:   false,
      };

    } catch (e) {
      const httpStatus = e.response?.status;
      const isConnRefused = e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND';
      const isServerError = httpStatus >= 500;

      if (isServerError && attempt < MAX_RETRIES) {
        const wait = RETRY_DELAYS_MS[attempt] ?? 60000;
        console.warn(`[siglipCompare] HTTP ${httpStatus} — retry ${attempt + 1}/${MAX_RETRIES} dans ${wait / 1000}s`);
        await _retryDelay(attempt);
        continue;
      }

      if (isConnRefused || isServerError) {
        console.warn(`[siglipCompare] Service SigLIP indisponible (${isServerError ? 'HTTP ' + httpStatus : e.code}) — fallback sans comparaison visuelle`);
        return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
      }

      const msg = e.response?.data?.error || e.message;
      console.warn('[siglipCompare] Erreur:', msg);
      return { similarity: 0, match: false, scales: [], error: msg, fallback: false };
    }
  }
}


/**
 * Compare via /compare-hybrid (DINOv2 75% + structure 25%).
 *
 * FIX : retry MAX_RETRIES=4 avec backoff long (15s/30s/45s/60s) pour absorber
 * les cold starts HuggingFace qui peuvent durer jusqu'à 90s.
 *
 * @param {string} etsyUrl
 * @param {string} aliUrl
 * @param {object} options
 * @param {number} [options.threshold]
 * @param {string} [options.productTitle]
 * @returns {Promise<{similarity, clip_score, structure_score, match, scales, error, fallback}>}
 */
async function compareImagesHybrid(etsyUrl, aliUrl, options = {}) {
  const threshold = options.threshold
    ?? getAdaptiveThreshold(options.productTitle || '')
    ?? DEFAULT_THRESHOLD;

  if (!etsyUrl || !aliUrl) {
    return { similarity: 0, match: false, scales: [], error: 'URLs manquantes', fallback: false };
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await axios.post(
        `${CLIP_BASE}/compare-hybrid`,
        { etsy_url: etsyUrl, ali_url: aliUrl, threshold },
        { timeout: TIMEOUT_MS }
      );

      return {
        similarity:      r.data.similarity      ?? 0,
        clip_score:      r.data.clip_score       ?? 0,
        structure_score: r.data.structure_score  ?? 0,
        match:           r.data.match            ?? false,
        scales:          r.data.scales           ?? [],
        error:           r.data.error            ?? null,
        fallback:        false,
      };

    } catch (e) {
      const httpStatus = e.response?.status;
      const isConnRefused = e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND';
      const isServerError = httpStatus >= 500;

      if (isServerError && attempt < MAX_RETRIES) {
        const wait = RETRY_DELAYS_MS[attempt] ?? 60000;
        console.warn(`[siglipCompare] HTTP ${httpStatus} hybrid — retry ${attempt + 1}/${MAX_RETRIES} dans ${wait / 1000}s`);
        await _retryDelay(attempt);
        continue;
      }

      if (isConnRefused || isServerError) {
        console.warn(`[siglipCompare] Service SigLIP indisponible (hybrid) (${isServerError ? 'HTTP ' + httpStatus : e.code}) — fallback`);
        return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
      }

      const msg = e.response?.data?.error || e.message;
      console.warn('[siglipCompare] Erreur hybrid:', msg);
      return { similarity: 0, match: false, scales: [], error: msg, fallback: false };
    }
  }
}


/**
 * Teste plusieurs URLs AliExpress et retourne la meilleure correspondance.
 *
 * @param {string}   etsyUrl
 * @param {string[]} aliUrls
 * @param {object}   options
 * @param {number}   [options.threshold]
 * @param {string}   [options.productTitle]
 * @param {boolean}  [options.hybrid]
 * @returns {Promise<{bestUrl, similarity, match, fallback}>}
 */
async function findBestAliMatch(etsyUrl, aliUrls, options = {}) {
  if (!aliUrls || aliUrls.length === 0) {
    return { bestUrl: null, similarity: 0, match: false, fallback: false };
  }

  const threshold = options.threshold
    ?? getAdaptiveThreshold(options.productTitle || '')
    ?? DEFAULT_THRESHOLD;

  const compareFn = options.hybrid ? compareImagesHybrid : compareImages;

  const CONCURRENT = 2;
  let bestSimilarity = -1;
  let bestUrl        = null;
  let anyFallback    = false;

  for (let i = 0; i < aliUrls.length; i += CONCURRENT) {
    const batch   = aliUrls.slice(i, i + CONCURRENT);
    const results = await Promise.allSettled(
      batch.map(url => compareFn(etsyUrl, url, { ...options, threshold }))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status !== 'fulfilled') continue;
      const r = results[j].value;
      if (r.fallback) { anyFallback = true; continue; }
      if (r.similarity > bestSimilarity) {
        bestSimilarity = r.similarity;
        bestUrl        = batch[j];
      }
    }
  }

  return {
    bestUrl,
    similarity: bestSimilarity >= 0 ? bestSimilarity : 0,
    match:      bestSimilarity >= threshold,
    fallback:   anyFallback,
  };
}


/**
 * Extrait les URLs d'images depuis un résultat AliExpress.
 *
 * @param {object} serperMatch
 * @returns {string[]}
 */
function extractAliImageUrls(serperMatch) {
  if (!serperMatch) return [];
  const candidates = [
    serperMatch.imageUrl,
    serperMatch.thumbnailUrl,
    serperMatch.image,
  ].filter(Boolean);
  return [...new Set(candidates)];
}


module.exports = {
  isClipAvailable,
  compareImages,
  compareImagesHybrid,
  findBestAliMatch,
  extractAliImageUrls,
  getAdaptiveThreshold,
  DEFAULT_THRESHOLD,
};

/*
 * ─── MIGRATION depuis clipCompare.js ───────────────────────────────────────
 * Dans scrape.js, remplacez UNIQUEMENT la ligne d'import :
 *
 *   AVANT : const { ... } = require('../services/clipCompare');
 *   APRÈS : const { ... } = require('../services/dinoCompare');
 *
 * Tout le reste (noms de fonctions, structure de réponse, logs) est identique.
 * ───────────────────────────────────────────────────────────────────────────
 */

async function isDinoReady() {
  try {
    const r = await axios.get(`${CLIP_BASE}/health`, { timeout: HEALTH_TIMEOUT_MS });
    return r.data?.status === 'ready';
  } catch {
    return false;
  }
}

module.exports.isDinoReady = isDinoReady;
// Alias pour clarté
module.exports.isSigLIPReady = isDinoReady;

