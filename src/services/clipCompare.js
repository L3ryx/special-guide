/**
 * clipCompare.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Client Node.js pour appeler le microservice Python CLIP (clip_service.py).
 *
 * Ce module expose :
 *   - compareImages(etsyUrl, aliUrl, options)  → { similarity, match, scales }
 *   - findBestAliMatch(etsyUrl, aliUrls, options) → { bestUrl, similarity, match }
 *   - isClipAvailable()  → true si le service répond
 *
 * Le microservice tourne sur HuggingFace Spaces (configurable via CLIP_SERVICE_URL).
 * Si le service est indisponible, les fonctions retournent { match: false, fallback: true }
 * sans bloquer le flow principal.
 *
 * Usage :
 *   const { compareImages, findBestAliMatch } = require('./clipCompare');
 *   const result = await compareImages(etsyImageUrl, aliImageUrl);
 *   if (result.match) console.log('Objet trouvé !', result.similarity);
 */

const axios = require('axios');

// URL du microservice Python CLIP
// ⚠️  IMPORTANT : le sous-domaine HuggingFace est ENTIÈREMENT en minuscules
// Exemple correct   : https://keeldkdf3-special-clip-service.hf.space
// Exemple incorrect : https://Keeldkdf3-Special-clip-service.hf.space  ← majuscules = erreur DNS
const CLIP_BASE = process.env.CLIP_SERVICE_URL || 'http://localhost:7860';

// Seuil de similarité cosinus par défaut (0.78 = bon équilibre précision/rappel)
// Augmenter jusqu'à 0.85 pour moins de faux positifs
// Diminuer jusqu'à 0.70 pour plus de sensibilité
const DEFAULT_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.78');

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
    return { similarity: 0, match: false, scales: [], error: 'URLs manquantes', fallback: false };
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
      console.warn('[clipCompare] Service CLIP indisponible — fallback sans comparaison CLIP');
      return { similarity: 0, match: false, scales: [], error: 'service_unavailable', fallback: true };
    }

    const msg = e.response?.data?.error || e.message;
    console.warn('[clipCompare] Erreur:', msg);
    return { similarity: 0, match: false, scales: [], error: msg, fallback: false };
  }
}


/**
 * Teste plusieurs URLs AliExpress et retourne la meilleure correspondance.
 *
 * @param {string}   etsyUrl  - URL de l'image Etsy
 * @param {string[]} aliUrls  - Liste d'URLs d'images AliExpress
 * @param {object}   options
 * @returns {Promise<{bestUrl: string|null, similarity: number, match: boolean, fallback: boolean}>}
 */
async function findBestAliMatch(etsyUrl, aliUrls, options = {}) {
  if (!aliUrls || aliUrls.length === 0) {
    return { bestUrl: null, similarity: 0, match: false, fallback: false };
  }

  // Tester en parallèle (max 5 à la fois)
  const CONCURRENT = 5;
  let bestSimilarity = -1;
  let bestUrl        = null;
  let anyFallback    = false;

  for (let i = 0; i < aliUrls.length; i += CONCURRENT) {
    const batch   = aliUrls.slice(i, i + CONCURRENT);
    const results = await Promise.allSettled(
      batch.map(url => compareImages(etsyUrl, url, options))
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

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
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
  findBestAliMatch,
  extractAliImageUrls,
  DEFAULT_THRESHOLD,
};
