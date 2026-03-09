const axios = require('axios');

/**
 * Comparaison via Claude claude-haiku-4-5-20251001 Vision — rapide et précis.
 * Les images sont passées en base64 directement.
 */
async function calculateSimilarityWithClaude(b64Etsy, b64Ali, retries = 2) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 16,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: b64Etsy }
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: b64Ali }
              },
              {
                type: 'text',
                text: `Compare these two product images. Could one be a dropshipped or wholesale version of the other?
Score rules:
- Same product, same design → 0.85–1.0
- Same product type, similar design → 0.65–0.84
- Same category, different design → 0.35–0.64
- Different product → 0.0–0.34
Ignore: background, watermarks, angle, lighting.
Reply with ONLY a single decimal number (e.g. 0.82). Nothing else.`
              }
            ]
          }]
        },
        {
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
          },
          timeout: 20000
        }
      );

      const text = response.data.content[0]?.text?.trim() || '0';
      console.log(`🤖 Claude score: "${text}"`);
      const match = text.match(/0\.\d+|1(\.0+)?/);
      return match ? parseFloat(match[0]) : 0;

    } catch (err) {
      const status = err.response?.status;
      if ((status === 529 || status === 429) && attempt < retries) {
        const wait = attempt * 2000;
        console.log(`⏳ Claude ${status} — retry dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`❌ Claude Vision: ${status || err.message}`);
        throw err;
      }
    }
  }
  return 0;
}

async function downloadBase64(url, label = '') {
  try {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'image/jpeg,image/webp,image/*'
      }
    });
    // Convertir en JPEG-like base64 (Claude accepte jpeg, png, gif, webp)
    return Buffer.from(res.data).toString('base64');
  } catch (err) {
    console.error(`❌ Download ${label}: ${err.message}`);
    return null;
  }
}

async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 40) {
  const etsyImg = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyImg) return [];

  // Télécharger image Etsy
  const b64Etsy = await downloadBase64(etsyImg, 'Etsy');
  if (!b64Etsy) return [];

  const candidates = [];

  for (const aliItem of aliexpressItems) {
    if (!aliItem.image) continue;

    try {
      // L'image AliExpress est déjà une URL ImgBB — télécharger en base64
      const b64Ali = await downloadBase64(aliItem.image, 'AliExpress');
      if (!b64Ali) continue;

      const score = await calculateSimilarityWithClaude(b64Etsy, b64Ali);
      const similarity = Math.round(score * 100);
      console.log(`📊 Similarité Claude: ${similarity}% — ${aliItem.link?.substring(0, 50)}`);

      candidates.push({ etsy: etsyItem, aliexpress: aliItem, similarity });

    } catch (err) {
      console.error(`Erreur comparaison: ${err.message}`);
      // Fallback : score basé sur la source Serper
      const fallback = aliItem.source === 'lens' ? 70 : 55;
      candidates.push({ etsy: etsyItem, aliexpress: aliItem, similarity: fallback });
    }
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.similarity - a.similarity);
  const best = candidates[0];

  if (best.similarity >= threshold) {
    console.log(`✅ Match: ${best.similarity}%`);
    return [best];
  }

  console.log(`❌ Score ${best.similarity}% sous seuil ${threshold}%`);
  return [];
}

module.exports = { compareEtsyWithAliexpress };
