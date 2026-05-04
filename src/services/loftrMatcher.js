/**
 * loftrMatcher.js — Comparaison visuelle via LoFTR (Hugging Face Space)
 * ──────────────────────────────────────────────────────────────────────
 * LoFTR détecte et met en correspondance les keypoints entre deux images
 * même si l'objet est recadré, sous un angle différent ou avec un fond différent.
 *
 * API hébergée sur : https://keeldkdf3-finder.hf.space
 * Variable d'env   : HF_LOFTR_URL (ex: https://keeldkdf3-finder.hf.space)
 * Seuil recommandé : >= 10 keypoints matchés pour confirmer un dropshipper
 */

const axios = require('axios');

const HF_LOFTR_URL      = process.env.HF_LOFTR_URL || 'https://keeldkdf3-finder.hf.space';
const DEFAULT_MIN_MATCHES = parseInt(process.env.LOFTR_MIN_MATCHES || '10');
const REQUEST_TIMEOUT_MS  = 90000; // 90s — HF Space peut être en veille au 1er appel

/**
 * Compare deux images via LoFTR hébergé sur HF Space.
 *
 * @param {string} image0Url  URL publique de l'image Etsy (après upload Litterbox)
 * @param {string} image1Url  URL publique de l'image AliExpress
 * @returns {Promise<{ match: boolean, numMatches: number, fallback: boolean }>}
 */
async function loftrCompare(image0Url, image1Url) {
  if (!HF_LOFTR_URL) {
    console.warn('[loftr] ⚠️ HF_LOFTR_URL manquant — skip comparaison');
    return { match: false, numMatches: 0, fallback: true };
  }

  if (!image0Url || !image1Url) {
    console.warn('[loftr] ⚠️ URLs manquantes');
    return { match: false, numMatches: 0, fallback: false };
  }

  console.log(`[loftr] 🔄 Lancement LoFTR via HF Space...`);
  console.log(`[loftr]    image0 (Etsy):       ${image0Url.slice(0, 80)}`);
  console.log(`[loftr]    image1 (AliExpress): ${image1Url.slice(0, 80)}`);

  try {
    const { data } = await axios.post(
      `${HF_LOFTR_URL}/match`,
      {
        image0_url: image0Url,
        image1_url: image1Url,
        min_confidence: 0.5,
      },
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const numMatches = typeof data.num_matches === 'number' ? data.num_matches : 0;
    const match      = numMatches >= DEFAULT_MIN_MATCHES;

    console.log(`[loftr] 🏁 Résultat: ${numMatches} keypoints matchés | seuil=${DEFAULT_MIN_MATCHES} | match=${match}`);
    if (typeof data.avg_confidence === 'number') {
      console.log(`[loftr] 📊 Confiance moyenne: ${data.avg_confidence.toFixed(3)}`);
    }
    if (!match) {
      console.log(`[loftr] 💡 Pour accepter ce match, mets LOFTR_MIN_MATCHES=${Math.max(1, numMatches)} dans tes env vars`);
    }

    return { match, numMatches, fallback: false };

  } catch (e) {
    const status  = e.response?.status;
    const detail  = e.response?.data ? JSON.stringify(e.response.data) : e.message;

    if (e.code === 'ECONNABORTED' || e.message?.includes('timeout')) {
      console.error('[loftr] ❌ Timeout — le HF Space est peut-être en veille, réessaie dans 30s');
      return { match: false, numMatches: 0, fallback: true };
    }

    if (status === 503) {
      console.error('[loftr] ❌ 503 — HF Space en cours de démarrage, réessaie dans 20s');
      return { match: false, numMatches: 0, fallback: true };
    }

    if (status === 422) {
      console.error(`[loftr] ❌ 422 — Données invalides envoyées à l'API: ${detail}`);
      return { match: false, numMatches: 0, fallback: false };
    }

    console.error(`[loftr] ❌ Erreur HTTP ${status || 'réseau'}: ${detail}`);
    return { match: false, numMatches: 0, fallback: true };
  }
}

/**
 * Compare une image Etsy contre plusieurs candidats AliExpress.
 * Retourne le meilleur match LoFTR.
 *
 * @param {string}   etsyPubUrl   URL publique Etsy (Litterbox)
 * @param {object[]} aliMatches   Candidats retournés par Google Lens
 * @returns {Promise<{ best: object|null, numMatches: number }>}
 */
async function findBestLoFTRMatch(etsyPubUrl, aliMatches) {
  if (!aliMatches || aliMatches.length === 0) return { best: null, numMatches: 0 };

  // On teste les 3 premiers candidats AliExpress pour limiter les appels
  const candidates = aliMatches.slice(0, 3);

  let bestNumMatches = 0;
  let bestCandidate  = null;

  for (const candidate of candidates) {
    const aliImageUrl = candidate.imageUrl || candidate.thumbnailUrl;
    if (!aliImageUrl) continue;

    try {
      const { match, numMatches, fallback } = await loftrCompare(etsyPubUrl, aliImageUrl);

      console.log(`[loftr] Candidat ${aliImageUrl.slice(0, 60)}… → ${numMatches} matches`);

      if (numMatches > bestNumMatches) {
        bestNumMatches = numMatches;
        bestCandidate  = { ...candidate, numMatches };
      }

      // Si on a un match clair on arrête
      if (match) break;

      // Si fallback (HF Space indisponible) on arrête tout
      if (fallback) break;

    } catch (e) {
      console.warn(`[loftr] skip candidat: ${e.message}`);
    }
  }

  return {
    best:       bestNumMatches >= DEFAULT_MIN_MATCHES ? bestCandidate : null,
    numMatches: bestNumMatches,
  };
}

module.exports = { loftrCompare, findBestLoFTRMatch };
