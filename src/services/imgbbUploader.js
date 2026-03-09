const axios    = require('axios');
const FormData = require('form-data');

// Upload une image sur ImgBB en base64 (évite la troncature des noms longs)
async function uploadToImgBB(input) {
  try {
    let b64;
    if (input.startsWith('data:')) {
      b64 = input.split(',')[1];
    } else if (input.startsWith('http')) {
      const dl = await axios.get(input, {
        responseType: 'arraybuffer', timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.etsy.com/' }
      });
      b64 = Buffer.from(dl.data).toString('base64');
    } else {
      b64 = input;
    }

    const form = new FormData();
    form.append('key', process.env.IMGBB_API_KEY);
    form.append('image', b64);

    const res = await axios.post('https://api.imgbb.com/1/upload', form, {
      headers: form.getHeaders?.() || { 'Content-Type': 'multipart/form-data' },
      timeout: 30000
    });

    if (res.data.success) return res.data.data.url;
    throw new Error(JSON.stringify(res.data));
  } catch (err) {
    console.error('ImgBB error:', err.message);
    return input; // fallback: URL originale
  }
}

module.exports = { uploadToImgBB };
