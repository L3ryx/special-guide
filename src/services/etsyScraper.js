/**
 * etsyScraper.js
 * Recherche de listings Etsy via l'API officielle (remplace le scraping HTML).
 */

const { searchListings, handleEtsyError } = require('./etsyApi');

/**
 * Recherche des listings Etsy pour un mot-clé donné.
 * Remplace l'ancien scraping ScraperAPI page par page.
 *
 * @param {string} keyword
 * @param {number} maxCount — nombre max de listings à retourner
 * @returns {Promise<Array>} — tableau de { title, link, image, source, shopName, shopUrl, price }
 */
async function scrapeEtsy(keyword, maxCount = 10) {
  if (!process.env.ETSY_CLIENT_ID) throw new Error('ETSY_CLIENT_ID missing');

  console.log(`scrapeEtsy (API): "${keyword}" (max ${maxCount})`);

  const allListings = [];
  const seen        = new Set();
  const perPage     = 100; // max autorisé par l'API Etsy
  let   offset      = 0;

  while (allListings.length < maxCount) {
    const needed = maxCount - allListings.length;
    const limit  = Math.min(needed, perPage);

    let results;
    try {
      results = await searchListings(keyword, limit, offset);
    } catch (e) {
      handleEtsyError(e);
    }

    if (!results || results.length === 0) {
      console.log(`No more results at offset ${offset}, stopping`);
      break;
    }

    for (const listing of results) {
      if (!listing.link || seen.has(listing.link)) continue;
      seen.add(listing.link);
      allListings.push(listing);
      if (allListings.length >= maxCount) break;
    }

    console.log(`After offset ${offset}: ${allListings.length}/${maxCount}`);

    if (results.length < limit) break; // dernière page
    offset += limit;
  }

  if (allListings.length === 0) {
    throw new Error('No Etsy listings found for this keyword');
  }

  console.log(`Total: ${allListings.length} listings`);
  return allListings.slice(0, maxCount);
}

module.exports = { scrapeEtsy };

