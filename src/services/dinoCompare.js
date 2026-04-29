/**
 * dinoCompare.js  (remplace clipCompare.js)
 * ─────────────────────────────────────────────────────────────────────────────
 * Client Node.js pour appeler le microservice Python DINOv2 (dino_service.py).
 *
 * Interface IDENTIQUE à clipCompare.js — aucun changement requis dans scrape.js
 * sauf l'import (voir commentaire en bas du fichier).
 *
 * DINOv2 (facebook/dinov2-base) remplace CLIP (openai/clip-vit-large-patch14) :
 *   - Embeddings purement visuels → meilleure comparaison objet-à-objet
 *   - Plus robuste aux changements de fond / éclairage / recadrage
 *   - Même routes exposées : /compare-images, /compare-hybrid, /health
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
// Exemple correct   : https://monuser-special-dino-service.hf.space
// Exemple incorrect : https://MonUser-Special-dino-service.hf.space  ← majuscules = erreur DNS
const CLIP_BASE = process.env.CLIP_SERVICE_URL || 'http://localhost:7860';

// Seuil de similarité cosinus par défaut
// DINOv2 produit des embeddings visuels purs → les scores sont légèrement différents de CLIP
// 0.75 est un bon point de départ (vs 0.78 pour CLIP)
const DEFAULT_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.75');


/**
 * Retourne un seuil de similarité adapté à la catégorie produit détectée dans le titre.
 * (Même logique que clipCompare.js — ajustée pour DINOv2 qui est légèrement plus sensible)
 *
 * @param {string} productTitle
 * @returns {number} Seuil cosinus entre 0.68 et 0.82
 */
function getAdaptiveThreshold(productTitle = '') {
  const title = productTitle.toLowerCase();

  // Bijoux & accessoires : photos très variables → seuil plus bas
  if (/ring|necklace|earring|bracelet|jewelry|pendant|charm|bangle|brooch/.test(title)) {
    return 0.68;
  }

  // Maroquinerie & sacs : silhouettes proches → seuil modéré-haut
  if (/bag|purse|wallet|handbag|tote|clutch|backpack|pouch/.test(title)) {
    return 0.76;
  }

  // Vêtements : coupes similaires fréquentes entre marques → seuil haut
  if (/dress|shirt|pants|jeans|hoodie|jacket|coat|skirt|blouse|sweater|legging/.test(title)) {
    return 0.78;
  }

  // Électronique & accessoires tech : produits quasi-identiques → seuil élevé
  if (/phone|case|charger|cable|led|lamp|keyboard|mouse|headphone|earphone/.test(title)) {
    return 0.82;
  }

  // Décoration / art / home : créations uniques → seuil bas
  if (/print|poster|art|painting|decor|candle|frame|pillow|cushion/.test(title)) {
    return 0.70;
  }

  return DEFAULT_THRESHOLD; // 0.75 par défaut
}

// 90s max — HuggingFace Spaces peut avoir un cold start de 60-90s
const TIMEOUT_MS = 90000;

// Timeout court pour le health check
const HEALTH_TIMEOUT_MS = 8000;


/**
 * Vérifie si le microservice DINOv2 est disponible.
 * @returns {Promise<boolean>}
 */
async function isClipAvailable() {
  try {
    const r = await axios.get(`${CLIP_BASE}/health`, { timeout: HEALTH_TIMEOUT_MS });
    const status = r.data?.status;
    return status === "ready" || status === "loading";
  } catch {
    return false;
  }
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

  const MAX_RETRIES = 2;
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
        const wait = 2000 * (attempt + 1); // 2s, 4s
        console.warn(`[dinoCompare] HTTP ${httpStatus} — retry ${attempt + 1}/${MAX_RETRIES} dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (isConnRefused || isServerError) {
        console.warn(`[dinoCompare] Service DINOv2 indisponible (${isServerError ? 'HTTP ' + httpStatus : e.code}) — fallback sans comparaison visuelle`);
        return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
      }
      const msg = e.response?.data?.error || e.message;
      console.warn('[dinoCompare] Erreur:', msg);
      return { similarity: 0, match: false, scales: [], error: msg, fallback: false };
    }
  }
}


/**
 * Compare via /compare-hybrid (DINOv2 75% + structure 25%).
 *
 * FIX : ajout d'un mécanisme de retry (MAX_RETRIES = 2) identique à compareImages.
 * Avant ce fix, un HTTP 500 passager (cold start HuggingFace) déclenchait un
 * fallback immédiat sans aucune tentative supplémentaire, causant l'ignorance
 * silencieuse de nombreux shops dans les logs.
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

  const MAX_RETRIES = 2; // ← FIX : retry sur 500 avant de fallback (était absent)
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const r = await axios.post(
        `${CLIP_BASE}/compare-hybrid`,
        { etsy_url: etsyUrl, ali_url: aliUrl, threshold },
        { timeout: TIMEOUT_MS }
      );

      return {
        similarity:      r.data.similarity      ?? 0,
        clip_score:      r.data.clip_score       ?? 0,  // = dino_score côté Python
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

      // ← FIX : retry sur 500 avec backoff exponentiel (2s, 4s)
      if (isServerError && attempt < MAX_RETRIES) {
        const wait = 2000 * (attempt + 1);
        console.warn(`[dinoCompare] HTTP ${httpStatus} hybrid — retry ${attempt + 1}/${MAX_RETRIES} dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }

      if (isConnRefused || isServerError) {
        console.warn(`[dinoCompare] Service DINOv2 indisponible (hybrid) (${isServerError ? 'HTTP ' + httpStatus : e.code}) — fallback`);
        return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
      }
      const msg = e.response?.data?.error || e.message;
      console.warn('[dinoCompare] Erreur hybrid:', msg);
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

  const CONCURRENT = 2; // réduit de 5 à 2 — HuggingFace Space gratuit (CPU) ne supporte pas 5 req parallèles
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
 * Extrait les URLs d'images depuis un résultat AliExpress (Serper Lens ou scraping).
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
  isClipAvailable,      // conserve le nom pour compatibilité avec scrape.js
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
 * Et renommez la variable d'env du service HuggingFace :
 *   CLIP_SERVICE_URL=https://monuser-special-dino-service.hf.space
 *
 * Tout le reste (noms de fonctions, structure de réponse, logs) est identique.
 * ───────────────────────────────────────────────────────────────────────────
 */

// Exported separately: returns true only when status === 'ready' (model fully loaded)
async function isDinoReady() {
  try {
    const r = await axios.get(`${CLIP_BASE}/health`, { timeout: HEALTH_TIMEOUT_MS });
    return r.data?.status === 'ready';
  } catch {
    return false;
  }
}

// Add to exports (patch)
module.exports.isDinoReady = isDinoReady;
