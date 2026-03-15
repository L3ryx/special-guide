const axios = require('axios');

// Retry Gemini avec backoff exponentiel sur 429
async function geminiWithRetry(payload, maxRetries = 4) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        payload,
        { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
      );
      return res;
    } catch (err) {
      if (err.response?.status === 429) {
        const wait = 5000 * Math.pow(2, attempt);
        console.warn(`Gemini 429 — attente ${wait/1000}s (attempt ${attempt+1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw err;
      }
    }
  }
  throw new Error('Gemini 429 — max retries atteint');
}

// Compare two images with Gemini Vision
async function geminiVisionScore(etsyImageUrl, aliImageUrl) {
  try {
    const [etsyBuf, aliBuf] = await Promise.all([
      axios.get(etsyImageUrl, { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } }),
      axios.get(aliImageUrl,  { responseType: 'arraybuffer', timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.aliexpress.com/' } }),
    ]);

    const etsyB64  = Buffer.from(etsyBuf.data).toString('base64');
    const aliB64   = Buffer.from(aliBuf.data).toString('base64');
    const etsyMime = (etsyBuf.headers['content-type'] || 'image/jpeg').split(';')[0];
    const aliMime  = (aliBuf.headers['content-type']  || 'image/jpeg').split(';')[0];

    const res = await geminiWithRetry({
      contents: [{
        parts: [
          { inline_data: { mime_type: etsyMime, data: etsyB64 } },
          { inline_data: { mime_type: aliMime,  data: aliB64  } },
          { text: 'Focus ONLY on the main object/product in each image. Completely ignore: background, colors, lighting, angle, watermarks, text, packaging, and decorations.\n\nIs the physical object in image 1 the same product as in image 2? Could image 2 be a dropshipped or wholesale version of image 1?\n\nScore:\n- 80-100: Same product (same shape, same design, clearly identical object)\n- 60-79: Very similar product (same type, minor differences)\n- 30-59: Same category but different product\n- 0-29: Completely different product\n\nReply with ONLY a number 0-100.' }
        ]
      }]
    });

    const text  = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '0';
    const match = text.match(/\d+/);
    const score = match ? Math.min(100, Math.max(0, parseInt(match[0]))) : 0;
    console.log(`🤖 Gemini vision: ${score}%`);
    return score;

  } catch (err) {
    console.error('Gemini vision error:', err.response?.status, err.message);
    return null;
  }
}

// Verify each Serper Lens match with Gemini Vision
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 60) {
  if (!aliItems.length) return [];

  const etsyImageUrl = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyImageUrl) return [];

  const results = [];

  for (const ali of aliItems) {
    if (!ali.link || !ali.image) continue;

    if (!process.env.GEMINI_API_KEY) {
      if (ali.source === 'lens') {
        results.push({ etsy: etsyItem, aliexpress: ali, similarity: 75 });
      }
      continue;
    }

    // Délai entre appels Gemini pour éviter les 429
    await new Promise(r => setTimeout(r, 800));

    const score = await geminiVisionScore(etsyImageUrl, ali.image);

    if (score === null) {
      console.log(`⚠️ Gemini failed — skipping match`);
      continue;
    }

    console.log(`${score >= threshold ? '✅' : '❌'} Similarity: ${score}% — ${ali.link?.substring(0, 60)}`);

    if (score >= threshold) {
      results.push({ etsy: etsyItem, aliexpress: ali, similarity: score });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 1);
}

module.exports = { compareEtsyWithAliexpress };

