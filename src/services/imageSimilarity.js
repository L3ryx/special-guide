const axios = require('axios');
const { scrapeAliexpressImage } = require('./aliexpressImageScraper');
const { uploadToImgBB } = require('./imgbbUploader');

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
    console.error(`❌ Téléchargement ${label} échoué: ${err.response?.status || err.message}`);
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
            text: `Compare these two product images. Could one be a dropshipped / wholesale version of the other?
- Same product, same design = 0.85 to 1.0
- Same product type, similar design = 0.65 to 0.84
- Same category, different design = 0.35 to 0.64
- Different product = 0.0 to 0.34
Ignore background, watermarks, photo angle, lighting differences.
Return ONLY a decimal number between 0 and 1, nothing else.`
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
  console.log(`🤖 OpenAI score: "${text}"`);
  const match = text.match(/0\.\d+|1(\.0+)?/);
  if (!match) return 0;
  return parseFloat(match[0]);
}

async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 40) {
  const etsyImg = etsyItem.hostedImageUrl || etsyItem.image;
  if (!etsyImg) return [];

  // Télécharger l'image Etsy en base64 pour OpenAI
  const b64Etsy = await imageUrlToBase64(etsyImg, 'Etsy');
  if (!b64Etsy) return [];

  const candidates = [];

  for (const aliItem of aliexpressItems) {
    if (!aliItem.link) continue;

    try {
      // 1. Scraper la vraie image AliExpress depuis la page produit
      console.log(`🔎 Scrape image AliExpress: ${aliItem.link.substring(0, 60)}`);
      const dataUrl = await scrapeAliexpressImage(aliItem.link);

      if (!dataUrl) {
        console.log(`⚠️ Image AliExpress non trouvée, skip`);
        continue;
      }

      // 2. Upload l'image AliExpress sur ImgBB → URL publique stable pour l'affichage
      console.log(`📤 Upload image AliExpress sur ImgBB...`);
      const imgbbUrl = await uploadToImgBB(dataUrl);
      console.log(`🔗 ImgBB AliExpress: ${imgbbUrl.substring(0, 60)}`);

      // 3. Comparer avec OpenAI (en base64)
      const b64Ali = dataUrl.split(',')[1];
      if (!b64Ali) continue;

      const score = await calculateSimilarity(b64Etsy, b64Ali);
      const similarity = Math.round(score * 100);
      console.log(`📊 Similarité: ${similarity}% — ${aliItem.link.substring(0, 50)}`);

      // Stocker l'URL ImgBB pour l'affichage (pas de CORS, stable)
      candidates.push({
        etsy: etsyItem,
        aliexpress: { ...aliItem, image: imgbbUrl },
        similarity
      });

    } catch (err) {
      console.error(`Erreur candidat AliExpress: ${err.message}`);
    }
  }

  if (candidates.length === 0) return [];

  candidates.sort((a, b) => b.similarity - a.similarity);
  const best = candidates[0];

  if (best.similarity >= threshold) {
    console.log(`✅ Meilleur match: ${best.similarity}%`);
    return [best];
  }

  console.log(`❌ Score ${best.similarity}% sous le seuil ${threshold}%`);
  return [];
}

module.exports = { compareEtsyWithAliexpress };
