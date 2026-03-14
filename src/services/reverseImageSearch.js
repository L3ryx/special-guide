const axios = require('axios');
const { uploadToImgBB } = require('./imgbbUploader');

const STOP_WORDS = new Set(['the','a','an','and','or','for','with','of','in','on','at','to','from','by','as','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','this','that','these','those','its','it','my','your','our','their','his','her','custom','personalized','handmade','unique','gift','gifts','new','best','top','shop']);

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
      .slice(0, 2)
      .map(m => ({ link: cleanAliUrl(m.link || m.url), image: m.imageUrl || m.thumbnailUrl || null, source: 'lens' }))
      .filter(m => m.link);

    // Upload AliExpress thumbnail to ImgBB for reliable display
    for (const match of aliMatches) {
      if (match.image) {
        try {
          match.image = await uploadToImgBB(match.image);
        } catch {
          // Keep original URL as fallback
        }
      }
    }
    return aliMatches;
  } catch (err) {
    console.error('Lens error:', err.message);
    return [];
  }
}

async function textSearch(title) {
  try {
    const kw = title.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w.toLowerCase())).slice(0, 5).join(' ');
    if (!kw) return [];
    console.log(`🔤 Text: "${kw} site:aliexpress.com"`);
    const res = await axios.post('https://google.serper.dev/search',
      { q: `${kw} site:aliexpress.com`, gl: 'us', hl: 'en', num: 3 },
      { headers: { 'X-API-KEY': process.env.SERPER_API_KEY }, timeout: 18000 }
    );
    return (res.data.organic || [])
      .map(m => ({ link: cleanAliUrl(m.link || ''), image: m.imageUrl || null, source: 'text' }))
      .filter(m => m.link).slice(0, 2);
  } catch (err) {
    console.error('Text search error:', err.message);
    return [];
  }
}

async function reverseImageSearch(etsyImageUrl, title = '') {
  try {
    // Upload Etsy image sur ImgBB pour Serper Lens
    const publicUrl = await uploadToImgBB(etsyImageUrl);
    console.log(`🔗 ImgBB Etsy: ${publicUrl.substring(0, 60)}`);

    // Lens + texte en parallèle
    const [lens, text] = await Promise.all([lensSearch(publicUrl), title ? textSearch(title) : []]);

    // Fusionner, dédupliquer, Lens en priorité
    const seen = new Set();
    const results = [...lens, ...text].filter(m => {
      if (!m.link || seen.has(m.link)) return false;
      seen.add(m.link);
      return true;
    });

    const best = results.slice(0, 1);
    console.log(`🛒 Résultat: ${best[0]?.link || 'aucun'}`);
    return best;
  } catch (err) {
    console.error('reverseImageSearch error:', err.message);
    return [];
  }
}

module.exports = { reverseImageSearch };
