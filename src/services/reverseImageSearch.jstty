const axios = require('axios');

const SERPER_API_KEY = process.env.SERPER_API_KEY;

/**
 * Télécharge une image depuis Etsy et la convertit en base64
 */
async function imageUrlToBase64(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.etsy.com/'
    }
  });
  const contentType = response.headers['content-type'] || 'image/jpeg';
  const base64 = Buffer.from(response.data).toString('base64');
  return { base64, contentType };
}

/**
 * Recherche inversée — log complet de la réponse Serper pour debug
 */
async function reverseImageSearch(imageUrl) {
  try {
    console.log(`\n===== REVERSE SEARCH =====`);
    console.log(`URL: ${imageUrl.substring(0, 80)}`);

    const { base64, contentType } = await imageUrlToBase64(imageUrl);
    console.log(`Image téléchargée: ${contentType}, ${Math.round(base64.length/1024)}kb base64`);

    // Test 1: URL directe Etsy
    console.log(`\n--- Test 1: URL directe Etsy ---`);
    const r1 = await callLens(imageUrl);
    console.log(`Résultat URL directe:`, JSON.stringify(r1).substring(0, 500));

    // Filtrer AliExpress
    const visual = r1.visual_matches || [];
    const organic = r1.organic || [];
    console.log(`visual_matches keys:`, visual[0] ? Object.keys(visual[0]) : 'aucun');
    console.log(`organic keys:`, organic[0] ? Object.keys(organic[0]) : 'aucun');
    console.log(`Tous les liens visual:`, visual.slice(0,5).map(m => m.link || m.url || 'no-link'));
    console.log(`Tous les liens organic:`, organic.slice(0,5).map(m => m.link || m.url || 'no-link'));

    const all = [...visual, ...organic];
    const ali = all.filter(m => (m.link || m.url || '').toLowerCase().includes('aliexpress.com'));
    console.log(`AliExpress trouvés: ${ali.length}`);

    if (ali.length > 0) return ali.slice(0, 5).map(formatItem);

    // Si 0 résultat, retourner les 3 premiers peu importe la source pour debug
    console.log(`⚠️ 0 AliExpress. Premiers résultats:`, all.slice(0,3).map(m => m.link || m.url));
    return [];

  } catch (error) {
    console.error('Erreur reverseImageSearch:', error.response?.status, JSON.stringify(error.response?.data || error.message).substring(0, 400));
    return [];
  }
}

async function callLens(imageUrl) {
  try {
    const response = await axios.post(
      'https://google.serper.dev/lens',
      { url: imageUrl, gl: 'us', hl: 'en' },
      {
        headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );
    return response.data;
  } catch (err) {
    console.error('callLens error:', err.response?.status, JSON.stringify(err.response?.data || err.message).substring(0, 300));
    return {};
  }
}

function formatItem(m) {
  return {
    title: m.title || m.name || 'AliExpress Product',
    link: m.link || m.url,
    image: m.imageUrl || m.thumbnailUrl || m.thumbnail || m.image || null,
    source: 'aliexpress'
  };
}

module.exports = { reverseImageSearch };
