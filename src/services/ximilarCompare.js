/**
 * ximilarCompare.js — Comparaison visuelle via Ximilar Image Matching API
 * ────────────────────────────────────────────────────────────────────────
 * Utilise /image_matching/v2/rank_images :
 *   - query_record  = image Etsy (URL publique après upload)
 *   - records       = images AliExpress trouvées par Google Lens
 *   - answer_distances[0] = distance du meilleur match (0 = identique, ~26 = différent)
 *
 * Seuil recommandé : <= 10 pour confirmer un dropshipper
 * Variable d'env : XIMILAR_API_KEY, XIMILAR_THRESHOLD (défaut: 10)
 */

const axios = require('axios');

const XIMILAR_BASE      = 'https://api.ximilar.com/image_matching/v2';
const DEFAULT_THRESHOLD = parseFloat(process.env.XIMILAR_THRESHOLD || '10');
const TIMEOUT_MS        = 20000;

/**
 * Compare une image Etsy contre une liste d'images AliExpress via Ximilar.
 * Retourne le meilleur match si la distance est sous le seuil.
 *
 * @param {string}   etsyUrl      URL publique de l'image Etsy (après upload)
 * @param {string[]} aliImageUrls URLs des images AliExpress candidates
 * @param {number}   [threshold]  Distance max pour valider (défaut: 10)
 * @returns {Promise<{ match: boolean, distance: number|null, bestUrl: string|null, fallback: boolean }>}
 */
async function ximilarRankImages(etsyUrl, aliImageUrls, threshold = DEFAULT_THRESHOLD) {
  const apiKey = process.env.XIMILAR_API_KEY;

  if (!apiKey) {
    console.warn('[ximilar] XIMILAR_API_KEY manquante — skip comparaison');
    return { match: false, distance: null, bestUrl: null, fallback: true };
  }

  if (!etsyUrl || !aliImageUrls || aliImageUrls.length === 0) {
    return { match: false, distance: null, bestUrl: null, fallback: false };
  }

  // Ximilar accepte max 10 records par requête
  const records = aliImageUrls.slice(0, 10).map(url => ({ _url: url }));

  try {
    const r = await axios.post(
      `${XIMILAR_BASE}/rank_images`,
      {
        query_record: { _url: etsyUrl },
        records,
        hash_type: 'bmh1',
      },
      {
        headers: {
          'Authorization': `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );

    const distances    = r.data.answer_distances || [];
    const answerRecs   = r.data.answer_records   || [];

    if (distances.length === 0) {
      console.log('[ximilar] Aucun résultat retourné');
      return { match: false, distance: null, bestUrl: null, fallback: false };
    }

    const bestDistance = distances[0];
    const bestUrl      = answerRecs[0]?._url || null;
    const match        = bestDistance <= threshold;

    console.log(`[ximilar] distance=${bestDistance} seuil=${threshold} match=${match} url=${bestUrl?.slice(-40)}`);

    return { match, distance: bestDistance, bestUrl, fallback: false };

  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data?.status?.text || e.message;

    if (status === 401) {
      console.error('[ximilar] 401 — clé API invalide');
      throw new Error('ximilar_401');
    }
    if (status === 402) {
      console.error('[ximilar] 402 — crédits épuisés');
      throw new Error('ximilar_no_credits');
    }

    console.warn(`[ximilar] Erreur ${status || 'réseau'}: ${detail} — fallback`);
    return { match: false, distance: null, bestUrl: null, fallback: true };
  }
}

module.exports = { ximilarRankImages };
