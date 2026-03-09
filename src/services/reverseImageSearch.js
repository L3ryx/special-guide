const axios = require('axios');

const SERPER_API_KEY = process.env.SERPER_API_KEY;

/**
 * Télécharge une image et la convertit en base64
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
 * Recherche inversée par image via Serper Google Lens
 * Envoie l'image en base64 directement — contourne le blocage ImgBB/Etsy
 */
async function reverseImageSearch(imageUrl) {
  try {
    console.log(`🔎 Téléchargement image pour Lens: ${imageUrl.substring(0, 70)}...`);

    // Télécharger l'image et convertir en base64
    const { base64, contentType } = await imageUrlToBase64(imageUrl);
    const dataUrl = `data:${contentType};base64,${base64}`;

    console.log(`📤 Envoi à Serper Lens (base64, ${Math.round(base64.length / 1024)}kb)...`);

    const response = await axios.post(
      'https://google.serper.dev/lens',
      { url: dataUrl },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 40000
      }
    );

    const data = response.data;
    const visual = data.visual_matches || [];
    const organic = data.organic || [];
    const all = [...visual, ...organic];

    console.log(`📊 Lens: ${visual.length} visual_matches, ${organic.length} organic`);

    // Filtrer AliExpress
    const ali = all.filter(m =>
      (m.link || m.url || '').toLowerCase().includes('aliexpress.com')
    );

    console.log(`🛒 AliExpress trouvés: ${ali.length}`);

    return ali.slice(0, 5).map(m => ({
      title: m.title || m.name || 'AliExpress Product',
      link: m.link || m.url,
      image: m.imageUrl || m.thumbnailUrl || m.thumbnail || m.image || null,
      source: 'aliexpress'
    }));

  } catch (error) {
    const errData = error.response?.data;
    console.error('Lens error:', error.response?.status, JSON.stringify(errData || error.message).substring(0, 300));
    return [];
  }
}

module.exports = { reverseImageSearch };
