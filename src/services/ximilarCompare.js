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
    console.warn('[ximilar] ⚠️ XIMILAR_API_KEY manquante — skip comparaison');
    return { match: false, distance: null, bestUrl: null, fallback: true };
  }

  if (!etsyUrl || !aliImageUrls || aliImageUrls.length === 0) {
    console.warn('[ximilar] ⚠️ Paramètres manquants — etsyUrl:', !!etsyUrl, '| aliImageUrls:', aliImageUrls?.length ?? 0);
    return { match: false, distance: null, bestUrl: null, fallback: false };
  }

  // Ximilar accepte max 10 records par requête
  const records = aliImageUrls.slice(0, 10).map(url => ({ _url: url }));

  console.log(`[ximilar] 🔄 Appel API — etsyUrl: ${etsyUrl.slice(0, 70)}...`);
  console.log(`[ximilar]    → ${records.length} images AliExpress candidates`);
  console.log(`[ximilar]    → seuil: ${threshold}`);
  records.forEach((r, i) => console.log(`[ximilar]    [${i}] ${r._url.slice(0, 80)}`));

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

    // ── LOG BRUT COMPLET ──
    console.log('[ximilar] 📦 Réponse brute:', JSON.stringify(r.data, null, 2));

    const distances  = r.data.answer_distances || [];
    const answerRecs = r.data.answer_records   || [];

    if (distances.length === 0) {
      console.warn('[ximilar] ⚠️ Aucun résultat retourné — réponse complète:', JSON.stringify(r.data));
      return { match: false, distance: null, bestUrl: null, fallback: false };
    }

    // Log toutes les distances pour calibrer le seuil
    console.log('[ximilar] 📊 Toutes les distances retournées:');
    distances.forEach((d, i) => {
      const url = answerRecs[i]?._url || 'N/A';
      const flag = d <= threshold ? '✅ MATCH' : '❌ hors seuil';
      console.log(`[ximilar]   [${i}] distance=${d.toFixed(4)} ${flag} — ${url.slice(0, 60)}`);
    });

    const bestDistance = distances[0];
    const bestUrl      = answerRecs[0]?._url || null;
    const match        = bestDistance <= threshold;

    console.log(`[ximilar] 🏁 Résultat final: distance=${bestDistance} | seuil=${threshold} | match=${match}`);
    if (!match) {
      console.log(`[ximilar] 💡 Astuce: pour accepter ce match, mets XIMILAR_THRESHOLD=${Math.ceil(bestDistance + 1)} dans tes env vars`);
    }

    return { match, distance: bestDistance, bestUrl, fallback: false };

  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;

    if (status === 401) {
      console.error('[ximilar] ❌ 401 — clé API invalide. Vérifie XIMILAR_API_KEY dans tes env vars.');
      throw new Error('ximilar_401');
    }
    if (status === 402) {
      console.error('[ximilar] ❌ 402 — crédits épuisés. Recharge ton plan sur ximilar.com');
      throw new Error('ximilar_no_credits');
    }
    if (status === 422) {
      console.error(`[ximilar] ❌ 422 — requête invalide. Probablement une URL d'image inaccessible par Ximilar.`);
      console.error(`[ximilar]    etsyUrl envoyé: ${etsyUrl}`);
      console.error(`[ximilar]    Détail: ${detail}`);
      return { match: false, distance: null, bestUrl: null, fallback: true };
    }
    if (e.code === 'ECONNABORTED') {
      console.error(`[ximilar] ❌ Timeout (${TIMEOUT_MS}ms dépassé) — Ximilar n'a pas répondu à temps`);
      return { match: false, distance: null, bestUrl: null, fallback: true };
    }

    console.error(`[ximilar] ❌ Erreur HTTP ${status || 'réseau'}: ${detail}`);
    console.error(`[ximilar]    etsyUrl: ${etsyUrl}`);
    return { match: false, distance: null, bestUrl: null, fallback: true };
  }
}

module.exports = { ximilarRankImages };
