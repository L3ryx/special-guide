const axios = require('axios');
const { uploadToImgBB } = require('./imgbbUploader');

const SERPER_API_KEY = process.env.SERPER_API_KEY;

async function reverseImageSearch(etsyImageUrl, title = '') {
  try {
    // Upload Etsy sur ImgBB en parallÃ¨le avec la prÃ©paration texte
    console.log(`ðŸ“¤ Upload Etsy ImgBB...`);
    const publicUrl = await uploadToImgBB(etsyImageUrl);
    console.log(`ðŸ”— ImgBB Etsy: ${publicUrl.substring(0, 60)}`);

    // Lens + texte en parallÃ¨le
    const [lensResults, textResults] = await Promise.all([
      tryLens(publicUrl),
      title ? tryTextSearch(title) : Promise.resolve([])
    ]);

    // Fusionner â€” Lens en prioritÃ©
    const seen = new Set();
    const combined = [];
    for (const item of [...lensResults, ...textResults]) {
      if (item.link && !seen.has(item.link) && isValidAliLink(item.link)) {
        seen.add(item.link);
        combined.push(item);
      }
    }

    const best = combined.slice(0, 1);
    console.log(`ðŸ›’ RÃ©sultat: ${best[0]?.link?.substring(0, 60) || 'aucun'}`);

    // Pas d'upload ImgBB pour AliExpress â€” imageSimilarity tÃ©lÃ©charge directement en base64
    return best;

  } catch (error) {
    console.error('reverseImageSearch error:', error.message);
    return [];
  }
}

function cleanAliLink(raw) {
  if (!raw) return null;
  try {
    // DÃ©coder les entitÃ©s HTML et caractÃ¨res encodÃ©s
    let url = raw.replace(/&amp;/g, '&').trim();

    // Extraire l'item ID et reconstruire une URL propre
    const itemMatch = url.match(/\/item\/(\d{10,})/);
    if (itemMatch) {
      return `https://www.aliexpress.com/item/${itemMatch[1]}.html`;
    }

    // Parfois l'ID est dans les paramÃ¨tres
    const idParam = url.match(/[?&](?:id|itemId|productId)=(\d{10,})/);
    if (idParam) {
      return `https://www.aliexpress.com/item/${idParam[1]}.html`;
    }

    // Lien de recherche wholesale â†’ invalide
    if (url.includes('/w/wholesale') || url.includes('wholesale-')) return null;

    return null; // URL sans item ID = inutilisable
  } catch { return null; }
}

function isValidAliLink(link) {
  return link && link.includes('aliexpress.com') && link.includes('/item/');
}

async function tryLens(imageUrl) {
  try {
    const response = await axios.post(
      'https://google.serper.dev/lens',
      { url: imageUrl, gl: 'us', hl: 'en' },
      {
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 25000
      }
    );

    const visual  = response.data.visual_matches || [];
    const organic = response.data.organic || [];
    const ali = [...visual, ...organic]
      .filter(m => (m.link || m.url || '').includes('aliexpress.com'));

    console.log(`ðŸ” Lens: ${visual.length} visual + ${organic.length} organic â†’ ${ali.length} AliExpress`);

    return ali.slice(0, 3).map(m => ({
      title: m.title || 'AliExpress',
      link:  cleanAliLink(m.link || m.url),
      image: m.imageUrl || m.thumbnailUrl || m.thumbnail || null,
      source: 'lens'
    })).filter(m => m.link);
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

    console.log(`ðŸ”¤ Text: "${keywords} site:aliexpress.com"`);
    const response = await axios.post(
      'https://google.serper.dev/search',
      { q: `${keywords} site:aliexpress.com`, gl: 'us', hl: 'en', num: 3 },
      { headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' }, timeout: 18000 }
    );

    return (response.data.organic || [])
      .map(m => ({
        title: m.title || 'AliExpress',
        link:  cleanAliLink(m.link || ''),
        image: m.imageUrl || m.thumbnail || null,
        source: 'text'
      }))
      .filter(m => m.link)
      .slice(0, 3);
  } catch (err) {
    console.error('Text search error:', err.message);
    return [];
  }
}

module.exports = { reverseImageSearch };
