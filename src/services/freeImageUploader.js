const axios = require('axios');

// ── Cache en mémoire avec TTL 1h ──
const uploadCache = new Map();
const CACHE_TTL   = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadCache.entries()) {
    if (now - entry.ts > CACHE_TTL) uploadCache.delete(key);
  }
}, 10 * 60 * 1000);

/**
 * Stratégie : on utilise notre propre endpoint /proxy-image comme URL publique.
 * Serper accepte n'importe quelle URL accessible depuis Internet.
 * Render expose le serveur publiquement → pas besoin d'hébergeur tiers.
 *
 * Fallback : si APP_URL n'est pas défini, on tente imgbb (clé API gratuite)
 * puis catbox.moe (upload direct sans compte).
 */
async function uploadImageFree(etsyUrl) {
  if (!etsyUrl) return null;

  const cached = uploadCache.get(etsyUrl);
  if (cached) return cached.value;

  // ── Stratégie 1 : proxy local (APP_URL requis, ex: https://mon-app.onrender.com) ──
  const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  if (appUrl) {
    const proxyUrl = `${appUrl}/proxy-image?url=${encodeURIComponent(etsyUrl)}`;
    // Vérifier que notre propre proxy est accessible (test rapide)
    try {
      await axios.head(proxyUrl, { timeout: 5000 });
      console.log('[freeUploader] proxy local OK:', proxyUrl.slice(0, 80));
      uploadCache.set(etsyUrl, { value: proxyUrl, ts: Date.now() });
      return proxyUrl;
    } catch(e) {
      console.warn('[freeUploader] proxy local inaccessible:', e.message);
    }
  }

  // ── Stratégie 2 : télécharger l'image pour les services tiers ──
  const img = await downloadEtsyImage(etsyUrl);
  if (!img) {
    console.warn('[freeUploader] impossible de télécharger:', etsyUrl);
    return null;
  }

  // ── Stratégie 2 : Imgur (avec IMGUR_CLIENT_ID) ──
  const imgurUrl = await uploadToImgur(img.buffer, img.mimeType);
  if (imgurUrl) {
    uploadCache.set(etsyUrl, { value: imgurUrl, ts: Date.now() });
    return imgurUrl;
  }

  console.error('[freeUploader] tous les services ont échoué pour', etsyUrl);
  return null;
}

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
      if (buf.length > 100 && (buf[0] === 0xFF || buf[0] === 0x89 || buf[0] === 0x52)) {
        return {
          buffer:   buf,
          mimeType: (res.headers['content-type'] || 'image/jpeg').split(';')[0].trim(),
        };
      }
    } catch { /* essai suivant */ }
  }
  return null;
}

// ── Imgur ──
async function uploadToImgur(buffer, mimeType) {
  const rawId = process.env.IMGUR_CLIENT_ID || '546c25a59c58ad7';
  const authHdr = rawId.startsWith('Client-ID') ? rawId : `Client-ID ${rawId}`;
  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('image', buffer, { filename: 'image.jpg', contentType: mimeType });
    form.append('type', 'file');

    const res = await axios.post('https://api.imgur.com/3/image', form, {
      headers: { ...form.getHeaders(), Authorization: authHdr },
      timeout: 20000,
      maxContentLength: Infinity,
    });
    const url = res.data?.data?.link;
    if (url) { console.log('[freeUploader] imgur OK'); return url; }
  } catch(e) {
    console.warn('[freeUploader] imgur failed:', e.message);
  }
  return null;
}

module.exports = { uploadImageFree };
