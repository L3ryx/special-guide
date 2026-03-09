const express = require('express');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Set your API keys via environment variables or replace directly here
const SCRAPER_API_KEY  = process.env.SCRAPER_API_KEY  || 'YOUR_SCRAPERAPI_KEY';
const IMGBB_API_KEY    = process.env.IMGBB_API_KEY    || 'YOUR_IMGBB_KEY';
const SERPER_API_KEY   = process.env.SERPER_API_KEY   || 'YOUR_SERPER_KEY';
const OPENAI_API_KEY   = process.env.OPENAI_API_KEY   || 'YOUR_OPENAI_KEY';
// ──────────────────────────────────────────────────────────────────────────────

// ─── STEP 1+2 : Scrape Etsy via ScraperAPI ────────────────────────────────────
async function scrapeEtsy(keyword, scraperKey) {
  const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
  const scraperUrl = `http://api.scraperapi.com/?api_key=${scraperKey}&url=${encodeURIComponent(searchUrl)}&render=true`;

  const { data: html } = await axios.get(scraperUrl, { timeout: 60000 });

  // Extract listings from HTML
  const listings = [];

  // Match product cards: title, link, image
  const cardRegex = /href="(https:\/\/www\.etsy\.com\/(?:listing|[a-z]{2}\/listing)\/[^"]+)"/g;
  const imgRegex = /<img[^>]+src="(https:\/\/i\.etsystatic\.com\/[^"]+)"[^>]*>/g;

  const links = [];
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const link = match[1].split('?')[0];
    if (!links.includes(link)) links.push(link);
    if (links.length >= 10) break;
  }

  const images = [];
  while ((match = imgRegex.exec(html)) !== null) {
    const src = match[1];
    if (!src.includes('75x75') && !src.includes('32x32') && !images.includes(src)) {
      images.push(src);
    }
    if (images.length >= 10) break;
  }

  for (let i = 0; i < Math.min(links.length, images.length, 10); i++) {
    listings.push({ link: links[i], image: images[i] });
  }

  return listings;
}

// ─── STEP 3 : Upload image to IMGBB ───────────────────────────────────────────
async function uploadToImgBB(imageUrl, imgbbKey) {
  const form = new FormData();
  form.append('key', imgbbKey);
  form.append('image', imageUrl);

  const { data } = await axios.post('https://api.imgbb.com/1/upload', form, {
    headers: form.getHeaders(),
    timeout: 30000,
  });

  return data.data.url;
}

// ─── STEP 4 : Google Reverse Image Search via Serper (filtered AliExpress) ────
async function reverseImageSearch(imageUrl, serperKey) {
  const { data } = await axios.post(
    'https://google.serper.dev/lens',
    { url: imageUrl },
    {
      headers: {
        'X-API-KEY': serperKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  // Filter results to keep only AliExpress
  const all = data.organic || [];
  const aliResults = all
    .filter(r => r.link && r.link.includes('aliexpress.com'))
    .slice(0, 5)
    .map(r => ({
      link: r.link,
      image: r.imageUrl || r.thumbnailUrl || null,
      title: r.title || '',
    }));

  return aliResults;
}

// ─── STEP 5 : Compare images via OpenAI Vision ────────────────────────────────
async function compareImages(etsyImageUrl, aliImageUrl, openaiKey) {
  const prompt = `You are a product similarity expert. Compare these two product images.
Return ONLY a JSON object with:
- "similarity": a number between 0 and 100 representing visual similarity percentage
- "reason": a one-sentence explanation

Be strict: only give high scores (>60) if the products are clearly the same or very similar design.
Response format: {"similarity": 75, "reason": "Same design with similar colors and pattern"}`;

  const { data } = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: 'gpt-4o',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: etsyImageUrl, detail: 'low' } },
            { type: 'image_url', image_url: { url: aliImageUrl, detail: 'low' } },
          ],
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  const text = data.choices[0].message.content.trim();
  const jsonMatch = text.match(/\{[^}]+\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  return { similarity: 0, reason: 'Could not parse response' };
}

// ─── MAIN ENDPOINT ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: 'Keyword required' });

  // Allow API keys from request headers (sent by frontend)
  const scraperKey = req.headers['x-scraper-key'] || SCRAPER_API_KEY;
  const imgbbKey   = req.headers['x-imgbb-key']   || IMGBB_API_KEY;
  const serperKey  = req.headers['x-serper-key']  || SERPER_API_KEY;
  const openaiKey  = req.headers['x-openai-key']  || OPENAI_API_KEY;

  const results = [];

  try {
    // 1. Scrape Etsy
    res.write ? null : null;
    console.log(`[1/4] Scraping Etsy for: ${keyword}`);
    const etsyListings = await scrapeEtsy(keyword);

    if (etsyListings.length === 0) {
      return res.status(404).json({ error: 'No Etsy listings found' });
    }

    console.log(`[2/4] Found ${etsyListings.length} Etsy listings`);

    // Process each listing
    for (let i = 0; i < etsyListings.length; i++) {
      const listing = etsyListings[i];
      console.log(`[3/4] Processing listing ${i + 1}/${etsyListings.length}: ${listing.link}`);

      try {
        // Upload to ImgBB
        const hostedImage = await uploadToImgBB(listing.image, imgbbKey);

        // Reverse image search (AliExpress filter)
        const aliResults = await reverseImageSearch(hostedImage, serperKey);

        if (aliResults.length === 0) continue;

        // Compare each AliExpress result
        for (const ali of aliResults) {
          if (!ali.image) continue;

          try {
            const comparison = await compareImages(listing.image, ali.image, openaiKey);

            if (comparison.similarity >= 60) {
              results.push({
                etsy: { image: listing.image, link: listing.link },
                ali: { image: ali.image, link: ali.link, title: ali.title },
                similarity: comparison.similarity,
                reason: comparison.reason,
              });
            }
          } catch (e) {
            console.error('Comparison error:', e.message);
          }
        }
      } catch (e) {
        console.error(`Error processing listing ${i + 1}:`, e.message);
      }
    }

    // Sort by similarity descending
    results.sort((a, b) => b.similarity - a.similarity);
    res.json({ results, total: results.length });

  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
