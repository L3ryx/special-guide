const axios    = require('axios');
const FormData = require('form-data');

// ── Cache en mémoire avec TTL 1h pour éviter les re-uploads ──
const uploadCache = new Map();
const CACHE_TTL   = 60 * 60 * 1000; // 1 heure

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadCache.entries()) {
    if (now - entry.ts > CACHE_TTL) uploadCache.delete(key);
  }
}, 10 * 60 * 1000); // nettoyage toutes les 10 min

/**
 * Télécharge une image Etsy et l'héberge sur litterbox (catbox.moe).
 * Retourne une URL publique utilisable par Serper Lens.
 * Pas de clé API requise — TTL 1h — max 1 GB.
 *
 * @param {string} etsyUrl  URL i.etsystatic.com à uploader
 * @returns {string|null}   URL publique ou null en cas d'échec
 */
async function uploadImageFree(etsyUrl) {
  if (!etsyUrl) return null;

  // Vérifier le cache
  const cached = uploadCache.get(etsyUrl);
  if (cached) return cached.value;

  // ── Étape 1 : télécharger l'image depuis Etsy ──
  let imgBuffer;
  let mimeType = 'image/jpeg';

  // Essayer d'abord la version allégée 570px
  const smallUrl = etsyUrl.replace(/_(fullxfull|\d{3,4}x[^.]*)\.(?=\w+$)/i, '_570x.');
  for (const url of smallUrl !== etsyUrl ? [smallUrl, etsyUrl] : [etsyUrl]) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.etsy.com/' },
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 100 && (buf[0] === 0xFF || buf[0] === 0x89)) {
        imgBuffer = buf;
        mimeType  = (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
        break;
      }
    } catch { /* essai suivant */ }
  }

  if (!imgBuffer) {
    console.warn('[freeUploader] impossible de télécharger:', etsyUrl);
    return null;
  }

  // ── Étape 2 : uploader sur litterbox (catbox.moe) ──
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time',    '1h');
    form.append('fileToUpload', imgBuffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
      headers: form.getHeaders(),
      timeout: 20000,
      maxContentLength: Infinity,
    });

    const url = res.data?.trim();
    if (url && url.startsWith('https://')) {
      uploadCache.set(etsyUrl, { value: url, ts: Date.now() });
      console.log('[freeUploader] litterbox ✅', url);
      return url;
    }
  } catch (e) {
    console.warn('[freeUploader] litterbox failed:', e.message);
  }

  console.error('[freeUploader] upload échoué pour', etsyUrl);
  return null;
}

module.exports = { uploadImageFree };
