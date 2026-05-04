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

// ── Uploadcare (service principal) ──
// Utilise l'API REST Uploadcare avec la clé publique via upload direct
async function uploadToUploadcare(buffer, mimeType) {
  const publicKey = process.env.UPLOADCARE_PUBLIC_KEY;
  if (!publicKey) {
    console.warn('[uploadcareUploader] UPLOADCARE_PUBLIC_KEY not set');
    return null;
  }
  try {
    const form = new FormData();
    form.append('UPLOADCARE_PUB_KEY', publicKey);
    form.append('UPLOADCARE_STORE', '1');
    form.append('file', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post('https://upload.uploadcare.com/base/', form, {
      headers: { ...form.getHeaders() },
      timeout: 30000,
      maxContentLength: Infinity,
    });

    const uuid = res.data?.file;
    if (uuid) {
      const url = `https://ucarecdn.com/${uuid}/`;
      console.log('[uploadcareUploader] Uploadcare OK', url);
      return url;
    }
  } catch (e) {
    console.warn('[uploadcareUploader] Uploadcare failed:', e.message);
  }
  return null;
}

/**
 * Télécharge une image Etsy et l'héberge sur Uploadcare.
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
    console.warn('[uploadcareUploader] impossible de télécharger:', etsyUrl);
    return null;
  }

  const url = await uploadToUploadcare(img.buffer, img.mimeType);
  if (url) {
    uploadCache.set(etsyUrl, { value: url, ts: Date.now() });
    return url;
  }

  console.error('[uploadcareUploader] upload Uploadcare échoué pour', etsyUrl);
  return null;
}

module.exports = { uploadImageFree };
