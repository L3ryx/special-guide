const axios    = require('axios');
const FormData = require('form-data');
const sharp    = require('sharp');

// ── Cache en mémoire TTL 1h ───────────────────────────────────────────────
const uploadCache = new Map();
const CACHE_TTL   = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadCache.entries()) {
    if (now - entry.ts > CACHE_TTL) uploadCache.delete(key);
  }
}, 10 * 60 * 1000);

// ── Télécharger l'image Etsy ──────────────────────────────────────────────
async function downloadEtsyImage(etsyUrl) {
  const smallUrl = etsyUrl.replace(/_(fullxfull|\d{3,4}x[^.]*)\\.(?=\w+$)/i, '_570x.');
  const urlsToTry = smallUrl !== etsyUrl ? [smallUrl, etsyUrl] : [etsyUrl];

  for (const url of urlsToTry) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.etsy.com/' },
      });
      const buf = Buffer.from(res.data);
      if (buf.length > 100 && (buf[0] === 0xFF || buf[0] === 0x89 || buf[0] === 0x52)) {
        console.log(`[freeUploader] ✅ Image téléchargée — ${buf.length} bytes`);
        return {
          buffer:   buf,
          mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
        };
      }
      console.warn(`[freeUploader] ⚠️ Image invalide — ${buf.length} bytes`);
    } catch (e) {
      console.warn(`[freeUploader] ❌ Téléchargement échoué (${url.slice(0, 60)}): ${e.message}`);
    }
  }
  return null;
}

// ── Compresser en JPEG ≤ 800px ────────────────────────────────────────────
async function compressImage(buffer) {
  try {
    return await sharp(buffer)
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
  } catch (e) {
    console.warn('[freeUploader] ⚠️ Compression échouée, buffer original:', e.message);
    return buffer;
  }
}

// ── Stratégie 2 : imgbb ───────────────────────────────────────────────────
async function uploadToImgbb(buffer) {
  const apiKey = process.env.IMGBB_API_KEY;
  if (!apiKey) {
    console.warn('[freeUploader] ⚠️ IMGBB_API_KEY absente — imgbb ignoré');
    return null;
  }
  console.log('[freeUploader] 🔄 Upload imgbb...');
  try {
    const compressed = await compressImage(buffer);
    const form = new FormData();
    form.append('key',   apiKey);
    form.append('image', compressed.toString('base64'));

    const res = await axios.post('https://api.imgbb.com/1/upload', form, {
      headers: form.getHeaders(),
      timeout: 15000,
    });
    const url = res.data?.data?.url;
    if (url) { console.log(`[freeUploader] ✅ imgbb OK → ${url}`); return url; }
    console.warn('[freeUploader] ⚠️ imgbb — réponse inattendue:', JSON.stringify(res.data));
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error(`[freeUploader] ❌ imgbb FAILED — HTTP ${status || 'réseau'}: ${detail}`);
  }
  return null;
}

// ── Stratégie 3 : data URI base64 (aucun réseau externe) ─────────────────
async function toDataUri(buffer) {
  try {
    const compressed = await compressImage(buffer);
    return `data:image/jpeg;base64,${compressed.toString('base64')}`;
  } catch (e) {
    console.warn('[freeUploader] ⚠️ DataURI échoué:', e.message);
    return null;
  }
}

/**
 * Retourne une URL publique utilisable par Serper Lens.
 *
 * Ordre :
 *   1. imgbb (upload rapide, stable, clé gratuite)
 *   2. data URI base64 (aucun réseau externe, fallback ultime)
 *
 * @param {string} etsyUrl
 * @returns {string|null}
 */
async function uploadImageFree(etsyUrl) {
  if (!etsyUrl) return null;

  const cached = uploadCache.get(etsyUrl);
  if (cached) {
    console.log(`[freeUploader] 💾 Cache hit (${cached.strategy})`);
    return cached.url;
  }

  const img = await downloadEtsyImage(etsyUrl);
  if (!img) {
    console.error('[freeUploader] ❌ Impossible de télécharger l\'image Etsy.');
    return null;
  }

  // 1. imgbb
  const imgbbUrl = await uploadToImgbb(img.buffer);
  if (imgbbUrl) {
    uploadCache.set(etsyUrl, { url: imgbbUrl, strategy: 'imgbb', ts: Date.now() });
    return imgbbUrl;
  }

  // 2. data URI base64
  console.log('[freeUploader] 🔄 Génération data URI base64...');
  const dataUri = await toDataUri(img.buffer);
  if (dataUri) {
    console.log(`[freeUploader] ✅ Data URI OK (${dataUri.length} chars)`);
    // Pas de cache pour les data URIs (volumineuses)
    return dataUri;
  }

  console.error('[freeUploader] ❌ Toutes les stratégies ont échoué.');
  return null;
}

module.exports = { uploadImageFree };
