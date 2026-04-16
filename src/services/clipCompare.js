/**
 * clipCompare.js  v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Client Node.js pour appeler le microservice Python CLIP (clip_service.py).
 *
 * Nouveautés v2 :
 *   - getAdaptiveThreshold(title) : seuil dynamique selon la catégorie produit
 *   - compareImagesHybrid()       : appelle /compare-hybrid (CLIP + structure)
 *   - findBestAliMatch()          : inchangé, utilise désormais le seuil adaptatif
 *
 * Ce module expose :
 *   - compareImages(etsyUrl, aliUrl, options)         → { similarity, match, scales }
 *   - compareImagesHybrid(etsyUrl, aliUrl, options)   → { similarity, clip_score, structure_score, match }
 *   - findBestAliMatch(etsyUrl, aliUrls, options)     → { bestUrl, similarity, match }
 *   - getAdaptiveThreshold(productTitle)              → number
 *   - isClipAvailable()                               → true si le service répond
 */

const axios = require('axios');

// URL du microservice Python CLIP
// ⚠️  IMPORTANT : le sous-domaine HuggingFace est ENTIÈREMENT en minuscules
// Exemple correct   : https://keeldkdf3-special-clip-service.hf.space
// Exemple incorrect : https://Keeldkdf3-Special-clip-service.hf.space  ← majuscules = erreur DNS
const CLIP_BASE = process.env.CLIP_SERVICE_URL || 'http://localhost:7860';

// Seuil de similarité cosinus par défaut (0.75 = meilleur rappel sur angles différents)
// Augmenter jusqu'à 0.82 pour moins de faux positifs
// Diminuer jusqu'à 0.68 pour plus de sensibilité
const DEFAULT_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.75');


/**
 * Retourne un seuil de similarité adapté à la catégorie produit détectée dans le titre.
 *
 * Logique :
 *  - Bijoux / accessoires : photos très variables (angles, éclairage) → seuil bas
 *  - Vêtements            : coupes similaires entre marques → seuil haut
 *  - Électronique / maison: produits quasi-identiques entre fournisseurs → seuil élevé
 *
 * @param {string} productTitle - Titre du produit Etsy (en n'importe quelle langue)
 * @returns {number} Seuil cosinus entre 0.70 et 0.85
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

  return DEFAULT_THRESHOLD; // 0.78 par défaut
}

// 90s max — HuggingFace Spaces peut avoir un cold start de 60-90s
const TIMEOUT_MS = 90000;

// Timeout court pour le health check (on laisse plus de temps au démarrage)
const HEALTH_TIMEOUT_MS = 8000;


/**
 * Vérifie si le microservice CLIP est disponible.
 * @returns {Promise<boolean>}
 */
async function isClipAvailable() {
  try {
    const r = await axios.get(`${CLIP_BASE}/health`, { timeout: HEALTH_TIMEOUT_MS });
    return r.data?.status === 'ready';
  } catch {
    return false;
  }
}


/**
 * Compare une image Etsy avec une image AliExpress via CLIP.
 *
 * @param {string} etsyUrl   - URL de l'image Etsy
 * @param {string} aliUrl    - URL de l'image AliExpress
 * @param {object} options
 * @param {number} [options.threshold=0.78] - Seuil de similarité cosinus
 * @returns {Promise<{similarity: number, match: boolean, scales: number[], error: string|null, fallback: boolean}>}
 */
async function compareImages(etsyUrl, aliUrl, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (!etsyUrl || !aliUrl) {
    return { similarity: 0, match: false, scales: [], error: 'Missing URLs', fallback: false };
  }

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
    const isConnRefused = e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND';
    if (isConnRefused) {
      console.warn('[clipCompare] CLIP service unavailable — fallback without CLIP comparison');
      return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
    }

    const msg = e.response?.data?.error || e.message;
    console.warn('[clipCompare] Error:', msg);
    return { similarity: 0, match: false, scales: [], error: msg, fallback: false };
  }
}


/**
 * Compare via la route /compare-hybrid (CLIP 75% + structure 25%).
 * Le score structurel combine ratio d'aspect et distance couleur.
 * Recommandé pour réduire les faux positifs sur des produits de forme différente.
 *
 * @param {string} etsyUrl
 * @param {string} aliUrl
 * @param {object} options
 * @param {number} [options.threshold]      - Seuil cosinus (défaut : getAdaptiveThreshold ou 0.78)
 * @param {string} [options.productTitle]   - Titre produit pour seuil adaptatif automatique
 * @returns {Promise<{similarity, clip_score, structure_score, match, scales, error, fallback}>}
 */
async function compareImagesHybrid(etsyUrl, aliUrl, options = {}) {
  const threshold = options.threshold
    ?? getAdaptiveThreshold(options.productTitle || '')
    ?? DEFAULT_THRESHOLD;

  if (!etsyUrl || !aliUrl) {
    return { similarity: 0, match: false, scales: [], error: 'URLs manquantes', fallback: false };
  }

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
    const isConnRefused = e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND';
    if (isConnRefused) {
      console.warn('[clipCompare] Service CLIP indisponible (hybrid) — fallback');
      return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
    }
    const msg = e.response?.data?.error || e.message;
    console.warn('[clipCompare] Erreur hybrid:', msg);
    return { similarity: 0, match: false, scales: [], error: msg, fallback: false };
  }
}


/**
 * Teste plusieurs URLs AliExpress et retourne la meilleure correspondance.
 * Utilise getAdaptiveThreshold si options.productTitle est fourni.
 *
 * @param {string}   etsyUrl  - URL de l'image Etsy
 * @param {string[]} aliUrls  - Liste d'URLs d'images AliExpress
 * @param {object}   options
 * @param {number}   [options.threshold]    - Seuil explicite (prioritaire)
 * @param {string}   [options.productTitle] - Titre pour seuil adaptatif automatique
 * @param {boolean}  [options.hybrid]       - Utiliser /compare-hybrid (défaut: false)
 * @returns {Promise<{bestUrl: string|null, similarity: number, match: boolean, fallback: boolean}>}
 */
async function findBestAliMatch(etsyUrl, aliUrls, options = {}) {
  if (!aliUrls || aliUrls.length === 0) {
    return { bestUrl: null, similarity: 0, match: false, fallback: false };
  }

  // Résolution du seuil : explicite > adaptatif > défaut
  const threshold = options.threshold
    ?? getAdaptiveThreshold(options.productTitle || '')
    ?? DEFAULT_THRESHOLD;

  const compareFn = options.hybrid ? compareImagesHybrid : compareImages;

  // Tester en parallèle (max 5 à la fois)
  const CONCURRENT = 5;
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
 * @param {object} serperMatch - Résultat d'un match Serper Lens
 * @returns {string[]} - Liste d'URLs d'images AliExpress
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
