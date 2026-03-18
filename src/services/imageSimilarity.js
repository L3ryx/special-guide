const axios = require('axios');

// Lens match direct = dropshipping confirmé (Gemini désactivé)
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 60) {
  if (!aliItems.length) return [];
  const results = aliItems
    .filter(ali => ali.link)
    .map(ali => ({ etsy: etsyItem, aliexpress: ali, similarity: 75 }));
  console.log(`✅ Lens matches: ${results.length}`);
  return results.slice(0, 1);
}

module.exports = { compareEtsyWithAliexpress };
