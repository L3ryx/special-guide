const axios = require('axios');

const SERPER_API_KEY = process.env.SERPER_API_KEY;

/**
 * Perform Google Reverse Image Search using Serper API
 * Filters results for AliExpress only
 */
async function reverseImageSearch(imageUrl) {
  try {
    console.log(`🔎 Reverse image search for: ${imageUrl.substring(0, 60)}...`);

    const response = await axios.post(
      'https://google.serper.dev/lens',
      { url: imageUrl },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const data = response.data;
    console.log(`✅ Reverse image search complete, got ${data.visual_matches?.length || 0} visual matches`);

    // Extract all visual matches
    const allMatches = data.visual_matches || [];

    // Filter for AliExpress results
    const aliexpressResults = allMatches.filter(match => {
      const link = (match.link || match.url || '').toLowerCase();
      return link.includes('aliexpress.com');
    });

    console.log(`🛒 Found ${aliexpressResults.length} AliExpress matches`);

    // Map to standard format
    const formatted = aliexpressResults.slice(0, 5).map(match => ({
      title: match.title || 'AliExpress Product',
      link: match.link || match.url,
      image: match.imageUrl || match.thumbnail || match.image || null,
      price: match.price || null,
      source: 'aliexpress'
    }));

    return formatted;
  } catch (error) {
    console.error('Reverse image search error:', error.response?.data || error.message);
    throw new Error(`Reverse image search failed: ${error.message}`);
  }
}

/**
 * Perform reverse image search for multiple images
 * Returns combined AliExpress results with source Etsy item reference
 */
async function batchReverseImageSearch(etsyListings) {
  const results = [];

  for (const listing of etsyListings) {
    if (!listing.hostedImageUrl && !listing.image) {
      console.log(`⚠️ Skipping listing without image: ${listing.title}`);
      continue;
    }

    const imageUrl = listing.hostedImageUrl || listing.image;

    try {
      const aliexpressMatches = await reverseImageSearch(imageUrl);

      results.push({
        etsyItem: listing,
        aliexpressMatches: aliexpressMatches
      });

      // Delay between requests
      await new Promise(r => setTimeout(r, 500));
    } catch (error) {
      console.error(`Failed reverse search for ${listing.title}:`, error.message);
      results.push({
        etsyItem: listing,
        aliexpressMatches: []
      });
    }
  }

  return results;
}

module.exports = { reverseImageSearch, batchReverseImageSearch };
