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
}, 10 * 60 * 1000);

// ── Télécharger l'image depuis Etsy ──
async function downloadEtsyImage(etsyUrl) {
  const smallUrl = etsyUrl.replace(/_(fullxfull|\d{3,4}x[^.]*)\\.(?=\w+$)/i, '_570x.');
  for (const url of smallUrl !== etsyUrl ? [smallUrl, etsyUrl] : [etsyUrl]) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.etsy.com/' },
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 100 && (buf[0] === 0xFF || buf[0] === 0x89)) {
        return {
          buffer:   buf,
          mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
        };
      }
    } catch { /* essai suivant */ }
  }
  return null;
}

// ── Uploadcare ──
// Ajoutez UPLOADCARE_PUBLIC_KEY dans les env vars Render
// Compte gratuit sur uploadcare.com (3GB/mois)
async function uploadToUploadcare(buffer, mimeType) {
  const publicKey = process.env.UPLOADCARE_PUBLIC_KEY;
  if (!publicKey) {
    console.error('[freeUploader] UPLOADCARE_PUBLIC_KEY manquant dans les env vars');
    return null;
  }
  try {
    const form = new FormData();
    form.append('UPLOADCARE_PUB_KEY', publicKey);
    form.append('UPLOADCARE_STORE',   '1'); // conserver le fichier (pas de TTL)
    form.append('file', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post('https://upload.uploadcare.com/base/', form, {
      headers: form.getHeaders(),
      timeout: 30000,
      maxContentLength: Infinity,
    });

    const fileId = res.data?.file;
    if (fileId) {
      const url = `https://ucarecdn.com/${fileId}/`;
      console.log('[freeUploader] uploadcare OK', url);
      return url;
    }
  } catch (e) {
    console.warn('[freeUploader] uploadcare failed:', e.message);
  }
  return null;
}

/**
 * Télécharge une image Etsy et l'héberge sur Uploadcare.
 * Nécessite : UPLOADCARE_PUBLIC_KEY dans les env vars Render
 *
 * @param {string} etsyUrl
 * @returns {string|null}
 */
async function uploadImageFree(etsyUrl) {
  if (!etsyUrl) return null;

  const cached = uploadCache.get(etsyUrl);
  if (cached) return cached.value;

  const img = await downloadEtsyImage(etsyUrl);
  if (!img) {
    console.warn('[freeUploader] impossible de télécharger:', etsyUrl);
    return null;
  }

  const url = await uploadToUploadcare(img.buffer, img.mimeType);
  if (url) {
    uploadCache.set(etsyUrl, { value: url, ts: Date.now() });
    return url;
  }

  console.error('[freeUploader] uploadcare a échoué pour', etsyUrl);
  return null;
}

module.exports = { uploadImageFree };
