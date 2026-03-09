const axios = require('axios');

const SERPER_API_KEY = process.env.SERPER_API_KEY;

async function reverseImageSearch(imageUrl, title = '') {
  try {
    // Lancer Lens ET recherche texte en parallèle
    const [lensResults, textResults] = await Promise.all([
      tryLens(imageUrl),
      title ? tryTextSearch(title) : Promise.resolve([])
    ]);

    // Fusionner et dédupliquer par lien
    const seen = new Set();
    const combined = [];
    for (const item of [...lensResults, ...textResults]) {
      const key = item.link;
      if (key && !seen.has(key)) {
        seen.add(key);
        combined.push(item);
      }
    }

    console.log(`🛒 Total AliExpress (Lens: ${lensResults.length} + Texte: ${textResults.length} = ${combined.length} uniques)`);
    return combined.slice(0, 5);

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

    const visual = response.data.visual_matches || [];
    const organic = response.data.organic || [];
    const all = [...visual, ...organic];

    const ali = all.filter(m => (m.link || m.url || '').toLowerCase().includes('aliexpress.com'));
    console.log(`🔍 Lens: ${visual.length} visual + ${organic.length} organic → ${ali.length} AliExpress`);

    return ali.slice(0, 5).map(m => ({
      title: m.title || 'AliExpress Product',
      link: m.link || m.url,
      image: m.imageUrl || m.thumbnailUrl || m.thumbnail || null,
      source: 'aliexpress'
    }));
  } catch (err) {
    console.error('Lens error:', err.response?.status, err.message);
    return [];
  }
}

async function tryTextSearch(title) {
  try {
    // Extraire mots-clés pertinents (sans mots parasites)
    const stopWords = new Set(['the','a','an','and','or','for','with','of','in','on','at','to','from','by','as','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','this','that','these','those','its','it','my','your','our','their','his','her','custom','personalized','handmade','unique','gift','gifts','new','best','top','shop']);
    
    const keywords = title
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
      .slice(0, 5)
      .join(' ');

    if (!keywords) return [];

    const query = `${keywords} site:aliexpress.com`;
    console.log(`🔤 Text search: "${query}"`);

    const response = await axios.post(
      'https://google.serper.dev/search',
      { q: query, gl: 'us', hl: 'en', num: 5 },
      {
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 20000
      }
    );

    const organic = response.data.organic || [];
    console.log(`🔤 Text search résultats: ${organic.length}`);

    return organic.slice(0, 5).map(m => ({
      title: m.title || 'AliExpress Product',
      link: m.link,
      image: m.imageUrl || m.thumbnail || null,
      source: 'aliexpress'
    }));
  } catch (err) {
    console.error('Text search error:', err.message);
    return [];
  }
}

module.exports = { reverseImageSearch };
