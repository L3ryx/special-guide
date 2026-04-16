"""
etsy_scraper.py
Microservice Flask pour scraper Etsy sans API officielle.
Utilise requests + BeautifulSoup (compatible Render, pas de binaire externe).
"""

import os
import re
import time
import random
import json
import requests
from bs4 import BeautifulSoup
from flask import Flask, request as flask_request, jsonify

app = Flask(__name__)

UA_LIST = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
]

def get_headers():
    return {
        "User-Agent": random.choice(UA_LIST),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Cache-Control": "max-age=0",
    }

def clean_image(url):
    if not url:
        return None
    url = url.split("?")[0]
    if url.startswith("//"):
        url = "https:" + url
    return url or None

def fetch(url, timeout=25):
    """Effectue une requête GET avec retry sur erreur réseau."""
    for attempt in range(3):
        try:
            resp = requests.get(url, headers=get_headers(), timeout=timeout)
            if resp.status_code == 429:
                time.sleep(3 + attempt * 2)
                continue
            return resp
        except requests.RequestException as e:
            if attempt == 2:
                raise
            time.sleep(2)
    return None

def parse_etsy_search(html, keyword):
    """Parse la page de résultats Etsy et extrait les listings."""
    soup = BeautifulSoup(html, "html.parser")
    listings = []

    # Essayer d'extraire les données JSON embarquées (plus fiable que le HTML)
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
            if isinstance(data, list):
                for item in data:
                    if item.get("@type") == "Product":
                        listing_id = None
                        link = item.get("url", "")
                        m = re.search(r"/listing/(\d+)", link)
                        if m:
                            listing_id = m.group(1)
                        image = clean_image(
                            item.get("image") if isinstance(item.get("image"), str)
                            else (item.get("image", [None])[0] if isinstance(item.get("image"), list) else None)
                        )
                        shop_name = None
                        brand = item.get("brand", {})
                        if isinstance(brand, dict):
                            shop_name = brand.get("name")
                        price = None
                        offers = item.get("offers", {})
                        if isinstance(offers, dict):
                            price = str(offers.get("price", ""))
                            currency = offers.get("priceCurrency", "")
                            if price and currency:
                                price = f"{currency} {price}"
                        if listing_id and link:
                            listings.append({
                                "listingId": listing_id,
                                "shopId": None,
                                "title": item.get("name"),
                                "link": link,
                                "image": image,
                                "shopName": shop_name,
                                "shopUrl": f"https://www.etsy.com/shop/{shop_name}" if shop_name else None,
                                "price": price,
                                "source": "etsy",
                            })
        except Exception:
            pass

    if listings:
        return listings

    # Fallback : parsing HTML classique
    cards = soup.select("li[data-palette-listing-id]")
    if not cards:
        cards = soup.select("[data-listing-id]")

    for card in cards:
        listing_id = card.get("data-palette-listing-id") or card.get("data-listing-id")
        if not listing_id:
            continue

        link_el = card.select_one("a[href*='/listing/']")
        link = link_el.get("href", "") if link_el else f"https://www.etsy.com/listing/{listing_id}"
        if link and not link.startswith("http"):
            link = "https://www.etsy.com" + link

        title_el = card.select_one("h3, .v2-listing-card__title")
        title = title_el.get_text(strip=True) if title_el else None

        img_el = card.select_one("img")
        image = None
        if img_el:
            image = clean_image(img_el.get("data-src") or img_el.get("src"))

        shop_name = None
        m = re.search(r"etsy\.com/shop/([^/?#&]+)", link)
        if m:
            shop_name = m.group(1)

        price_el = card.select_one(".currency-value, [data-price]")
        price = price_el.get_text(strip=True) if price_el else None

        listings.append({
            "listingId": listing_id,
            "shopId": None,
            "title": title,
            "link": link,
            "image": image,
            "shopName": shop_name,
            "shopUrl": f"https://www.etsy.com/shop/{shop_name}" if shop_name else None,
            "price": price,
            "source": "etsy",
        })

    return listings


# ── Flask routes ──────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/search", methods=["POST"])
def search():
    body = flask_request.get_json(force=True, silent=True) or {}
    keyword = body.get("keyword", "").strip()
    limit   = int(body.get("limit", 48))
    offset  = int(body.get("offset", 0))
    if not keyword:
        return jsonify({"error": "keyword required"}), 400

    page = (offset // limit) + 1
    from urllib.parse import quote_plus
    url = f"https://www.etsy.com/search?q={quote_plus(keyword)}&ref=search_bar&page={page}"

    try:
        resp = fetch(url)
        if not resp or not resp.ok:
            return jsonify({"error": f"Etsy returned {resp.status_code if resp else 'no response'}"}), 502
        listings = parse_etsy_search(resp.text, keyword)
        print(f"[/search] '{keyword}' page {page} → {len(listings)} listings")
        return jsonify({"results": listings})
    except Exception as e:
        print(f"[/search] Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/shop-name-and-image", methods=["POST"])
def shop_name_and_image():
    body = flask_request.get_json(force=True, silent=True) or {}
    shop_id     = body.get("shopId")
    listing_id  = body.get("listingId")
    listing_id2 = body.get("listingId2")

    if not listing_id:
        return jsonify({"error": "listingId required"}), 400

    shop_name = None
    shop_url  = None
    image     = None
    image2    = None

    def scrape_listing(lid):
        try:
            r = fetch(f"https://www.etsy.com/listing/{lid}", timeout=20)
            if not r or not r.ok:
                return None, None, None
            soup = BeautifulSoup(r.text, "html.parser")
            # Shop name
            sn = None
            shop_link = soup.select_one("a[href*='etsy.com/shop/']")
            if shop_link:
                m = re.search(r"etsy\.com/shop/([^/?#&]+)", shop_link.get("href", ""))
                if m:
                    sn = m.group(1)
            # Image principale
            img = None
            img_el = soup.select_one("img[src*='etsystatic'], img[data-src*='etsystatic']")
            if img_el:
                img = clean_image(img_el.get("src") or img_el.get("data-src"))
            if not img:
                # Fallback : première grande image
                for el in soup.select("img"):
                    src = el.get("src", "")
                    if "etsystatic" in src or "il_" in src:
                        img = clean_image(src)
                        break
            return sn, f"https://www.etsy.com/shop/{sn}" if sn else None, img
        except Exception as e:
            print(f"[scrape_listing] {lid} failed: {e}")
            return None, None, None

    sn1, su1, img1 = scrape_listing(listing_id)
    shop_name = sn1
    shop_url  = su1
    image     = img1

    if listing_id2:
        time.sleep(0.5)
        sn2, su2, img2_raw = scrape_listing(listing_id2)
        image2 = img2_raw
        if not shop_name and sn2:
            shop_name = sn2
            shop_url  = su2

    return jsonify({
        "shopName": shop_name,
        "shopUrl":  shop_url,
        "image":    image,
        "image2":   image2,
        "image3":   None,
        "image4":   None,
    })


@app.route("/shop-listings", methods=["POST"])
def shop_listings():
    body = flask_request.get_json(force=True, silent=True) or {}
    shop_id_or_name = body.get("shopIdOrName", "").strip()
    limit = int(body.get("limit", 20))
    if not shop_id_or_name:
        return jsonify({"error": "shopIdOrName required"}), 400

    try:
        resp = fetch(f"https://www.etsy.com/shop/{shop_id_or_name}", timeout=25)
        if not resp or not resp.ok:
            return jsonify({"results": []})
        soup = BeautifulSoup(resp.text, "html.parser")
        listings = []
        cards = soup.select("li[data-palette-listing-id], [data-listing-id]")
        for card in cards[:limit]:
            lid = card.get("data-palette-listing-id") or card.get("data-listing-id")
            link_el = card.select_one("a[href*='/listing/']")
            link = link_el.get("href") if link_el else None
            if link and not link.startswith("http"):
                link = "https://www.etsy.com" + link
            img_el = card.select_one("img")
            image = clean_image(img_el.get("data-src") or img_el.get("src")) if img_el else None
            title_el = card.select_one("h3, .v2-listing-card__title")
            title = title_el.get_text(strip=True) if title_el else None
            listings.append({
                "listingId": lid,
                "title": title,
                "link": link,
                "image": image,
                "source": "etsy",
                "shopName": str(shop_id_or_name),
                "shopUrl": f"https://www.etsy.com/shop/{shop_id_or_name}",
            })
        return jsonify({"results": listings})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/shop-info", methods=["POST"])
def shop_info():
    body = flask_request.get_json(force=True, silent=True) or {}
    shop_id_or_name = body.get("shopIdOrName", "").strip()
    if not shop_id_or_name:
        return jsonify({"error": "shopIdOrName required"}), 400
    try:
        resp = fetch(f"https://www.etsy.com/shop/{shop_id_or_name}", timeout=20)
        if not resp or not resp.ok:
            return jsonify({"error": "shop not found"}), 404
        soup = BeautifulSoup(resp.text, "html.parser")
        name_el = soup.select_one("h1")
        shop_name = name_el.get_text(strip=True) if name_el else str(shop_id_or_name)
        return jsonify({
            "shopName":   shop_name,
            "shopUrl":    f"https://www.etsy.com/shop/{shop_id_or_name}",
            "shopAvatar": None,
            "title":      shop_name,
            "numSales":   0,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/listing-detail", methods=["POST"])
def listing_detail():
    body = flask_request.get_json(force=True, silent=True) or {}
    listing_id = body.get("listingId")
    if not listing_id:
        return jsonify({"error": "listingId required"}), 400
    try:
        resp = fetch(f"https://www.etsy.com/listing/{listing_id}", timeout=25)
        if not resp or not resp.ok:
            return jsonify({"error": "listing not found"}), 404
        soup = BeautifulSoup(resp.text, "html.parser")
        title_el = soup.select_one("h1")
        title = title_el.get_text(strip=True) if title_el else None
        images = []
        for img in soup.select("img[src*='etsystatic'], img[data-src*='etsystatic']")[:5]:
            src = clean_image(img.get("src") or img.get("data-src"))
            if src and src not in images:
                images.append(src)
        shop_name = None
        shop_link = soup.select_one("a[href*='etsy.com/shop/']")
        if shop_link:
            m = re.search(r"etsy\.com/shop/([^/?#&]+)", shop_link.get("href", ""))
            if m:
                shop_name = m.group(1)
        return jsonify({
            "title":    title,
            "price":    None,
            "images":   images,
            "shopName": shop_name,
            "shopId":   None,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or os.environ.get("SCRAPER_PORT") or 5001)
    print(f"✅ Etsy Scraper Service démarré sur port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
