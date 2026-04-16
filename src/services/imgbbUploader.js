// Proxy Render : rend les images Etsy publiquement accessibles sans ImgBB
function uploadToImgBB(input) {
  if (input && input.startsWith('http')) {
    const base = process.env.RENDER_EXTERNAL_URL || 'https://www.finder-niche.com';
    return Promise.resolve(`${base}/proxy-image?url=${encodeURIComponent(input)}`);
  }
  // Fallback : base64 ou data URI retournés tels quels
  return Promise.resolve(input);
}

module.exports = { uploadToImgBB };
