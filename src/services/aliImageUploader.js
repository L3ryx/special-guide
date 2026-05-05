const axios    = require('axios');
const FormData = require('form-data');

// ── Cache en mémoire TTL 1h ───────────────────────────────────────────────────
const uploadCache = new Map();
const CACHE_TTL   = 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of uploadCache.entries()) {
    if (now - entry.ts > CACHE_TTL) uploadCache.delete(key);
  }
}, 10 * 60 * 1000);

// ── Télécharger une image AliExpress ─────────────────────────────────────────
async function downloadAliImage(aliUrl) {
  console.log(`[aliUploader] 📥 Téléchargement image AliExpress: ${aliUrl.slice(0, 80)}...`);

  // AliExpress sert parfois des images en webp ou avec des params de resize
  // On essaie d'abord l'URL telle quelle, puis sans paramètres
  const cleanUrl = aliUrl.split('?')[0];
  const urlsToTry = cleanUrl !== aliUrl ? [aliUrl, cleanUrl] : [aliUrl];

  for (const url of urlsToTry) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer':    'https://www.aliexpress.com/',
          'Accept':     'image/webp,image/jpeg,image/*,*/*;q=0.8',
        },
      });

      const buf = Buffer.from(res.data);
      // Vérifier que c'est bien une image (magic bytes JPEG, PNG, WEBP)
      const isJpeg = buf[0] === 0xFF && buf[1] === 0xD8;
      const isPng  = buf[0] === 0x89 && buf[1] === 0x50;
      const isWebp = buf.slice(0, 4).toString() === 'RIFF';

      if (buf.length > 500 && (isJpeg || isPng || isWebp)) {
        const mimeType = isWebp
          ? 'image/webp'
          : isPng
            ? 'image/png'
            : 'image/jpeg';
        console.log(`[aliUploader] ✅ Image téléchargée — ${buf.length} bytes — ${mimeType}`);
        return { buffer: buf, mimeType };
      } else {
        console.warn(`[aliUploader] ⚠️ Image invalide — taille: ${buf.length}`);
      }
    } catch (e) {
      console.warn(`[aliUploader] ❌ Échec (${url.slice(0, 60)}): ${e.message}`);
    }
  }

  console.error(`[aliUploader] ❌ ÉCHEC TOTAL téléchargement: ${aliUrl.slice(0, 80)}`);
  return null;
}

// ── Upload vers Litterbox (catbox.moe) ───────────────────────────────────────
async function uploadToLitterbox(buffer, mimeType) {
  console.log('[aliUploader] 🔄 Upload litterbox.catbox.moe...');
  try {
    const ext  = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
    const form = new FormData();
    form.append('reqtype',     'fileupload');
    form.append('time',        '1h');
    form.append('fileToUpload', buffer, { filename: `ali_image.${ext}`, contentType: mimeType });

    const res = await axios.post(
      'https://litterbox.catbox.moe/resources/internals/api.php',
      form,
      { headers: form.getHeaders(), timeout: 20000, responseType: 'text' }
    );

    const url = (typeof res.data === 'string' ? res.data : '').trim();
    if (url.startsWith('https://')) {
      console.log(`[aliUploader] ✅ Litterbox OK → ${url}`);
      return url;
    }
    console.warn(`[aliUploader] ⚠️ Litterbox réponse inattendue: ${url}`);
  } catch (e) {
    console.error(`[aliUploader] ❌ Litterbox FAILED: ${e.message}`);
  }
  return null;
}

/**
 * Télécharge une image AliExpress et l'héberge temporairement pour Google Lens.
 * @param {string} aliUrl
 * @returns {string|null} URL publique hébergée
 */
async function uploadAliImageFree(aliUrl) {
  if (!aliUrl) return null;

  // Cache hit
  const cached = uploadCache.get(aliUrl);
  if (cached) {
    console.log(`[aliUploader] 💾 Cache hit → ${cached.value}`);
    return cached.value;
  }

  const img = await downloadAliImage(aliUrl);
  if (!img) return null;

  const url = await uploadToLitterbox(img.buffer, img.mimeType);
  if (url) {
    uploadCache.set(aliUrl, { value: url, ts: Date.now() });
    return url;
  }

  return null;
}

module.exports = { uploadAliImageFree };
