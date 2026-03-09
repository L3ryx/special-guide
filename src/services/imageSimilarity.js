const axios = require('axios');

async function imageUrlToBase64(url, label = '') {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*'
      }
    });
    return Buffer.from(response.data).toString('base64');
  } catch (err) {
    console.error(`❌ Téléchargement ${label} échoué: HTTP ${err.response?.status}`);
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
            text: `Compare these two product images. Are they the same product or could one be a dropshipped version of the other?
- Same product type + similar appearance = 0.7 to 1.0
- Same category but different design = 0.4 to 0.6
- Completely different = 0.0 to 0.3
Ignore background, watermarks, photo angle, lighting.
Return ONLY a decimal number 0 to 1.`
          },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64A}`, detail: 'low' } },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64B}`, detail: 'low' } }
        ]
      }]
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 25000
    }
  );

  const text = response.data.choices[0].message.content.trim();
  console.log(`🤖 OpenAI: "${text}"`);
  const match = text.match(/0\.\d+|1(\.0+)?|\d+/);
  if (!match) return 0;
  let val = parseFloat(match[0]);
  if (val > 1) val = val / 100;
  return val;
}

async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 60) {
  const etsyImg = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyImg) return [];

  // Pré-télécharger l'image Etsy une seule fois
  const b64Etsy = await imageUrlToBase64(etsyImg, 'Etsy');
  if (!b64Etsy) return [];

  // Comparer tous les items AliExpress en parallèle
  const comparisons = await Promise.all(
    aliexpressItems.map(async aliItem => {
      try {
        if (!aliItem.image) {
          // Pas d'image AliExpress — score 50% car Serper Lens a matché
          return aliItem.link ? { etsy: etsyItem, aliexpress: aliItem, similarity: 50, reasoning: 'Match Serper (image non disponible)' } : null;
        }

        const b64Ali = await imageUrlToBase64(aliItem.image, 'AliExpress');
        if (!b64Ali) {
          return { etsy: etsyItem, aliexpress: aliItem, similarity: 50, reasoning: 'Match Serper (image bloquée)' };
        }

        const score = await calculateSimilarity(b64Etsy, b64Ali);
        const similarity = Math.round(score * 100);
        console.log(`📊 ${similarity}% — ${similarity >= threshold ? '✅' : '❌'}`);

        if (similarity >= threshold) {
          return { etsy: etsyItem, aliexpress: aliItem, similarity, reasoning: `Similarité: ${similarity}%` };
        }
        return null;
      } catch (err) {
        console.error('Erreur comparaison item:', err.message);
        return null;
      }
    })
  );

  // Garder uniquement le meilleur résultat AliExpress par image Etsy
  const valid = comparisons.filter(Boolean).sort((a, b) => b.similarity - a.similarity);
  return valid.length > 0 ? [valid[0]] : [];
}

module.exports = { compareEtsyWithAliexpress };
