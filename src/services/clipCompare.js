/**
 * clipCompare.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Client Node.js pour le microservice CLIP hébergé sur Hugging Face Spaces.
 *
 * CLIP est OBLIGATOIRE — aucun fallback pHash.
 * Si le service est indisponible, une erreur est levée.
 *
 * Variables d'environnement requises :
 *   CLIP_SERVICE_URL  → URL HuggingFace Spaces (ex: https://user-clip-app.hf.space)
 *   HF_SECRET_TOKEN   → Token secret partagé avec le Space HF
 *   CLIP_THRESHOLD    → Seuil similarité cosinus (défaut : 0.78)
 */

const axios = require('axios');

const CLIP_BASE        = process.env.CLIP_SERVICE_URL;
const HF_SECRET_TOKEN  = process.env.HF_SECRET_TOKEN || '';
const DEFAULT_THRESHOLD = parseFloat(process.env.CLIP_THRESHOLD || '0.78');
const TIMEOUT_MS       = 60000; // 60s (démarrage à froid HF Spaces possible)

if (!CLIP_BASE) {
  console.error('[clipCompare] ❌ CLIP_SERVICE_URL manquant dans les variables d\'environnement !');
}

// Headers d'authentification vers HF Spaces
function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (HF_SECRET_TOKEN) h['Authorization'] = `Bearer ${HF_SECRET_TOKEN}`;
  return h;
}

/**
 * Vérifie si le microservice CLIP est disponible.
 * @returns {Promise<boolean>}
 */
async function isClipAvailable() {
  if (!CLIP_BASE) return false;
  try {
    const r = await axios.get(`${CLIP_BASE}/health`, {
      timeout: 10000,
      headers: authHeaders(),
    });
    return r.data?.status === 'ready';
  } catch {
    return false;
  }
}

/**
 * Compare une image Etsy avec une image AliExpress via CLIP.
 * Lance une erreur si CLIP est indisponible (pas de fallback).
 *
 * @param {string} etsyUrl
 * @param {string} aliUrl
 * @param {object} options
 * @param {number} [options.threshold]
 * @returns {Promise<{similarity: number, match: boolean, scales: number[], error: string|null}>}
 */
async function compareImages(etsyUrl, aliUrl, options = {}) {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (!CLIP_BASE) {
    throw new Error('[clipCompare] CLIP_SERVICE_URL non configuré');
  }
  if (!etsyUrl || !aliUrl) {
    throw new Error('[clipCompare] URLs manquantes');
  }

  try {
    const r = await axios.post(
      `${CLIP_BASE}/compare-images`,
      { etsy_url: etsyUrl, ali_url: aliUrl, threshold },
      { timeout: TIMEOUT_MS, headers: authHeaders() }
    );

    return {
      similarity: r.data.similarity ?? 0,
      match:      r.data.match      ?? false,
      scales:     r.data.scales     ?? [],
      error:      r.data.error      ?? null,
    };

  } catch (e) {
    const status = e.response?.status;

    if (status === 401) {
      throw new Error('[clipCompare] Token HF invalide (401) — vérifie HF_SECRET_TOKEN');
    }
    if (status === 503) {
      throw new Error('[clipCompare] CLIP non chargé sur HF Spaces (503) — Space en démarrage ?');
    }
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
      throw new Error('[clipCompare] Service CLIP inaccessible — vérifie CLIP_SERVICE_URL');
    }

    const msg = e.response?.data?.error || e.message;
    throw new Error(`[clipCompare] Erreur : ${msg}`);
  }
}

/**
 * Teste plusieurs URLs AliExpress et retourne la meilleure correspondance.
 * Lance une erreur si CLIP est indisponible.
 *
 * @param {string}   etsyUrl
 * @param {string[]} aliUrls
 * @param {object}   options
 * @returns {Promise<{bestUrl: string|null, similarity: number, match: boolean}>}
 */
async function findBestAliMatch(etsyUrl, aliUrls, options = {}) {
  if (!aliUrls || aliUrls.length === 0) {
    return { bestUrl: null, similarity: 0, match: false };
  }

  const CONCURRENT    = 3;
  let bestSimilarity  = -1;
  let bestUrl         = null;

  for (let i = 0; i < aliUrls.length; i += CONCURRENT) {
    const batch   = aliUrls.slice(i, i + CONCURRENT);
    const results = await Promise.allSettled(
      batch.map(url => compareImages(etsyUrl, url, options))
    );

    for (let j = 0; j < results.length; j++) {
      if (results[j].status !== 'fulfilled') {
        // Propager la première erreur CLIP rencontrée
        throw results[j].reason;
      }
      const r = results[j].value;
      if (r.similarity > bestSimilarity) {
        bestSimilarity = r.similarity;
        bestUrl        = batch[j];
      }
    }
  }

  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  return {
    bestUrl,
    similarity: bestSimilarity >= 0 ? Math.round(bestSimilarity * 1000) / 1000 : 0,
    match:      bestSimilarity >= threshold,
  };
}

/**
 * Extrait les URLs d'images depuis un résultat AliExpress (Serper Lens).
 * @param {object} serperMatch
 * @returns {string[]}
 */
function extractAliImageUrls(serperMatch) {
  if (!serperMatch) return [];
  return [...new Set([
    serperMatch.imageUrl,
    serperMatch.thumbnailUrl,
    serperMatch.image,
  ].filter(Boolean))];
}

module.exports = {
  isClipAvailable,
  compareImages,
  findBestAliMatch,
  extractAliImageUrls,
  DEFAULT_THRESHOLD,
};
