const axios = require('axios');
const FormData = require('form-data');

/**
 * Upload une image sur ImgBB.
 * Accepte : URL http/https OU data URL base64.
 * ImgBB n'accepte pas le WebP en base64 — on envoie toujours l'URL directe si possible.
 */
async function uploadToImgBB(input) {
  try {
    // Si c'est une data URL base64, extraire le base64 pur
    // Si c'est une URL http, l'envoyer directement (ImgBB fetch lui-même)
    const isDataUrl = input.startsWith('data:');
    const isHttp    = input.startsWith('http');

    console.log(`📤 Uploading to ImgBB (${isDataUrl ? 'base64' : 'url'}): ${input.substring(0, 60)}...`);

    const formData = new FormData();
    formData.append('key', process.env.IMGBB_API_KEY);

    if (isHttp) {
      // Envoyer l'URL directement — ImgBB la télécharge lui-même
      formData.append('image', input);
    } else if (isDataUrl) {
      // Extraire le base64 pur (sans le préfixe data:...)
      const b64 = input.split(',')[1];
      if (!b64) throw new Error('data URL invalide');
      formData.append('image', b64);
    } else {
      formData.append('image', input);
    }

    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: formData.getHeaders ? formData.getHeaders() : { 'Content-Type': 'multipart/form-data' },
      timeout: 30000
    });

    if (response.data.success) {
      const url = response.data.data.url;
      console.log(`✅ ImgBB success: ${url}`);
      return url;
    }
    throw new Error('ImgBB échec: ' + JSON.stringify(response.data));

  } catch (error) {
    console.error('ImgBB upload error:', error.message);
    return input; // fallback: retourner l'input original
  }
}

module.exports = { uploadToImgBB };
