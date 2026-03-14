const axios = require('axios');

// Compare Etsy vs AliExpress images with Gemini Vision
// Focuses on the OBJECT, ignores background/angle/lighting
async function geminiVisionScore(etsyImageUrl, aliImageUrl) {
  try {
    // Fetch both images as base64
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
            { text: 'Look at the OBJECT in each image, ignoring background, angle, lighting, watermarks, and packaging. Is the main object/product in image 1 the same type of product as in image 2? Could image 2 be a wholesale or dropshipped version of image 1?\n\nRespond with ONLY a number from 0 to 100:\n- 85-100: Same product, clearly identical or near-identical object\n- 60-84: Same product type with minor design differences\n- 30-59: Same category but different product\n- 0-29: Different product entirely' }
          ]
        }]
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 25000 }
    );

    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '0';
    const match = text.match(/\d+/);
    const score = match ? Math.min(100, Math.max(0, parseInt(match[0]))) : 0;
    console.log(`🤖 Gemini vision: ${score}%`);
    return score;

  } catch (err) {
    console.error('Gemini vision error:', err.response?.status, err.message);
    return null; // null = fallback to Serper score
  }
}

// Serper Lens found a visual match — verify with Gemini Vision
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 40) {
  if (!aliItems.length) return [];

  const etsyImageUrl = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyImageUrl) return [];

  const results = [];

  for (const ali of aliItems) {
    if (!ali.link) continue;

    let similarity;

    // If we have both images, verify with Gemini Vision
    if (etsyImageUrl && ali.image && process.env.GEMINI_API_KEY) {
      const score = await geminiVisionScore(etsyImageUrl, ali.image);
      if (score !== null) {
        similarity = score;
      } else {
        // Gemini failed — fall back to Serper score
        similarity = ali.source === 'lens' ? 75 : 55;
      }
    } else {
      // No images or no key — use Serper as direct match
      similarity = ali.source === 'lens' ? 75 : 55;
    }

    console.log(`${similarity >= threshold ? '✅' : '❌'} Final similarity: ${similarity}% — ${ali.link?.substring(0, 60)}`);

    if (similarity >= threshold) {
      results.push({ etsy: etsyItem, aliexpress: ali, similarity });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 1);
}

module.exports = { compareEtsyWithAliexpress };
