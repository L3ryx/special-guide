"""
scrapling_service/app.py
Microservice Python qui remplace l'API officielle Etsy.
Expose des endpoints HTTP appelés par le serveur Node.js via axios.

Endpoints :
  POST /search          — recherche de listings par mot-clé
  POST /shop-info       — nom + images d'une boutique à partir d'un shopId ou shopName
  POST /shop-listings   — listings actifs d'une boutique
  POST /listing-detail  — détail d'un listing (images, prix, etc.)
  GET  /health          — vérification que le service est vivant
"""

import re
import json
import time
import random
import logging
from urllib.parse import urlencode, quote_plus

from flask import Flask, request, jsonify
from scrapling.fetchers import FetcherSession

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="[scrapling] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

# ── Helpers ───────────────────────────────────────────────────────────────────

def make_session():
    """Crée une FetcherSession avec les en-têtes d'un vrai navigateur."""
    return FetcherSession(impersonate="chrome")


def clean_image(url: str | None) -> str | None:
    """Retire les query-params des URLs d'images Etsy."""
    if not url:
        return None
    return url.split("?")[0]


def random_delay(min_s=0.4, max_s=1.2):
    time.sleep(random.uniform(min_s, max_s))


# ── Scraping helpers ──────────────────────────────────────────────────────────

def _search_page(session: FetcherSession, keyword: str, offset: int = 0, limit: int = 100):
    """
    Scrape une page de résultats de recherche Etsy.
    Retourne une liste de dicts {listingId, shopId, title, link, image}.
    """
    params = urlencode({
        "q": keyword,
        "explicit": "1",
        "ref": "search_bar",
        "page": str(offset // 48 + 1),  # Etsy pagine par ~48 résultats
    })
    url = f"https://www.etsy.com/search?{params}"
    log.info(f"GET {url}")

    page = session.get(url, stealthy_headers=True, timeout=30)

    if page.status != 200:
        raise RuntimeError(f"Etsy returned HTTP {page.status} for search")

    listings = []

    # Etsy injecte les données dans un JSON dans la balise <script id="initial-state">
    # On tente d'abord ça, puis fallback CSS.
    script = page.css('script[data-component-name="SearchPageBrowseResults"]', first=True)
    if not script:
        script = page.css('[data-search-results-count]', first=True)

    # ── Méthode principale : JSON embarqué ──
    json_tags = page.find_all("script", {"type": "application/json"})
    for tag in (json_tags or []):
        text = tag.text or ""
        if '"listing_id"' in text or '"listingId"' in text:
            try:
                data = json.loads(text)
                items = _extract_listings_from_json(data)
                if items:
                    listings.extend(items)
                    break
            except (json.JSONDecodeError, Exception):
                pass

    # ── Fallback : parsing CSS des cards ──
    if not listings:
        cards = page.css('[data-listing-id]') or []
        for card in cards:
            listing_id = card.attrib.get("data-listing-id")
            if not listing_id:
                continue
            a_tag = card.css("a", first=True)
            link = a_tag.attrib.get("href", "") if a_tag else ""
            if not link.startswith("http"):
                link = "https://www.etsy.com" + link

            title_el = card.css("h3", first=True) or card.css("[data-listing-title]", first=True)
            title = title_el.text.strip() if title_el else None

            img_el = card.css("img", first=True)
            image = None
            if img_el:
                image = clean_image(
                    img_el.attrib.get("src") or img_el.attrib.get("data-src")
                )

            # shop_id via data-shop-id ou depuis le lien
            shop_id = card.attrib.get("data-shop-id")

            listings.append({
                "listingId": listing_id,
                "shopId": shop_id,
                "title": title,
                "link": link,
                "image": image,
            })

    log.info(f"  → {len(listings)} listings (offset={offset})")
    return listings[:limit]


def _extract_listings_from_json(data, depth=0):
    """Parcours récursif d'un dict/liste JSON pour trouver les listings Etsy."""
    results = []
    if depth > 8:
        return results

    if isinstance(data, dict):
        lid = data.get("listing_id") or data.get("listingId")
        if lid:
            link = f"https://www.etsy.com/listing/{lid}"
            images = data.get("images") or []
            image = None
            if images:
                img = images[0]
                image = clean_image(
                    img.get("url_fullxfull") or img.get("url_570xN") or img.get("url_170x135")
                )
            results.append({
                "listingId": str(lid),
                "shopId": str(data.get("shop_id") or data.get("shopId") or ""),
                "title": data.get("title"),
                "link": link,
                "image": image,
            })
        else:
            for v in data.values():
                results.extend(_extract_listings_from_json(v, depth + 1))

    elif isinstance(data, list):
        for item in data:
            results.extend(_extract_listings_from_json(item, depth + 1))

    return results


def _get_shop_info(session: FetcherSession, shop_name: str):
    """
    Scrape la page d'une boutique Etsy et retourne son nom + ses listings.
    """
    url = f"https://www.etsy.com/shop/{quote_plus(shop_name)}"
    log.info(f"GET shop page: {url}")

    page = session.get(url, stealthy_headers=True, timeout=30)
    if page.status != 200:
        raise RuntimeError(f"Etsy shop page returned HTTP {page.status}")

    # Nom de la boutique
    name_el = page.css("h1", first=True)
    resolved_name = name_el.text.strip() if name_el else shop_name
    shop_url = f"https://www.etsy.com/shop/{resolved_name}"

    # Images des listings (on prend les 4 premières cards)
    images = []
    listing_ids = []
    cards = page.css("[data-listing-id]") or []
    for card in cards[:8]:
        lid = card.attrib.get("data-listing-id")
        if lid:
            listing_ids.append(lid)
        img_el = card.css("img", first=True)
        if img_el:
            src = clean_image(img_el.attrib.get("src") or img_el.attrib.get("data-src"))
            if src and len(images) < 4:
                images.append(src)

    log.info(f"  → shop={resolved_name}, {len(images)} images, {len(listing_ids)} listings")
    return {
        "shopName": resolved_name,
        "shopUrl": shop_url,
        "images": images,
        "listingIds": listing_ids,
    }


def _get_listing_images(session: FetcherSession, listing_id: str):
    """Scrape la page d'un listing pour récupérer ses images et son prix."""
    url = f"https://www.etsy.com/listing/{listing_id}"
    log.info(f"GET listing: {url}")
    page = session.get(url, stealthy_headers=True, timeout=25)
    if page.status != 200:
        return None, None

    # Images
    img_els = page.css('[data-zoom-src]') or page.css('img[src*="etsystatic"]') or []
    images = []
    for el in img_els[:5]:
        src = clean_image(el.attrib.get("data-zoom-src") or el.attrib.get("src"))
        if src and src not in images:
            images.append(src)

    # Prix
    price_el = page.css('[data-buy-box-region] p[class*="price"]', first=True)
    price = price_el.text.strip() if price_el else None

    return images, price


# ── Routes Flask ──────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "scrapling-etsy"})


@app.route("/search", methods=["POST"])
def search():
    """
    Body: { keyword: str, limit: int (défaut 100), offset: int (défaut 0) }
    Réponse: [{ listingId, shopId, title, link, image }]
    """
    body = request.get_json(force=True)
    keyword = (body.get("keyword") or "").strip()
    limit = int(body.get("limit") or 100)
    offset = int(body.get("offset") or 0)

    if not keyword:
        return jsonify({"error": "keyword required"}), 400

    try:
        with make_session() as session:
            results = _search_page(session, keyword, offset=offset, limit=limit)
        return jsonify(results)
    except Exception as e:
        log.exception("search error")
        return jsonify({"error": str(e)}), 500


@app.route("/shop-info", methods=["POST"])
def shop_info():
    """
    Body: { shopName: str, listingId?: str, listingId2?: str, listingId3?: str, listingId4?: str }
    Réponse: { shopName, shopUrl, image, image2, image3, image4 }
    Remplace etsyApi.getShopNameAndImage()
    """
    body = request.get_json(force=True)
    shop_name = (body.get("shopName") or body.get("shopId") or "").strip()

    if not shop_name:
        return jsonify({"error": "shopName required"}), 400

    try:
        with make_session() as session:
            info = _get_shop_info(session, shop_name)

        images = info.get("images", [])
        # Complète avec None si moins de 4 images
        while len(images) < 4:
            images.append(None)

        return jsonify({
            "shopName": info["shopName"],
            "shopUrl": info["shopUrl"],
            "image": images[0],
            "image2": images[1],
            "image3": images[2],
            "image4": images[3],
        })
    except Exception as e:
        log.exception("shop-info error")
        return jsonify({"error": str(e)}), 500


@app.route("/shop-listings", methods=["POST"])
def shop_listings():
    """
    Body: { shopName: str, limit?: int }
    Réponse: [{ listingId, title, link, image, shopName, shopUrl }]
    Remplace etsyApi.getShopListings()
    """
    body = request.get_json(force=True)
    shop_name = (body.get("shopName") or body.get("shopIdOrName") or "").strip()
    limit = int(body.get("limit") or 20)

    if not shop_name:
        return jsonify({"error": "shopName required"}), 400

    try:
        with make_session() as session:
            info = _get_shop_info(session, shop_name)

        listing_ids = info.get("listingIds", [])[:limit]
        results = []
        for lid in listing_ids:
            results.append({
                "listingId": lid,
                "title": None,
                "link": f"https://www.etsy.com/listing/{lid}",
                "image": None,
                "shopName": info["shopName"],
                "shopUrl": info["shopUrl"],
            })
        return jsonify(results)
    except Exception as e:
        log.exception("shop-listings error")
        return jsonify({"error": str(e)}), 500


@app.route("/listing-detail", methods=["POST"])
def listing_detail():
    """
    Body: { listingId: str }
    Réponse: { title, price, images, shopName, shopId }
    Remplace etsyApi.getListingDetail()
    """
    body = request.get_json(force=True)
    listing_id = str(body.get("listingId") or "").strip()

    if not listing_id:
        return jsonify({"error": "listingId required"}), 400

    try:
        with make_session() as session:
            images, price = _get_listing_images(session, listing_id)

        return jsonify({
            "title": None,
            "price": price,
            "images": images or [],
            "shopName": None,
            "shopId": None,
        })
    except Exception as e:
        log.exception("listing-detail error")
        return jsonify({"error": str(e)}), 500


# ── Démarrage ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import os
    port = int(os.environ.get("SCRAPLING_PORT", 5001))
    log.info(f"Starting Scrapling microservice on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
