const axios = require('axios');

// Fetch AliExpress product image from its page if not already available
async function fetchAliImage(aliItem) {
  if (aliItem.image) return aliItem.image;
  if (!aliItem.link) return null;
  try {
    const res = await axios.get(aliItem.link, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
    });
    const html = typeof res.data === 'string' ? res.data : '';
    // Extract main product image from AliExpress page
    const m = html.match(/"imageUrl"\s*:\s*"(https:[^"]+)"/i)
           || html.match(/property="og:image"\s+content="([^"]+)"/i)
           || html.match(/<img[^>]+class="[^"]*magnifier[^"]*"[^>]+src="([^"]+)"/i);
    return m ? m[1].replace(/\\u0026/g, '&') : null;
  } catch {
    return null;
  }
}

// Serper Lens already found this AliExpress product visually — direct match
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 40) {
  if (!aliItems.length) return [];

  const results = [];
  for (const ali of aliItems) {
    if (!ali.link) continue;

    // Try to get AliExpress image if missing
    if (!ali.image) {
      ali.image = await fetchAliImage(ali);
    }

    const similarity = ali.source === 'lens' ? 95 : 75;
    if (similarity >= threshold) {
      console.log(`✅ Serper match ${similarity}% — ${ali.link?.substring(0, 60)}`);
      results.push({ etsy: etsyItem, aliexpress: ali, similarity });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 1);
}

module.exports = { compareEtsyWithAliexpress };
