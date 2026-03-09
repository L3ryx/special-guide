const axios = require('axios');

// Télécharge une image en base64 + détecte le media type
async function fetchBase64(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.aliexpress.com/', 'Accept': 'image/*' }
  });
  const ct = res.headers['content-type'] || '';
  const mediaType = ct.includes('webp') ? 'image/webp'
                  : ct.includes('png')  ? 'image/png'
                  : ct.includes('gif')  ? 'image/gif'
                  : 'image/jpeg';
  return { data: Buffer.from(res.data).toString('base64'), mediaType };
}

// Compare deux images via Claude Vision — retourne un score 0.0–1.0
async function claudeVisionScore(etsyB64, etsyMime, aliB64, aliMime) {
  const res = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: etsyMime, data: etsyB64 } },
        { type: 'image', source: { type: 'base64', media_type: aliMime,  data: aliB64  } },
        { type: 'text',  text: 'Compare these two product images. Could one be a dropshipped or wholesale version of the other?\nScore: same product+design→0.85-1.0 | same type+similar→0.65-0.84 | same category→0.35-0.64 | different→0.0-0.34\nIgnore background, watermarks, angle, lighting.\nReply with ONLY a decimal number (e.g. 0.82).' }
      ]
    }]
  }, {
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    timeout: 20000
  });

  const text  = res.data.content[0]?.text?.trim() || '0';
  const match = text.match(/(?:0\.\d+|1(?:\.0+)?)/);
  return match ? parseFloat(match[0]) : 0;
}

// Compare une annonce Etsy avec ses résultats AliExpress
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 40) {
  const etsyUrl = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyUrl || !aliItems.length) return [];

  let etsyImg;
  try { etsyImg = await fetchBase64(etsyUrl); }
  catch { return []; }

  const results = [];

  for (const ali of aliItems) {
    if (!ali.image) continue;
    try {
      const aliImg = await fetchBase64(ali.image);
      console.log(`🖼 ${etsyImg.mediaType}(${Math.round(etsyImg.data.length/1024)}kb) vs ${aliImg.mediaType}(${Math.round(aliImg.data.length/1024)}kb)`);

      let score;
      try {
        score = await claudeVisionScore(etsyImg.data, etsyImg.mediaType, aliImg.data, aliImg.mediaType);
        console.log(`🤖 Claude: ${Math.round(score*100)}%`);
      } catch (err) {
        // Fallback si Claude Vision échoue (crédits vides, etc.)
        console.error(`❌ Claude Vision: ${err.response?.status} — ${JSON.stringify(err.response?.data?.error || err.message)}`);
        score = ali.source === 'lens' ? 0.75 : 0.55;
        console.log(`⚠️ Fallback score: ${Math.round(score*100)}%`);
      }

      const similarity = Math.round(score * 100);
      if (similarity >= threshold) {
        console.log(`✅ Match ${similarity}% — ${ali.link?.substring(0,50)}`);
        results.push({ etsy: etsyItem, aliexpress: ali, similarity });
      } else {
        console.log(`❌ ${similarity}% < seuil ${threshold}%`);
      }
    } catch (err) {
      console.error('compareEtsyWithAliexpress error:', err.message);
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 1);
}

module.exports = { compareEtsyWithAliexpress };
