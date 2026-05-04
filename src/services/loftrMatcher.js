/**
 * loftrMatcher.js — Comparaison visuelle via LoFTR (Replicate API)
 * ────────────────────────────────────────────────────────────────
 * LoFTR détecte et met en correspondance les keypoints entre deux images
 * même si l'objet est recadré, sous un angle différent ou avec un fond différent.
 *
 * Modèle : rajmund-loftr sur Replicate
 * Variable d'env : REPLICATE_API_TOKEN
 * Seuil recommandé : >= 10 keypoints matchés pour confirmer un dropshipper
 */

const axios = require('axios');

const REPLICATE_BASE   = 'https://api.replicate.com/v1';
const LOFTR_VERSION    = 'ca460396ab85c897f849db6f4f5b6dbfbf78bd1f28434fd374b12be7b3f77e2b';
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS      = 60000;
const DEFAULT_MIN_MATCHES = parseInt(process.env.LOFTR_MIN_MATCHES || '10');

/**
 * Compare deux images via LoFTR et retourne le nombre de keypoints matchés.
 *
 * @param {string} image0Url  URL publique de l'image Etsy (après upload Litterbox)
 * @param {string} image1Url  URL publique de l'image AliExpress
 * @returns {Promise<{ match: boolean, numMatches: number, fallback: boolean }>}
 */
async function loftrCompare(image0Url, image1Url) {
  const apiToken = process.env.REPLICATE_API_TOKEN;

  if (!apiToken) {
    console.warn('[loftr] ⚠️ REPLICATE_API_TOKEN manquant — skip comparaison');
    return { match: false, numMatches: 0, fallback: true };
  }

  if (!image0Url || !image1Url) {
    console.warn('[loftr] ⚠️ URLs manquantes');
    return { match: false, numMatches: 0, fallback: false };
  }

  console.log(`[loftr] 🔄 Lancement LoFTR...`);
  console.log(`[loftr]    image0 (Etsy):       ${image0Url.slice(0, 80)}`);
  console.log(`[loftr]    image1 (AliExpress): ${image1Url.slice(0, 80)}`);

  let predictionId;

  // ── Créer la prédiction ──
  try {
    const res = await axios.post(
      `${REPLICATE_BASE}/predictions`,
      {
        version: LOFTR_VERSION,
        input: {
          image0: image0Url,
          image1: image1Url,
        },
      },
      {
        headers: {
          'Authorization': `Token ${apiToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    predictionId = res.data?.id;
    if (!predictionId) {
      console.error('[loftr] ❌ Pas d\'ID de prédiction dans la réponse');
      return { match: false, numMatches: 0, fallback: true };
    }

    console.log(`[loftr] 📋 Prédiction créée: ${predictionId}`);
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    if (status === 401) {
      console.error('[loftr] ❌ 401 — REPLICATE_API_TOKEN invalide');
      throw new Error('replicate_401');
    }
    if (status === 402) {
      console.error('[loftr] ❌ 402 — Crédits Replicate épuisés');
      throw new Error('replicate_no_credits');
    }
    console.error(`[loftr] ❌ Erreur création prédiction — HTTP ${status || 'réseau'}: ${detail}`);
    return { match: false, numMatches: 0, fallback: true };
  }

  // ── Polling jusqu'au résultat ──
  const startTime = Date.now();
  while (Date.now() - startTime < MAX_WAIT_MS) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

    let prediction;
    try {
      const res = await axios.get(
        `${REPLICATE_BASE}/predictions/${predictionId}`,
        {
          headers: { 'Authorization': `Token ${apiToken}` },
          timeout: 10000,
        }
      );
      prediction = res.data;
    } catch (e) {
      console.warn(`[loftr] ⚠️ Erreur polling: ${e.message}`);
      continue;
    }

    const status = prediction.status;
    console.log(`[loftr] ⏳ Status: ${status} (${Math.round((Date.now() - startTime) / 1000)}s)`);

    if (status === 'failed' || status === 'canceled') {
      console.error(`[loftr] ❌ Prédiction ${status}: ${prediction.error || 'inconnu'}`);
      return { match: false, numMatches: 0, fallback: true };
    }

    if (status === 'succeeded') {
      const output = prediction.output;

      // Le modèle retourne { num_matches: N, ... } ou un tableau de keypoints
      let numMatches = 0;

      if (typeof output?.num_matches === 'number') {
        numMatches = output.num_matches;
      } else if (Array.isArray(output?.keypoints0)) {
        numMatches = output.keypoints0.length;
      } else if (Array.isArray(output)) {
        numMatches = output.length;
      }

      const match = numMatches >= DEFAULT_MIN_MATCHES;

      console.log(`[loftr] 🏁 Résultat: ${numMatches} keypoints matchés | seuil=${DEFAULT_MIN_MATCHES} | match=${match}`);
      if (!match) {
        console.log(`[loftr] 💡 Pour accepter ce match, mets LOFTR_MIN_MATCHES=${Math.max(1, numMatches)} dans tes env vars`);
      }

      return { match, numMatches, fallback: false };
    }
  }

  console.error(`[loftr] ❌ Timeout — prédiction ${predictionId} n'a pas abouti en ${MAX_WAIT_MS / 1000}s`);
  return { match: false, numMatches: 0, fallback: true };
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

  // On teste les 3 premiers candidats AliExpress pour limiter les appels Replicate
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

      // Si fallback (pas de token) on arrête tout
      if (fallback && !process.env.REPLICATE_API_TOKEN) break;

    } catch (e) {
      if (e.message === 'replicate_401' || e.message === 'replicate_no_credits') throw e;
      console.warn(`[loftr] skip candidat: ${e.message}`);
    }
  }

  const minMatches = DEFAULT_MIN_MATCHES;
  return {
    best:        bestNumMatches >= minMatches ? bestCandidate : null,
    numMatches:  bestNumMatches,
  };
}

module.exports = { loftrCompare, findBestLoFTRMatch };
