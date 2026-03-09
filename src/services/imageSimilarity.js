const axios = require('axios');

/**
 * Télécharge une image depuis une URL et la convertit en base64
 */
async function imageUrlToBase64(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return Buffer.from(response.data).toString('base64');
}

/**
 * Compare deux images via GPT-4o-mini en base64
 * Retourne un score de 0 à 1
 */
async function calculateSimilarity(base64A, base64B) {
  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o-mini',
      max_tokens: 10,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Return only similarity 0 to 1.' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64A}` } },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64B}` } }
          ]
        }
      ]
    },
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      timeout: 30000
    }
  );

  const text = response.data.choices[0].message.content;
  console.log(`🤖 OpenAI raw response: "${text}"`);
  const match = text.match(/0\.\d+|1(\.0+)?/);
  return match ? parseFloat(match[0]) : 0;
}

/**
 * Compare une image Etsy avec une image AliExpress
 * Retourne similarity (0-100) et reasoning
 */
async function compareImageSimilarity(etsyImageUrl, aliexpressImageUrl) {
  try {
    console.log(`🤖 Téléchargement des images pour comparaison...`);

    const [base64A, base64B] = await Promise.all([
      imageUrlToBase64(etsyImageUrl),
      imageUrlToBase64(aliexpressImageUrl)
    ]);

    const score = await calculateSimilarity(base64A, base64B);
    const similarity = Math.round(score * 100);

    console.log(`✅ Similarité : ${similarity}%`);
    return { similarity, reasoning: `Score OpenAI : ${score.toFixed(2)}` };

  } catch (error) {
    console.error('Erreur comparaison OpenAI:', error.response?.data || error.message);
    return { similarity: 0, reasoning: 'Comparaison échouée : ' + error.message };
  }
}

/**
 * Compare un article Etsy contre plusieurs résultats AliExpress
 * Retourne les paires avec similarité >= threshold
 */
async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 60) {
  const comparisons = [];

  for (const aliItem of aliexpressItems) {
    const etsyImg = etsyItem.hostedImageUrl || etsyItem.image;
    const aliImg = aliItem.image;

    if (!etsyImg || !aliImg) {
      console.log(`⚠️ Image manquante, comparaison ignorée`);
      continue;
    }

    try {
      const result = await compareImageSimilarity(etsyImg, aliImg);

      if (result.similarity >= threshold) {
        comparisons.push({
          etsy: etsyItem,
          aliexpress: aliItem,
          similarity: result.similarity,
          reasoning: result.reasoning
        });
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      console.error('Erreur comparaison:', error.message);
    }
  }

  return comparisons.sort((a, b) => b.similarity - a.similarity);
}

module.exports = { compareImageSimilarity, compareEtsyWithAliexpress };
