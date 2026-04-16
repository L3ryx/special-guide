/**
 * etsyScraper.js
 * Recherche de listings Etsy via le microservice Scrapling (Python).
 * Conserve la même interface publique qu'avant.
 */

const { searchListings, handleEtsyError } = require('./etsyApi');

async function scrapeEtsy(keyword, maxCount = 10) {
  console.log(`scrapeEtsy (scrapling): "${keyword}" (max ${maxCount})`);

  const allListings = [];
  const seen        = new Set();
  const perPage     = 48; // Etsy affiche ~48 résultats par page
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

    if (results.length < limit) break;
    offset += limit;
  }

  if (allListings.length === 0) {
    throw new Error('No Etsy listings found for this keyword');
  }

  console.log(`Total: ${allListings.length} listings`);
  return allListings.slice(0, maxCount);
}

module.exports = { scrapeEtsy };
