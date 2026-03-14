const axios = require('axios');
const { uploadToImgBB } = require('./imgbbUploader');

function cleanAliUrl(raw) {
  if (!raw) return null;
  const m = raw.match(/\/item\/(\d{10,})/);
  return m ? `https://www.aliexpress.com/item/${m[1]}.html` : null;
}

function isAliUrl(url) {
  return url?.includes('aliexpress.com') && url?.includes('/item/');
}

async function lensSearch(imgUrl) {
  try {
    const res = await axios.post('https://google.serper.dev/lens',
      { url: imgUrl, gl: 'us', hl: 'en' },
      { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 25000 }
    );
    const all = [...(res.data.visual_matches || []), ...(res.data.organic || [])];
    console.log(`🔍 Lens: ${(res.data.visual_matches||[]).length} visual + ${(res.data.organic||[]).length} organic`);

    const aliMatches = all
      .filter(m => isAliUrl(m.link || m.url))
      .slice(0, 3)
      .map(m => ({ link: cleanAliUrl(m.link || m.url), image: m.imageUrl || m.thumbnailUrl || null, source: 'lens' }))
      .filter(m => m.link);

    // Upload AliExpress thumbnails to ImgBB for reliable display
    for (const match of aliMatches) {
      if (match.image) {
        try { match.image = await uploadToImgBB(match.image); } catch {}
      }
    }
    return aliMatches;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error('Lens error:', err.response?.status, detail);
    return [];
  }
}

async function reverseImageSearch(etsyImageUrl, title = '') {
  try {
    // Upload Etsy image to ImgBB for Serper Lens
    const publicUrl = await uploadToImgBB(etsyImageUrl);
    console.log(`🔗 ImgBB Etsy: ${publicUrl.substring(0, 60)}`);

    // Lens only — text search removed (too many false positives)
    const results = await lensSearch(publicUrl);

    console.log(`🛒 Result: ${results[0]?.link || 'none'} (${results.length} matches)`);
    return results; // Return up to 3 for Gemini to filter
  } catch (err) {
    console.error('reverseImageSearch error:', err.message);
    return [];
  }
}

module.exports = { reverseImageSearch };
