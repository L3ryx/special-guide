"""
etsy_scraper.py
Microservice Python Flask utilisant botasaurus (@request) pour scraper Etsy
sans API officielle.

Endpoints :
  POST /search          → liste de listings Etsy
  POST /shop-listings   → listings d'une boutique
  POST /shop-info       → info d'une boutique
  POST /listing-detail  → détail d'un listing
  GET  /health          → health check
"""

from flask import Flask, request, jsonify
import re, time, random
from botasaurus.request import request as bot_request
from botasaurus.soupify import soupify

app = Flask(__name__)

# ── User-agents pool ──────────────────────────────────────────────────────────
UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
]


def rand_ua():
    return random.choice(UA_LIST)


# ── Helpers ───────────────────────────────────────────────────────────────────

def clean_image(url):
    if not url:
        return None
    return url.split("?")[0]


def extract_price(text):
    if not text:
        return None
    m = re.search(r"[\$€£]\s?[\d,]+\.?\d*", text)
    return m.group(0) if m else text.strip()


# ── Core scraping functions (using botasaurus @request) ──────────────────────

@bot_request(output=None, cache=False, close_on_crash=True)
def _search_etsy(reqs, data):
    keyword = data["keyword"]
    limit   = data.get("limit", 48)
    offset  = data.get("offset", 0)
    page    = (offset // limit) + 1

    url = (
        f"https://www.etsy.com/search"
        f"?q={requests_encode(keyword)}&ref=search_bar"
        f"&page={page}"
    )

    resp = reqs.get(
        url,
        headers={
            "User-Agent": rand_ua(),
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        timeout=30,
    )
    resp.raise_for_status()
    soup = soupify(resp)

    listings = []
    # Etsy search results cards
    cards = soup.select("li[data-palette-listing-id]")
    if not cards:
        # fallback selector
        cards = soup.select(".v2-listing-card, [data-listing-id]")

    for card in cards:
        listing_id = (
            card.get("data-palette-listing-id")
            or card.get("data-listing-id")
        )
        if not listing_id:
            continue

        link_el = card.select_one("a.listing-link, a[href*='/listing/']")
        link = link_el["href"] if link_el else f"https://www.etsy.com/listing/{listing_id}"
        if link and not link.startswith("http"):
            link = "https://www.etsy.com" + link

        title_el = card.select_one("h3, .v2-listing-card__title, [data-search-card-title]")
        title = title_el.get_text(strip=True) if title_el else None

        img_el = card.select_one("img")
        image = None
        if img_el:
            image = clean_image(
                img_el.get("src") or img_el.get("data-src") or img_el.get("data-lazy-src")
            )

        shop_el = card.select_one(".shop-name, [data-shop-name]")
        shop_name = None
        if shop_el:
            shop_name = shop_el.get_text(strip=True)
        if not shop_name:
            # Try to extract from link href
            m = re.search(r"etsy\.com/shop/([^/?#]+)", link or "")
            if m:
                shop_name = m.group(1)

        shop_url = f"https://www.etsy.com/shop/{shop_name}" if shop_name else None

        price_el = card.select_one(".currency-value, [data-price]")
        price = extract_price(price_el.get_text(strip=True) if price_el else None)

        # Try to get shop_id from card attributes
        shop_id = card.get("data-shop-id") or None

        listings.append({
            "listingId": listing_id,
            "shopId":    shop_id,
            "title":     title,
            "link":      link,
            "image":     image,
            "shopName":  shop_name,
            "shopUrl":   shop_url,
            "price":     price,
            "source":    "etsy",
        })

    return {"results": listings}


@bot_request(output=None, cache=False, close_on_crash=True)
def _get_shop_info(reqs, data):
    shop_id_or_name = data["shopIdOrName"]

    # If numeric ID, we first need to resolve the name via the public shop page
    # Etsy public shop URL: etsy.com/shop/{shopName} OR via listing page
    if str(shop_id_or_name).isdigit():
        # Use a listing page to find the shop name
        # Fallback: search for the shop page by ID via listing API (public JSON endpoint)
        url = f"https://www.etsy.com/api/v3/ajax/bespoke/public/neu/specs/listings?listing_ids={shop_id_or_name}"
        resp = reqs.get(url, headers={"User-Agent": rand_ua()}, timeout=15)
        if resp.ok:
            try:
                d = resp.json()
                # Try to extract shop name
                for item in d.get("output", {}).values():
                    sn = item.get("shop", {}).get("shop_name") or item.get("primary_image", {})
                    if isinstance(sn, str):
                        shop_id_or_name = sn
                        break
            except Exception:
                pass

    url = f"https://www.etsy.com/shop/{shop_id_or_name}"
    resp = reqs.get(
        url,
        headers={"User-Agent": rand_ua(), "Accept-Language": "en-US,en;q=0.9"},
        timeout=20,
    )
    resp.raise_for_status()
    soup = soupify(resp)

    shop_name = shop_id_or_name
    name_el = soup.select_one("h1.shop-name-and-title-container__title, h1[data-shop-name]")
    if name_el:
        shop_name = name_el.get_text(strip=True)

    avatar_el = soup.select_one(".shop-icon img, .shop-home-header-icon img")
    avatar = clean_image(avatar_el.get("src") if avatar_el else None)

    title_el = soup.select_one(".shop-name-and-title-container__title-text, .shop-title")
    title = title_el.get_text(strip=True) if title_el else None

    sales_el = soup.select_one(".shop-sales-count, [data-sales-count]")
    num_sales = 0
    if sales_el:
        m = re.search(r"[\d,]+", sales_el.get_text())
        if m:
            num_sales = int(m.group(0).replace(",", ""))

    return {
        "shopName":   shop_name,
        "shopUrl":    f"https://www.etsy.com/shop/{shop_name}",
        "shopAvatar": avatar,
        "title":      title,
        "numSales":   num_sales,
    }


@bot_request(output=None, cache=False, close_on_crash=True)
def _get_shop_listings(reqs, data):
    shop_id_or_name = data["shopIdOrName"]
    limit = data.get("limit", 20)

    url = f"https://www.etsy.com/shop/{shop_id_or_name}"
    resp = reqs.get(
        url,
        headers={"User-Agent": rand_ua(), "Accept-Language": "en-US,en;q=0.9"},
        timeout=25,
    )
    resp.raise_for_status()
    soup = soupify(resp)

    listings = []
    cards = soup.select("li[data-palette-listing-id], .v2-listing-card")
    for card in cards[:limit]:
        listing_id = card.get("data-palette-listing-id") or card.get("data-listing-id")
        link_el = card.select_one("a[href*='/listing/']")
        link = link_el["href"] if link_el else None
        if link and not link.startswith("http"):
            link = "https://www.etsy.com" + link

        img_el = card.select_one("img")
        image = None
        if img_el:
            image = clean_image(img_el.get("src") or img_el.get("data-src"))

        title_el = card.select_one("h3, .v2-listing-card__title")
        title = title_el.get_text(strip=True) if title_el else None

        price_el = card.select_one(".currency-value")
        price = extract_price(price_el.get_text(strip=True) if price_el else None)

        listings.append({
            "listingId": listing_id,
            "title":     title,
            "link":      link,
            "image":     image,
            "price":     price,
            "source":    "etsy",
            "shopName":  str(shop_id_or_name),
            "shopUrl":   f"https://www.etsy.com/shop/{shop_id_or_name}",
        })

    return {"results": listings}


@bot_request(output=None, cache=False, close_on_crash=True)
def _get_listing_detail(reqs, data):
    listing_id = data["listingId"]
    url = f"https://www.etsy.com/listing/{listing_id}"

    resp = reqs.get(
        url,
        headers={"User-Agent": rand_ua(), "Accept-Language": "en-US,en;q=0.9"},
        timeout=25,
    )
    resp.raise_for_status()
    soup = soupify(resp)

    title_el = soup.select_one("h1.wt-text-body-03, h1[data-listing-title]")
    title = title_el.get_text(strip=True) if title_el else None

    images = []
    for img in soup.select(".listing-page-image-carousel-component img, .carousel-image img, img[data-src*='etsystatic']")[:5]:
        src = clean_image(img.get("src") or img.get("data-src"))
        if src:
            images.append(src)

    price_el = soup.select_one("p.wt-text-title-03.wt-mr-xs-2, [data-selector='price-only']")
    price = extract_price(price_el.get_text(strip=True) if price_el else None)

    shop_el = soup.select_one("a.wt-display-inline-flex-xs.wt-text-link-no-underline")
    shop_name = None
    shop_id = None
    if shop_el:
        m = re.search(r"etsy\.com/shop/([^/?#]+)", shop_el.get("href", ""))
        if m:
            shop_name = m.group(1)

    return {
        "title":    title,
        "price":    price,
        "images":   images,
        "shopName": shop_name,
        "shopId":   shop_id,
    }


@bot_request(output=None, cache=False, close_on_crash=True)
def _get_shop_name_and_image(reqs, data):
    """
    Pour un shopId numérique : scrape la page boutique pour récupérer shopName + images
    via les listing IDs fournis.
    """
    shop_id = data["shopId"]
    listing_id  = data.get("listingId")
    listing_id2 = data.get("listingId2")

    # 1. Résoudre le nom de boutique depuis un listing
    shop_name = None
    shop_url  = None
    image     = None
    image2    = None

    if listing_id:
        url = f"https://www.etsy.com/listing/{listing_id}"
        try:
            resp = reqs.get(url, headers={"User-Agent": rand_ua()}, timeout=20)
            if resp.ok:
                soup = soupify(resp)
                shop_link = soup.select_one("a[href*='etsy.com/shop/']")
                if shop_link:
                    m = re.search(r"etsy\.com/shop/([^/?#]+)", shop_link.get("href", ""))
                    if m:
                        shop_name = m.group(1)
                        shop_url  = f"https://www.etsy.com/shop/{shop_name}"
                img = soup.select_one("img[data-src*='etsystatic'], .listing-page-image-carousel-component img")
                if img:
                    image = clean_image(img.get("src") or img.get("data-src"))
        except Exception as e:
            print(f"[_get_shop_name_and_image] listing1 failed: {e}")

    if listing_id2:
        url2 = f"https://www.etsy.com/listing/{listing_id2}"
        try:
            resp2 = reqs.get(url2, headers={"User-Agent": rand_ua()}, timeout=20)
            if resp2.ok:
                soup2 = soupify(resp2)
                img2 = soup2.select_one("img[data-src*='etsystatic'], .listing-page-image-carousel-component img")
                if img2:
                    image2 = clean_image(img2.get("src") or img2.get("data-src"))
                if not shop_name:
                    sl = soup2.select_one("a[href*='etsy.com/shop/']")
                    if sl:
                        m2 = re.search(r"etsy\.com/shop/([^/?#]+)", sl.get("href", ""))
                        if m2:
                            shop_name = m2.group(1)
                            shop_url  = f"https://www.etsy.com/shop/{shop_name}"
        except Exception as e:
            print(f"[_get_shop_name_and_image] listing2 failed: {e}")

    return {
        "shopName": shop_name,
        "shopUrl":  shop_url,
        "image":    image,
        "image2":   image2,
        "image3":   None,
        "image4":   None,
    }


def requests_encode(text):
    """Simple URL encoding without importing urllib at module level."""
    from urllib.parse import quote_plus
    return quote_plus(text)


# ── Flask routes ──────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/search", methods=["POST"])
def search():
    body = request.get_json(force=True, silent=True) or {}
    keyword = body.get("keyword", "").strip()
    limit   = int(body.get("limit", 48))
    offset  = int(body.get("offset", 0))
    if not keyword:
        return jsonify({"error": "keyword required"}), 400

    try:
        result = _search_etsy(data={"keyword": keyword, "limit": limit, "offset": offset})
        return jsonify(result or {"results": []})
    except Exception as e:
        print(f"[/search] Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/shop-info", methods=["POST"])
def shop_info():
    body = request.get_json(force=True, silent=True) or {}
    shop_id_or_name = body.get("shopIdOrName", "").strip()
    if not shop_id_or_name:
        return jsonify({"error": "shopIdOrName required"}), 400
    try:
        result = _get_shop_info(data={"shopIdOrName": shop_id_or_name})
        return jsonify(result or {})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/shop-listings", methods=["POST"])
def shop_listings():
    body = request.get_json(force=True, silent=True) or {}
    shop_id_or_name = body.get("shopIdOrName", "").strip()
    limit = int(body.get("limit", 20))
    if not shop_id_or_name:
        return jsonify({"error": "shopIdOrName required"}), 400
    try:
        result = _get_shop_listings(data={"shopIdOrName": shop_id_or_name, "limit": limit})
        return jsonify(result or {"results": []})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/listing-detail", methods=["POST"])
def listing_detail():
    body = request.get_json(force=True, silent=True) or {}
    listing_id = body.get("listingId")
    if not listing_id:
        return jsonify({"error": "listingId required"}), 400
    try:
        result = _get_listing_detail(data={"listingId": listing_id})
        return jsonify(result or {})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/shop-name-and-image", methods=["POST"])
def shop_name_and_image():
    body = request.get_json(force=True, silent=True) or {}
    shop_id     = body.get("shopId")
    listing_id  = body.get("listingId")
    listing_id2 = body.get("listingId2")
    if not shop_id:
        return jsonify({"error": "shopId required"}), 400
    try:
        result = _get_shop_name_and_image(data={
            "shopId":     shop_id,
            "listingId":  listing_id,
            "listingId2": listing_id2,
        })
        return jsonify(result or {})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    import os
    # Sur Render, utiliser la variable PORT (assignée automatiquement par Render).
    # En local, utiliser SCRAPER_PORT ou 5001.
    port = int(os.environ.get("PORT") or os.environ.get("SCRAPER_PORT") or 5001)
    print(f"✅ Etsy Scraper Service (botasaurus) démarré sur port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
