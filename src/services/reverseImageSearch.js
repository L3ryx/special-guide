const axios = require('axios');
const { uploadToImgBB } = require('./imgbbUploader');

const SERPER_API_KEY = process.env.SERPER_API_KEY;

async function reverseImageSearch(etsyImageUrl, title = '') {
  try {
    // 1. Upload image Etsy sur ImgBB → URL publique pour Serper Lens
    console.log(`📤 Upload Etsy sur ImgBB...`);
    const publicUrl = await uploadToImgBB(etsyImageUrl);
    console.log(`🔗 ImgBB Etsy: ${publicUrl.substring(0, 70)}`);

    // 2. Serper Lens avec l'URL ImgBB
    const lensResults = await tryLens(publicUrl);

    // 3. Fallback texte si Lens ne trouve rien
    const textResults = lensResults.length === 0 && title
      ? await tryTextSearch(title)
      : [];

    const seen = new Set();
    const combined = [];
    for (const item of [...lensResults, ...textResults]) {
      if (item.link && !seen.has(item.link)) {
        seen.add(item.link);
        combined.push(item);
      }
    }

    // Garder uniquement le 1er résultat
    const best = combined.slice(0, 1);

    // 4. Pour chaque résultat : uploader l'image AliExpress sur ImgBB
    for (const item of best) {
      if (item.image) {
        try {
          console.log(`📤 Upload AliExpress sur ImgBB...`);
          const imgbbUrl = await uploadToImgBB(item.image);
          item.image = imgbbUrl;
          console.log(`🔗 ImgBB Ali: ${imgbbUrl.substring(0, 70)}`);
        } catch {
          // garder l'image originale si upload échoue
        }
      }
    }

    console.log(`🛒 Résultat: ${best[0]?.link || 'aucun'} (Lens: ${lensResults.length}, Texte: ${textResults.length})`);
    return best;

  } catch (error) {
    console.error('reverseImageSearch error:', error.message);
    return [];
  }
}

async function tryLens(imageUrl) {
  try {
    const response = await axios.post(
      'https://google.serper.dev/lens',
      { url: imageUrl, gl: 'us', hl: 'en' },
      {
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const visual  = response.data.visual_matches || [];
    const organic = response.data.organic || [];
    const all = [...visual, ...organic];
    const ali = all.filter(m => (m.link || m.url || '').toLowerCase().includes('aliexpress.com'));

    console.log(`🔍 Lens: ${visual.length} visual + ${organic.length} organic → ${ali.length} AliExpress`);

    return ali.slice(0, 3).map(m => ({
      title: m.title || 'AliExpress Product',
      link:  m.link || m.url,
      image: m.imageUrl || m.thumbnailUrl || m.thumbnail || null,
      source: 'lens'
    }));
  } catch (err) {
    console.error('Lens error:', err.response?.status, err.message);
    return [];
  }
}

async function tryTextSearch(title) {
  try {
    const stopWords = new Set(['the','a','an','and','or','for','with','of','in','on','at','to','from','by','as','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','this','that','these','those','its','it','my','your','our','their','his','her','custom','personalized','handmade','unique','gift','gifts','new','best','top','shop']);
    const keywords = title.replace(/[^a-zA-Z0-9\s]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase())).slice(0, 5).join(' ');

    if (!keywords) return [];

    console.log(`🔤 Text search: "${keywords} site:aliexpress.com"`);
    const response = await axios.post(
      'https://google.serper.dev/search',
      { q: `${keywords} site:aliexpress.com`, gl: 'us', hl: 'en', num: 3 },
      { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 20000 }
    );

    return (response.data.organic || []).slice(0, 3).map(m => ({
      title: m.title || 'AliExpress Product',
      link:  m.link,
      image: m.imageUrl || m.thumbnail || null,
      source: 'text'
    }));
  } catch (err) {
    console.error('Text search error:', err.message);
    return [];
  }
}

module.exports = { reverseImageSearch };
