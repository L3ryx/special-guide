const axios = require('axios');
const { uploadToImgBB } = require('./imgbbUploader');

// Fetch AliExpress product image from page if Serper didn't return one
async function fetchAliPageImage(link) {
  try {
    const res = await axios.get(link, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' }
    });
    const html = typeof res.data === 'string' ? res.data : '';
    const m = html.match(/"imageUrl"\s*:\s*"(https:[^"]+)"/i)
           || html.match(/property="og:image"\s+content="([^"]+)"/i)
           || html.match(/name="twitter:image"\s+content="([^"]+)"/i);
    return m ? m[1].replace(/\\u0026/g, '&') : null;
  } catch {
    return null;
  }
}

// Serper Lens already found this AliExpress product visually — direct match
// Upload AliExpress image to ImgBB so it displays reliably in the frontend
async function compareEtsyWithAliexpress(etsyItem, aliItems, threshold = 40) {
  if (!aliItems.length) return [];

  const results = [];
  for (const ali of aliItems) {
    if (!ali.link) continue;

    // Get AliExpress image URL
    let aliImageUrl = ali.image || null;
    if (!aliImageUrl) {
      aliImageUrl = await fetchAliPageImage(ali.link).catch(() => null);
    }

    // Upload to ImgBB for reliable display (avoids CORS/expiry issues)
    if (aliImageUrl) {
      try {
        const hosted = await uploadToImgBB(aliImageUrl);
        ali.image = hosted;
      } catch {
        ali.image = aliImageUrl; // fallback to direct URL
      }
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
