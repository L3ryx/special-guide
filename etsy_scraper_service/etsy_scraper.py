"""
etsy_scraper.py
Microservice Flask pour scraper Etsy sans API officielle.
Utilise curl_cffi qui imite la signature TLS de Chrome (contourne Cloudflare/bots).
"""

import os
import re
import time
import random
import json
from urllib.parse import quote_plus
from flask import Flask, request as flask_request, jsonify
from curl_cffi import requests as cffi_requests
from bs4 import BeautifulSoup

app = Flask(__name__)

CHROME_VERSIONS = ["chrome110", "chrome112", "chrome116", "chrome120", "chrome124"]

def get_impersonate():
    return random.choice(CHROME_VERSIONS)

def clean_image(url):
    if not url:
        return None
    if url.startswith("//"):
        url = "https:" + url
    return url.split("?")[0] or None

def fetch(url, timeout=30):
    """Requête GET avec impersonation Chrome TLS via curl_cffi."""
    for attempt in range(3):
        try:
            resp = cffi_requests.get(
                url,
                impersonate=get_impersonate(),
                headers={
                    "Accept-Language": "en-US,en;q=0.9",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                    "DNT": "1",
                },
                timeout=timeout,
                allow_redirects=True,
            )
            if resp.status_code == 429:
                wait = 3 + attempt * 3
                print(f"[fetch] 429 rate limit, attente {wait}s...")
                time.sleep(wait)
                continue
            if resp.status_code == 503:
                time.sleep(2 + attempt * 2)
                continue
            return resp
        except Exception as e:
            print(f"[fetch] attempt {attempt+1} failed: {e}")
            if attempt < 2:
                time.sleep(2)
    return None

def parse_etsy_search(html):
    soup = BeautifulSoup(html, "html.parser")
    listings = []

    # 1. Essayer JSON-LD embarqué
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
            items = data if isinstance(data, list) else [data]
            for item in items:
                if item.get("@type") != "Product":
                    continue
                link = item.get("url", "")
                m = re.search(r"/listing/(\d+)", link)
                if not m:
                    continue
                listing_id = m.group(1)
                raw_img = item.get("image")
                image = clean_image(
                    raw_img if isinstance(raw_img, str)
                    else (raw_img[0] if isinstance(raw_img, list) and raw_img else None)
                )
                brand = item.get("brand", {})
                shop_name = brand.get("name") if isinstance(brand, dict) else None
                offers = item.get("offers", {})
                price = None
                if isinstance(offers, dict):
                    p = offers.get("price", "")
                    c = offers.get("priceCurrency", "")
                    price = f"{c} {p}".strip() if p else None
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

    # 2. Fallback HTML
    cards = soup.select("li[data-palette-listing-id], [data-listing-id]")
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
        image = clean_image(img_el.get("data-src") or img_el.get("src")) if img_el else None
        shop_name = None
        m = re.search(r"etsy\.com/shop/([^/?#&]+)", link)
        if m:
            shop_name = m.group(1)
        price_el = card.select_one(".currency-value")
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


# ── Routes Flask ──────────────────────────────────────────────────────────────

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
    url = f"https://www.etsy.com/search?q={quote_plus(keyword)}&ref=search_bar&page={page}"
    try:
        resp = fetch(url)
        if not resp:
            return jsonify({"error": "Etsy returned no response"}), 502
        if not resp.ok:
            return jsonify({"error": f"Etsy returned {resp.status_code}"}), 502
        listings = parse_etsy_search(resp.text)
        print(f"[/search] '{keyword}' page {page} → {len(listings)} listings")
        return jsonify({"results": listings})
    except Exception as e:
        print(f"[/search] Error: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/shop-name-and-image", methods=["POST"])
def shop_name_and_image():
    body = flask_request.get_json(force=True, silent=True) or {}
    listing_id  = body.get("listingId")
    listing_id2 = body.get("listingId2")
    if not listing_id:
        return jsonify({"error": "listingId required"}), 400

    def scrape_listing(lid):
        try:
            r = fetch(f"https://www.etsy.com/listing/{lid}", timeout=20)
            if not r or not r.ok:
                return None, None, None
            soup = BeautifulSoup(r.text, "html.parser")
            sn = None
            shop_link = soup.select_one("a[href*='etsy.com/shop/']")
            if shop_link:
                m = re.search(r"etsy\.com/shop/([^/?#&]+)", shop_link.get("href", ""))
                if m:
                    sn = m.group(1)
            img = None
            for el in soup.select("img"):
                src = el.get("src") or el.get("data-src") or ""
                if "etsystatic" in src or "il_" in src:
                    img = clean_image(src)
                    break
            return sn, f"https://www.etsy.com/shop/{sn}" if sn else None, img
        except Exception as e:
            print(f"[scrape_listing] {lid}: {e}")
            return None, None, None

    sn1, su1, img1 = scrape_listing(listing_id)
    image2 = None
    if listing_id2:
        time.sleep(0.3)
        sn2, su2, img2 = scrape_listing(listing_id2)
        image2 = img2
        if not sn1 and sn2:
            sn1, su1 = sn2, su2

    return jsonify({
        "shopName": sn1,
        "shopUrl":  su1,
        "image":    img1,
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
            "shopName": shop_name,
            "shopUrl": f"https://www.etsy.com/shop/{shop_id_or_name}",
            "shopAvatar": None,
            "title": shop_name,
            "numSales": 0,
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
        for img in soup.select("img")[:10]:
            src = clean_image(img.get("src") or img.get("data-src") or "")
            if src and ("etsystatic" in src or "il_" in src) and src not in images:
                images.append(src)
                if len(images) >= 5:
                    break
        shop_name = None
        shop_link = soup.select_one("a[href*='etsy.com/shop/']")
        if shop_link:
            m = re.search(r"etsy\.com/shop/([^/?#&]+)", shop_link.get("href", ""))
            if m:
                shop_name = m.group(1)
        return jsonify({
            "title": title,
            "price": None,
            "images": images,
            "shopName": shop_name,
            "shopId": None,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT") or os.environ.get("SCRAPER_PORT") or 5001)
    print(f"✅ Etsy Scraper Service démarré sur port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
