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
  const urlsToTry = smallUrl !== etsyUrl ? [smallUrl, etsyUrl] : [etsyUrl];

  console.log(`[freeUploader] 📥 Téléchargement image Etsy: ${etsyUrl.slice(0, 80)}...`);

  for (const url of urlsToTry) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.etsy.com/' },
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 100 && (buf[0] === 0xFF || buf[0] === 0x89)) {
        console.log(`[freeUploader] ✅ Image Etsy téléchargée — ${buf.length} bytes, type: ${res.headers['content-type']}`);
        return {
          buffer:   buf,
          mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
        };
      } else {
        console.warn(`[freeUploader] ⚠️ Image invalide depuis ${url.slice(0, 60)} — taille: ${buf.length}, magic: ${buf[0]?.toString(16)} ${buf[1]?.toString(16)}`);
      }
    } catch (e) {
      console.warn(`[freeUploader] ❌ Échec téléchargement Etsy (${url.slice(0, 60)}): ${e.message}`);
    }
  }
  console.error(`[freeUploader] ❌ ÉCHEC TOTAL téléchargement image Etsy: ${etsyUrl.slice(0, 80)}`);
  return null;
}

// ── Service 1 : freeimage.host (clé API publique, sans compte) ──
async function uploadToFreeImageHost(buffer, mimeType) {
  console.log('[freeUploader] 🔄 Tentative freeimage.host...');
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
      console.log(`[freeUploader] ✅ freeimage.host OK → ${url}`);
      return url;
    }
    console.warn(`[freeUploader] ⚠️ freeimage.host — réponse inattendue: ${JSON.stringify(res.data)}`);
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.warn(`[freeUploader] ❌ freeimage.host FAILED — HTTP ${status || 'réseau'}: ${detail}`);
  }
  return null;
}

// ── Service 2 : Uploadcare (clé publique gratuite) ──
async function uploadToUploadcare(buffer, mimeType) {
  const pubKey = process.env.UPLOADCARE_PUBLIC_KEY || 'demopublickey';
  console.log(`[freeUploader] 🔄 Tentative Uploadcare (pubKey: ${pubKey === 'demopublickey' ? '⚠️ DEMO KEY' : pubKey.slice(0, 8) + '...'})...`);
  try {
    const form = new FormData();
    form.append('UPLOADCARE_PUB_KEY', pubKey);
    form.append('UPLOADCARE_STORE', '0');
    form.append('file', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post('https://upload.uploadcare.com/base/', form, {
      headers: form.getHeaders(),
      timeout: 20000,
      maxContentLength: Infinity,
    });

    const uuid = res.data?.file;
    if (uuid) {
      const url = `https://ucarecdn.com/${uuid}/`;
      console.log(`[freeUploader] ✅ Uploadcare OK → uuid: ${uuid} → ${url}`);
      return url;
    }
    console.warn(`[freeUploader] ⚠️ Uploadcare — pas de uuid dans la réponse: ${JSON.stringify(res.data)}`);
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    if (status === 403) {
      console.error(`[freeUploader] ❌ Uploadcare FAILED — 403 Forbidden: clé publique invalide ou quota dépassé. Vérifie UPLOADCARE_PUBLIC_KEY dans tes env vars.`);
    } else if (status === 429) {
      console.error(`[freeUploader] ❌ Uploadcare FAILED — 429 Rate limit atteint`);
    } else {
      console.warn(`[freeUploader] ❌ Uploadcare FAILED — HTTP ${status || 'réseau'}: ${detail}`);
    }
  }
  return null;
}

// ── Service 3 : litterbox (dernier recours) ──
async function uploadToLitterbox(buffer, mimeType) {
  console.log('[freeUploader] 🔄 Tentative litterbox (dernier recours)...');
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
      console.log(`[freeUploader] ✅ litterbox OK → ${url}`);
      return url;
    }
    console.warn(`[freeUploader] ⚠️ litterbox — réponse inattendue: "${res.data}"`);
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.warn(`[freeUploader] ❌ litterbox FAILED — HTTP ${status || 'réseau'}: ${detail}`);
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
  if (cached) {
    console.log(`[freeUploader] 💾 Cache hit → ${cached.value}`);
    return cached.value;
  }

  const img = await downloadEtsyImage(etsyUrl);
  if (!img) {
    console.error('[freeUploader] ❌ BLOQUÉ — impossible de télécharger l\'image Etsy. Ximilar ne pourra pas comparer.');
    return null;
  }

  console.log(`[freeUploader] 📤 Upload en cours (${img.buffer.length} bytes, ${img.mimeType})...`);

  const services = [
    { name: 'freeimage.host', fn: () => uploadToFreeImageHost(img.buffer, img.mimeType) },
    { name: 'Uploadcare',     fn: () => uploadToUploadcare(img.buffer, img.mimeType) },
    { name: 'litterbox',      fn: () => uploadToLitterbox(img.buffer, img.mimeType) },
  ];

  for (const service of services) {
    const url = await service.fn();
    if (url) {
      console.log(`[freeUploader] ✅ Upload réussi via ${service.name} → ${url}`);
      uploadCache.set(etsyUrl, { value: url, ts: Date.now() });
      return url;
    }
  }

  console.error('[freeUploader] ❌ ÉCHEC TOTAL — tous les services d\'upload ont échoué. Ximilar ne sera PAS appelé pour cette image.');
  return null;
}

module.exports = { uploadImageFree };
