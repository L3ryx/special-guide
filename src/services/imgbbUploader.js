const axios = require('axios');
const FormData = require('form-data');

const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

/**
 * Upload an image URL to ImgBB and get a hosted URL
 * Required for Google Reverse Image Search (needs public URL)
 */
async function uploadToImgBB(imageUrl) {
  try {
    console.log(`📤 Uploading to ImgBB: ${imageUrl.substring(0, 60)}...`);

    const formData = new FormData();
    formData.append('key', IMGBB_API_KEY);
    formData.append('image', imageUrl); // ImgBB accepts URL directly

    const response = await axios.post('https://api.imgbb.com/1/upload', formData, {
      headers: formData.getHeaders ? formData.getHeaders() : { 'Content-Type': 'multipart/form-data' },
      timeout: 30000
    });

    if (response.data.success) {
      const hostedUrl = response.data.data.url;
      console.log(`✅ ImgBB upload success: ${hostedUrl}`);
      return hostedUrl;
    } else {
      throw new Error('ImgBB upload failed: ' + JSON.stringify(response.data));
    }
  } catch (error) {
    console.error('ImgBB upload error:', error.message);
    // Return original URL as fallback
    return imageUrl;
  }
}

/**
 * Upload multiple images to ImgBB
 */
async function uploadMultipleToImgBB(imageUrls) {
  const results = [];
  for (const url of imageUrls) {
    if (url) {
      const hosted = await uploadToImgBB(url);
      results.push(hosted);
    } else {
      results.push(null);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

module.exports = { uploadToImgBB, uploadMultipleToImgBB };
