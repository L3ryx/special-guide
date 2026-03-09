const axios = require('axios');

const SCRAPEAPI_KEY = process.env.SCRAPEAPI_KEY;

/**
 * Scrape Etsy search results using ScraperAPI
 * Returns top 10 listings with title, link, and image
 */
async function scrapeEtsy(keyword, maxCount = 10) {
  const etsySearchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}`;
  const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPEAPI_KEY}&url=${encodeURIComponent(etsySearchUrl)}&render=true`;

  try {
    console.log(`🔍 Scraping Etsy for: "${keyword}"`);
    const response = await axios.get(scraperUrl, { timeout: 60000 });
    const html = response.data;

    const listings = parseEtsyListings(html);
    console.log(`✅ Found ${listings.length} Etsy listings`);
    return listings.slice(0, maxCount);
  } catch (error) {
    console.error('Etsy scrape error:', error.message);
    throw new Error(`Failed to scrape Etsy: ${error.message}`);
  }
}

/**
 * Parse Etsy HTML to extract listings
 */
function parseEtsyListings(html) {
  const listings = [];

  // Match listing cards - Etsy uses data-listing-id attributes
  // Pattern 1: Extract listing URLs
  const listingUrlPattern = /href="(https:\/\/www\.etsy\.com\/listing\/\d+\/[^"?]+)[^"]*"/g;
  const imagePattern = /src="(https:\/\/i\.etsystatic\.com\/[^"]+\.(jpg|jpeg|png|webp))[^"]*"/g;
  const titlePattern = /data-listing-id[^>]*>[\s\S]*?<h3[^>]*>([^<]+)<\/h3>/g;

  const urls = new Set();
  const images = [];

  // Extract unique listing URLs
  let match;
  while ((match = listingUrlPattern.exec(html)) !== null) {
    const url = match[1];
    if (!urls.has(url) && !url.includes('/search') && !url.includes('ref=')) {
      urls.add(url);
    }
  }

  // Extract images
  while ((match = imagePattern.exec(html)) !== null) {
    const img = match[1];
    // Filter for listing images (il_* prefix = item listing image)
    if (img.includes('il_') || img.includes('listing')) {
      images.push(img);
    }
  }

  // Combine URLs and images
  const urlArray = Array.from(urls);
  
  for (let i = 0; i < Math.min(urlArray.length, 10); i++) {
    // Extract title from URL slug
    const urlParts = urlArray[i].split('/');
    const slug = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    listings.push({
      title: title,
      link: urlArray[i],
      image: images[i] || null,
      source: 'etsy'
    });
  }

  // Fallback: try JSON-LD structured data
  if (listings.length === 0) {
    const jsonLdPattern = /"url":"(https:\/\/www\.etsy\.com\/listing\/[^"]+)","image":"([^"]+)","name":"([^"]+)"/g;
    while ((match = jsonLdPattern.exec(html)) !== null && listings.length < 10) {
      listings.push({
        title: match[3],
        link: match[1],
        image: match[2],
        source: 'etsy'
      });
    }
  }

  return listings;
}

module.exports = { scrapeEtsy };
