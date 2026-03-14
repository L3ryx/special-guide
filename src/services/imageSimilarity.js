const axios = require('axios');

// Si Serper Lens trouve un lien AliExpress → c'est un match direct, score 1.0
// Plus de comparaison vision — Serper fait déjà le travail
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 40) {
  if (!aliItems.length) return [];

  const results = [];
  for (const ali of aliItems) {
    if (!ali.link) continue;
    // Serper Lens a déjà trouvé ce produit AliExpress visuellement — c'est un match
    const similarity = ali.source === 'lens' ? 95 : 75;
    if (similarity >= threshold) {
      console.log(`✅ Serper match ${similarity}% — ${ali.link?.substring(0,60)}`);
      results.push({ etsy: etsyItem, aliexpress: ali, similarity });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 1);
}

module.exports = { compareEtsyWithAliexpress };
