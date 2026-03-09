/**
 * Plus d'OpenAI — le score est déterminé par la source Serper :
 * - Match Lens (visuel)  → 80%
 * - Match texte          → 60%
 */
async function compareEtsyWithAliexpress(etsyItem, aliexpressItems, threshold = 40) {
  const results = [];

  for (const aliItem of aliexpressItems) {
    if (!aliItem.link) continue;

    const similarity = aliItem.source === 'lens' ? 80 : 60;
    console.log(`📊 ${similarity}% (source: ${aliItem.source}) — ${aliItem.link.substring(0, 60)}`);

    if (similarity >= threshold) {
      results.push({ etsy: etsyItem, aliexpress: aliItem, similarity });
    }
  }

  // Retourner le meilleur résultat uniquement
  results.sort((a, b) => b.similarity - a.similarity);
  return results.length > 0 ? [results[0]] : [];
}

module.exports = { compareEtsyWithAliexpress };
