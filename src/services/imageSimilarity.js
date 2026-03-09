const axios = require('axios');

/**
 * Comparaison via Claude claude-haiku-4-5-20251001 Vision â€” rapide et prÃ©cis.
 * Les images sont passÃ©es en base64 directement.
 */
async function calculateSimilarityWithClaude(b64Etsy, mediaEtsy, b64Ali, mediaAli, retries = 2) {
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
                source: { type: 'base64', media_type: mediaEtsy || 'image/jpeg', data: b64Etsy }
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaAli || 'image/jpeg', data: b64Ali }
              },
              {
                type: 'text',
                text: `Compare these two product images. Could one be a dropshipped or wholesale version of the other?
Score rules:
- Same product, same design â†’ 0.85â€“1.0
- Same product type, similar design â†’ 0.65â€“0.84
- Same category, different design â†’ 0.35â€“0.64
- Different product â†’ 0.0â€“0.34
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
      console.log(`ðŸ¤– Claude score: "${text}"`);
      const match = text.match(/0\.\d+|1(\.0+)?/);
      return match ? parseFloat(match[0]) : 0;

    } catch (err) {
      const status = err.response?.status;
      if ((status === 529 || status === 429) && attempt < retries) {
        const wait = attempt * 2000;
        console.log(`â³ Claude ${status} â€” retry dans ${wait}ms`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        console.error(`âŒ Claude Vision: ${status || err.message}`);
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
        'Accept': 'image/jpeg,image/webp,image/png,image/*'
      }
    });
    const ct = res.headers['content-type'] || '';
    let mediaType = 'image/jpeg';
    if (ct.includes('webp')) mediaType = 'image/webp';
    else if (ct.includes('png')) mediaType = 'image/png';
    else if (ct.includes('gif')) mediaType = 'image/gif';
    return { data: Buffer.from(res.data).toString('base64'), mediaType };
  } catch (err) {
    console.error(`âŒ Download ${label}: ${err.message}`);
    return null;
  }
}

async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 40) {
  const etsyImg = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyImg) return [];

  // TÃ©lÃ©charger image Etsy
  const etsyDl = await downloadBase64(etsyImg, 'Etsy');
  if (!etsyDl) return [];

  const candidates = [];

  for (const aliItem of aliexpressItems) {
    if (!aliItem.image) continue;

    try {
      // L'image AliExpress est dÃ©jÃ  une URL ImgBB â€” tÃ©lÃ©charger en base64
      const aliDl = await downloadBase64(aliItem.image, 'AliExpress');
      if (!aliDl) continue;

      const score = await calculateSimilarityWithClaude(etsyDl.data, etsyDl.mediaType, aliDl.data, aliDl.mediaType);
      const similarity = Math.round(score * 100);
      console.log(`ðŸ“Š SimilaritÃ© Claude: ${similarity}% â€” ${aliItem.link?.substring(0, 50)}`);

      candidates.push({ etsy: etsyItem, aliexpress: aliItem, similarity });

    } catch (err) {
      console.error(`Erreur comparaison: ${err.message}`);
      // Fallback : score basÃ© sur la source Serper
      const fallback = aliItem.source === 'lens' ? 70 : 55;
      candidates.push({ etsy: etsyItem, aliexpress: aliItem, similarity: fallback });
    }
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.similarity - a.similarity);
  const best = candidates[0];

  if (best.similarity >= threshold) {
    console.log(`âœ… Match: ${best.similarity}%`);
    return [best];
  }

  console.log(`âŒ Score ${best.similarity}% sous seuil ${threshold}%`);
  return [];
}

module.exports = { compareEtsyWithAliexpress };
