const axios = require('axios');

async function imageUrlToBase64(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return Buffer.from(response.data).toString('base64');
  } catch (err) {
    console.error(`❌ Impossible de télécharger image: ${url?.substring(0,60)} — ${err.message}`);
    return null;
  }
}

async function calculateSimilarity(base64A, base64B) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are comparing two product images to detect if they are the same product or a very similar product (e.g. a dropshipped version).

Focus on: same product type, same shape, same design, same style. Ignore differences in background, watermarks, photo angle, or image quality.

Be GENEROUS: if the products look like they could be the same item sold on different platforms, score high (0.7-1.0).

Return ONLY a decimal number from 0 to 1. Nothing else.`
          },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64A}` } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64B}` } }
        ]
      }]
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 30000
    }
  );

  const text = response.data.choices[0].message.content.trim();
  console.log(`🤖 OpenAI raw: "${text}"`);
  const match = text.match(/0\.\d+|1(\.0+)?|\d+/);
  if (!match) return 0;
  let val = parseFloat(match[0]);
  if (val > 1) val = val / 100;
  return val;
}

async function compareImageSimilarity(etsyImageUrl, aliImageUrl) {
  try {
    console.log(`\n--- Comparaison ---`);
    console.log(`Etsy: ${etsyImageUrl?.substring(0, 70)}`);
    console.log(`Ali:  ${aliImageUrl?.substring(0, 70)}`);

    if (!aliImageUrl) {
      console.log(`⚠️ Image AliExpress manquante — skip`);
      return { similarity: 0, reasoning: 'Image AliExpress non disponible' };
    }

    const [b64A, b64B] = await Promise.all([
      imageUrlToBase64(etsyImageUrl),
      imageUrlToBase64(aliImageUrl)
    ]);

    if (!b64A) return { similarity: 0, reasoning: 'Image Etsy non téléchargeable' };
    if (!b64B) return { similarity: 0, reasoning: 'Image AliExpress non téléchargeable' };

    console.log(`✅ Images téléchargées (${Math.round(b64A.length/1024)}kb / ${Math.round(b64B.length/1024)}kb)`);

    const score = await calculateSimilarity(b64A, b64B);
    const similarity = Math.round(score * 100);
    console.log(`📊 Score final: ${similarity}%`);

    return { similarity, reasoning: `Similarité visuelle: ${similarity}%` };

  } catch (error) {
    console.error('Erreur comparaison:', error.response?.data || error.message);
    return { similarity: 0, reasoning: 'Erreur: ' + error.message };
  }
}

async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 60) {
  const comparisons = [];
  const etsyImg = etsyItem.hostedImageUrl || etsyItem.image;

  console.log(`\n🔬 Comparaison ${aliexpressItems.length} item(s) AliExpress (seuil: ${threshold}%)`);

  for (const aliItem of aliexpressItems) {
    if (!etsyImg) { console.log('⚠️ Pas d\'image Etsy'); continue; }

    const result = await compareImageSimilarity(etsyImg, aliItem.image);
    console.log(`→ ${result.similarity}% — ${result.similarity >= threshold ? '✅ MATCH' : '❌ sous le seuil'}`);

    if (result.similarity >= threshold) {
      comparisons.push({ etsy: etsyItem, aliexpress: aliItem, similarity: result.similarity, reasoning: result.reasoning });
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return comparisons.sort((a, b) => b.similarity - a.similarity);
}

module.exports = { compareImageSimilarity, compareEtsyWithAliexpress };
