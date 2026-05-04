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

// ── Service 1 : freeimage.host (clé API publique, sans compte) ──
async function uploadToFreeImageHost(buffer, mimeType) {
  try {
    const base64 = buffer.toString('base64');
    const params = new URLSearchParams();
    params.append('key', '6d207e02198a847aa98d0a2a901485a5');
    params.append('source', base64);
    params.append('format', 'json');

    const res = await axios.post('https://freeimage.host/api/1/upload', params, {
      timeout: 20000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const url = res.data?.image?.url;
    if (url && url.startsWith('https://')) {
      console.log('[freeUploader] freeimage.host OK', url);
      return url;
    }
  } catch (e) {
    console.warn('[freeUploader] freeimage.host failed:', e.message);
  }
  return null;
}

// ── Service 2 : Uploadcare (clé publique gratuite) ──
// Upload direct via l'API Uploadcare — URL publique stable, pas de blocage Serper
// Ajoute UPLOADCARE_PUBLIC_KEY dans les env vars Render pour ta propre clé
async function uploadToUploadcare(buffer, mimeType) {
  const pubKey = process.env.UPLOADCARE_PUBLIC_KEY || 'demopublickey';
  try {
    const form = new FormData();
    form.append('UPLOADCARE_PUB_KEY', pubKey);
    form.append('UPLOADCARE_STORE', '0'); // pas de stockage permanent
    form.append('file', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post('https://upload.uploadcare.com/base/', form, {
      headers: form.getHeaders(),
      timeout: 20000,
      maxContentLength: Infinity,
    });

    const uuid = res.data?.file;
    if (uuid) {
      const url = `https://ucarecdn.com/${uuid}/`;
      console.log('[freeUploader] uploadcare OK', url);
      return url;
    }
  } catch (e) {
    console.warn('[freeUploader] uploadcare failed:', e.message);
  }
  return null;
}

// ── Service 3 : litterbox (dernier recours) ──
async function uploadToLitterbox(buffer, mimeType) {
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time',    '1h');
    form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
      headers: form.getHeaders(),
      timeout: 20000,
      maxContentLength: Infinity,
    });

    const url = res.data?.trim();
    if (url && url.startsWith('https://')) {
      console.log('[freeUploader] litterbox OK', url);
      return url;
    }
  } catch (e) {
    console.warn('[freeUploader] litterbox failed:', e.message);
  }
  return null;
}

/**
 * Télécharge une image Etsy et l'héberge sur un service public gratuit.
 * Ordre : freeimage.host → Uploadcare → litterbox
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

  const services = [
    () => uploadToFreeImageHost(img.buffer, img.mimeType),
    () => uploadToUploadcare(img.buffer, img.mimeType),
    () => uploadToLitterbox(img.buffer, img.mimeType),
  ];

  for (const service of services) {
    const url = await service();
    if (url) {
      uploadCache.set(etsyUrl, { value: url, ts: Date.now() });
      return url;
    }
  }

  console.error('[freeUploader] tous les services ont échoué pour', etsyUrl);
  return null;
}

module.exports = { uploadImageFree };
