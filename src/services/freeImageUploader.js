const axios    = require('axios');
const FormData = require('form-data');
const { buildHeaders, humanDelay, fetchProxies, getNextProxy } = require('../utils/antiDetection');

// ── Cache en mémoire avec TTL 1h pour éviter les re-uploads ──
const uploadCache = new Map();
const CACHE_TTL   = 60 * 60 * 1000; // 1 heure

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadCache.entries()) {
    if (now - entry.ts > CACHE_TTL) uploadCache.delete(key);
  }
}, 10 * 60 * 1000);

// ── Télécharger l'image depuis Etsy (avec anti-détection) ──
async function downloadEtsyImage(etsyUrl) {
  await fetchProxies();
  const smallUrl = etsyUrl.replace(/_(fullxfull|\d{3,4}x[^.]*)\\.(?=\w+$)/i, '_570x.');

  for (const url of smallUrl !== etsyUrl ? [smallUrl, etsyUrl] : [etsyUrl]) {
    const MAX_TRIES = 3;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        await humanDelay(500, 2000);
        const proxy = getNextProxy();
        const headers = buildHeaders({ 'Referer': 'https://www.etsy.com/' });

        const config = {
          responseType: 'arraybuffer',
          timeout: 20000,
          headers,
        };

        if (proxy) {
          const proxyUrl = new URL(proxy);
          config.proxy = {
            protocol: proxyUrl.protocol.replace(':', ''),
            host:     proxyUrl.hostname,
            port:     parseInt(proxyUrl.port, 10),
          };
        }

        const res = await axios.get(url, config);
        const buf = Buffer.from(res.data);
        if (buf.length > 100 && (buf[0] === 0xFF || buf[0] === 0x89)) {
          return {
            buffer:   buf,
            mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
          };
        }
      } catch {
        if (attempt < MAX_TRIES - 1) await humanDelay(1000, 3000);
      }
    }
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

// ── Service 2 : Imgur (anonyme via Client-ID) ──
// Recommandé par SerpApi pour Google Lens (pas de blocage d'URLs)
// Ajoute IMGUR_CLIENT_ID dans les env vars Render pour utiliser ta propre app Imgur gratuite
async function uploadToImgur(buffer, mimeType) {
  const rawId  = process.env.IMGUR_CLIENT_ID || '546c25a59c58ad7';
  const authHdr = rawId.startsWith('Client-ID') ? rawId : `Client-ID ${rawId}`;
  try {
    const form = new FormData();
    form.append('image', buffer, { filename: 'image.jpg', contentType: mimeType });
    form.append('type', 'file');

    const res = await axios.post('https://api.imgur.com/3/image', form, {
      headers: { ...form.getHeaders(), Authorization: authHdr },
      timeout: 20000,
      maxContentLength: Infinity,
    });

    const url = res.data?.data?.link;
    if (url && url.startsWith('https://')) {
      console.log('[freeUploader] imgur OK', url);
      return url;
    }
  } catch (e) {
    console.warn('[freeUploader] imgur failed:', e.message);
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
 * Ordre : freeimage.host → Imgur → litterbox
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
    () => uploadToImgur(img.buffer, img.mimeType),
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
