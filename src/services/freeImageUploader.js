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
        console.log(`[freeUploader] ✅ Image Etsy téléchargée — ${buf.length} bytes`);
        return {
          buffer:   buf,
          mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
        };
      } else {
        console.warn(`[freeUploader] ⚠️ Image invalide — taille: ${buf.length}`);
      }
    } catch (e) {
      console.warn(`[freeUploader] ❌ Échec téléchargement (${url.slice(0, 60)}): ${e.message}`);
    }
  }
  console.error(`[freeUploader] ❌ ÉCHEC TOTAL téléchargement: ${etsyUrl.slice(0, 80)}`);
  return null;
}

// ── Litterbox (catbox.moe) — sans clé API, expiration 1h ──
async function uploadToLitterbox(buffer, mimeType) {
  console.log('[freeUploader] 🔄 Upload litterbox.catbox.moe...');
  try {
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '1h');
    form.append('fileToUpload', buffer, { filename: 'image.jpg', contentType: mimeType });

    const res = await axios.post(
      'https://litterbox.catbox.moe/resources/internals/api.php',
      form,
      { headers: form.getHeaders(), timeout: 20000, responseType: 'text' }
    );

    const url = (typeof res.data === 'string' ? res.data : '').trim();
    if (url.startsWith('https://')) {
      console.log(`[freeUploader] ✅ Litterbox OK → ${url}`);
      return url;
    }
    console.warn(`[freeUploader] ⚠️ Litterbox — réponse inattendue: ${url}`);
  } catch (e) {
    const status = e.response?.status;
    const detail = e.response?.data ? String(e.response.data) : e.message;
    const code   = e.code || '';
    console.error(`[freeUploader] ❌ Litterbox FAILED — HTTP ${status || 'réseau'} code=${code}: ${detail}`);
  }
  return null;
}

/**
 * Télécharge une image Etsy et l'héberge sur litterbox.catbox.moe.
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
    console.error('[freeUploader] ❌ BLOQUÉ — impossible de télécharger l\'image Etsy.');
    return null;
  }

  console.log(`[freeUploader] 📤 Upload en cours (${img.buffer.length} bytes)...`);

  const url = await uploadToLitterbox(img.buffer, img.mimeType);
  if (url) {
    uploadCache.set(etsyUrl, { value: url, ts: Date.now() });
    return url;
  }

  console.error('[freeUploader] ❌ ÉCHEC upload Litterbox. Ximilar ne sera PAS appelé.');
  return null;
}

module.exports = { uploadImageFree };
