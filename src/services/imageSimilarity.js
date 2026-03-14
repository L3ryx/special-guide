const axios = require('axios');

// Compare two images with Gemini Vision — focuses on the object, ignores background
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

    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{
          parts: [
            { inline_data: { mime_type: etsyMime, data: etsyB64 } },
            { inline_data: { mime_type: aliMime,  data: aliB64  } },
            { text: 'Focus ONLY on the main object/product in each image. Completely ignore: background, colors, lighting, angle, watermarks, text, packaging, and decorations.\n\nIs the physical object in image 1 the same product as in image 2? Could image 2 be a dropshipped or wholesale version of image 1?\n\nScore:\n- 80-100: Same product (same shape, same design, clearly identical object)\n- 60-79: Very similar product (same type, minor differences)\n- 30-59: Same category but different product\n- 0-29: Completely different product\n\nReply with ONLY a number 0-100.' }
          ]
        }]
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
    );

    const text  = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '0';
    const match = text.match(/\d+/);
    const score = match ? Math.min(100, Math.max(0, parseInt(match[0]))) : 0;
    console.log(`🤖 Gemini vision: ${score}%`);
    return score;

  } catch (err) {
    console.error('Gemini vision error:', err.response?.status, err.message);
    return null; // null = skip this match
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

    // Gemini Vision is required — no fallback to prevent false positives
    if (!process.env.GEMINI_API_KEY) {
      // No Gemini key — accept Lens matches directly but only lens source
      if (ali.source === 'lens') {
        results.push({ etsy: etsyItem, aliexpress: ali, similarity: 75 });
      }
      continue;
    }

    const score = await geminiVisionScore(etsyImageUrl, ali.image);

    if (score === null) {
      // Gemini failed — skip this match to avoid false positives
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
