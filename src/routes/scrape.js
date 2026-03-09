const express = require('express');
const router = express.Router();

const { scrapeEtsy } = require('../services/etsyScraper');
const { uploadMultipleToImgBB } = require('../services/imgbbUploader');
const { reverseImageSearch } = require('../services/reverseImageSearch');
const { compareEtsyWithAliexpress } = require('../services/imageSimilarity');

/**
 * POST /api/search
 * Main endpoint: full pipeline search
 * Body: { keyword: string, similarityThreshold: number (optional, default 60) }
 */
router.post('/search', async (req, res) => {
  const { keyword, similarityThreshold = 60 } = req.body;

  if (!keyword || keyword.trim() === '') {
    return res.status(400).json({ error: 'Keyword is required' });
  }

  // Check API keys
  const missingKeys = [];
  if (!process.env.SCRAPEAPI_KEY || process.env.SCRAPEAPI_KEY.includes('your_')) missingKeys.push('SCRAPEAPI_KEY');
  if (!process.env.IMGBB_API_KEY || process.env.IMGBB_API_KEY.includes('your_')) missingKeys.push('IMGBB_API_KEY');
  if (!process.env.SERPER_API_KEY || process.env.SERPER_API_KEY.includes('your_')) missingKeys.push('SERPER_API_KEY');
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.includes('your_')) missingKeys.push('OPENAI_API_KEY');

  if (missingKeys.length > 0) {
    return res.status(500).json({
      error: `Missing API keys in .env file: ${missingKeys.join(', ')}`,
      instructions: 'Copy .env.example to .env and fill in your API keys'
    });
  }

  // Use SSE for real-time progress updates
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendProgress = (step, message, data = null) => {
    const payload = JSON.stringify({ step, message, data });
    res.write(`data: ${payload}\n\n`);
  };

  const sendError = (message) => {
    res.write(`data: ${JSON.stringify({ step: 'error', message })}\n\n`);
    res.end();
  };

  const sendComplete = (results) => {
    res.write(`data: ${JSON.stringify({ step: 'complete', results })}\n\n`);
    res.end();
  };

  try {
    // STEP 1: Scrape Etsy
    sendProgress('scraping_etsy', `🔍 Scraping Etsy for "${keyword}"...`);
    const etsyListings = await scrapeEtsy(keyword);

    if (etsyListings.length === 0) {
      return sendError('No Etsy listings found for this keyword');
    }

    sendProgress('etsy_done', `✅ Found ${etsyListings.length} Etsy listings`, { count: etsyListings.length });

    // STEP 2: Upload images to ImgBB
    sendProgress('uploading_images', `📤 Uploading ${etsyListings.length} images to ImgBB...`);
    const imageUrls = etsyListings.map(l => l.image).filter(Boolean);
    const hostedUrls = await uploadMultipleToImgBB(imageUrls);

    // Map hosted URLs back to listings
    let imgIdx = 0;
    for (const listing of etsyListings) {
      if (listing.image) {
        listing.hostedImageUrl = hostedUrls[imgIdx] || listing.image;
        imgIdx++;
      }
    }

    sendProgress('images_uploaded', `✅ Images uploaded to ImgBB`);

    // STEP 3 & 4: Reverse image search + AliExpress filter + Similarity comparison
    const allResults = [];

    for (let i = 0; i < etsyListings.length; i++) {
      const listing = etsyListings[i];

      if (!listing.hostedImageUrl && !listing.image) {
        console.log(`⚠️ Skipping listing ${i + 1} - no image`);
        continue;
      }

      sendProgress('reverse_search', `🔎 Reverse image search for listing ${i + 1}/${etsyListings.length}: ${listing.title}`);

      // Reverse image search with AliExpress filter
      let aliexpressMatches = [];
      try {
        aliexpressMatches = await reverseImageSearch(listing.hostedImageUrl || listing.image);
        sendProgress('aliexpress_found', `🛒 Found ${aliexpressMatches.length} AliExpress matches for listing ${i + 1}`);
      } catch (err) {
        console.error(`Reverse search failed for listing ${i + 1}:`, err.message);
        sendProgress('aliexpress_found', `⚠️ No AliExpress matches for listing ${i + 1}`);
      }

      if (aliexpressMatches.length === 0) continue;

      // STEP 5: Compare similarity
      sendProgress('comparing', `🤖 Comparing similarity for listing ${i + 1}...`);

      try {
        const comparisons = await compareEtsyWithAliexpress(
          listing,
          aliexpressMatches,
          similarityThreshold
        );

        if (comparisons.length > 0) {
          allResults.push(...comparisons);
          sendProgress('match_found', `✅ Found ${comparisons.length} matches with ≥${similarityThreshold}% similarity`, { count: comparisons.length });
        }
      } catch (err) {
        console.error(`Comparison failed for listing ${i + 1}:`, err.message);
      }

      // Small delay between listings
      await new Promise(r => setTimeout(r, 300));
    }

    sendProgress('finalizing', `📊 Analysis complete! Found ${allResults.length} total matches`);
    sendComplete(allResults);

  } catch (error) {
    console.error('Pipeline error:', error);
    sendError(error.message || 'An unexpected error occurred');
  }
});

/**
 * GET /api/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  const keys = {
    SCRAPEAPI_KEY: !!process.env.SCRAPEAPI_KEY && !process.env.SCRAPEAPI_KEY.includes('your_'),
    IMGBB_API_KEY: !!process.env.IMGBB_API_KEY && !process.env.IMGBB_API_KEY.includes('your_'),
    SERPER_API_KEY: !!process.env.SERPER_API_KEY && !process.env.SERPER_API_KEY.includes('your_'),
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your_')
  };
  
  const allConfigured = Object.values(keys).every(Boolean);
  
  res.json({
    status: allConfigured ? 'ready' : 'missing_keys',
    keys,
    message: allConfigured 
      ? '✅ All API keys configured. Ready to search!'
      : '⚠️ Some API keys are missing. Check your .env file.'
  });
});

module.exports = router;
