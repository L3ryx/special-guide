"""
scrapling_service/app.py
Microservice Python qui remplace l'API officielle Etsy.
Utilise curl_cffi pour le TLS fingerprinting + endpoints JSON internes Etsy.

Endpoints :
  POST /search          — recherche de listings par mot-clé
  POST /shop-info       — nom + images d'une boutique
  POST /shop-listings   — listings actifs d'une boutique
  POST /listing-detail  — détail d'un listing
  GET  /health          — vérification que le service est vivant
"""

import re
import json
import time
import random
import logging
from urllib.parse import urlencode, quote_plus

from flask import Flask, request, jsonify
from curl_cffi import requests as curl_requests

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="[scrapling] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

# ── Session globale réutilisable (cookies persistants) ────────────────────────
_session = None

def get_session():
    global _session
    if _session is None:
        _session = curl_requests.Session(impersonate="chrome124")
    return _session


# ── Headers réalistes ─────────────────────────────────────────────────────────

BROWSER_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "max-age=0",
    "DNT": "1",
}

JSON_HEADERS = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "X-Requested-With": "XMLHttpRequest",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "Referer": "https://www.etsy.com/",
}

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]


def random_ua():
    return random.choice(USER_AGENTS)


def random_delay(min_s=0.3, max_s=0.9):
    time.sleep(random.uniform(min_s, max_s))


def clean_image(url):
    if not url:
        return None
    return url.split("?")[0]


# ── Warm-up : visite la homepage Etsy pour obtenir des cookies valides ─────────

def warmup():
    """Visite Etsy une fois pour récupérer les cookies de session."""
    try:
        session = get_session()
        headers = {**BROWSER_HEADERS, "User-Agent": random_ua()}
        session.get("https://www.etsy.com/", headers=headers, timeout=15)
        log.info("Warm-up Etsy OK — cookies récupérés")
    except Exception as e:
        log.warning(f"Warm-up failed (non-bloquant): {e}")


# ── Méthode 1 : endpoint JSON interne Etsy (/api/v3/ajax) ────────────────────

def _search_via_json_api(keyword: str, offset: int = 0, limit: int = 100):
    """
    Utilise l'endpoint JSON interne d'Etsy pour la recherche.
    Beaucoup moins protégé que les pages HTML.
    """
    session = get_session()

    params = {
        "q": keyword,
        "ref": "search_bar",
        "explicit": "1",
        "offset": str(offset),
        "limit": str(min(limit, 48)),
    }

    url = f"https://www.etsy.com/api/v3/ajax/bespoke/public/listings/search?{urlencode(params)}"
    headers = {**JSON_HEADERS, "User-Agent": random_ua()}

    log.info(f"JSON API GET: {url}")
    r = session.get(url, headers=headers, timeout=25)

    if r.status_code == 403:
        raise RuntimeError(f"Etsy JSON API returned HTTP 403")
    if r.status_code != 200:
        raise RuntimeError(f"Etsy JSON API returned HTTP {r.status_code}")

    data = r.json()
    return _parse_json_api_results(data)


def _parse_json_api_results(data):
    """Parse la réponse JSON de l'API interne Etsy."""
    results = []

    # Structure typique : data.results[] ou data.listings[]
    listings = (
        data.get("results") or
        data.get("listings") or
        data.get("data", {}).get("results") or
        []
    )

    for item in listings:
        lid = (
            item.get("listing_id") or
            item.get("listingId") or
            item.get("id")
        )
        if not lid:
            continue

        shop = item.get("shop") or item.get("seller") or {}
        shop_id = (
            item.get("shop_id") or
            item.get("shopId") or
            shop.get("shop_id") or
            shop.get("id") or
            ""
        )
        shop_name = shop.get("shop_name") or shop.get("name") or None

        images = item.get("images") or item.get("listing_images") or []
        image = None
        if images:
            img = images[0]
            image = clean_image(
                img.get("url_fullxfull") or
                img.get("url_570xN") or
                img.get("url_170x135") or
                img.get("url")
            )

        title = item.get("title")
        link = f"https://www.etsy.com/listing/{lid}"

        results.append({
            "listingId": str(lid),
            "shopId": str(shop_id),
            "title": title,
            "link": link,
            "image": image,
            "shopName": shop_name,
        })

    return results


# ── Méthode 2 : parsing HTML avec curl_cffi (fallback) ───────────────────────

def _search_via_html(keyword: str, offset: int = 0, limit: int = 100):
    """
    Fallback : scrape la page HTML de recherche Etsy.
    """
    session = get_session()
    params = urlencode({
        "q": keyword,
        "explicit": "1",
        "ref": "search_bar",
        "page": str(offset // 48 + 1),
    })
    url = f"https://www.etsy.com/search?{params}"
    headers = {**BROWSER_HEADERS, "User-Agent": random_ua()}

    log.info(f"HTML GET: {url}")
    r = session.get(url, headers=headers, timeout=30)

    if r.status_code != 200:
        raise RuntimeError(f"Etsy returned HTTP {r.status_code} for search")

    return _parse_html_listings(r.text, limit)


def _parse_html_listings(html: str, limit: int = 100):
    """Parse les listings depuis le HTML brut d'Etsy via regex."""
    results = []

    # Etsy injecte les données listing dans des balises JSON
    # On cherche les listing_id + shop_id dans le JSON embarqué
    pattern = re.compile(
        r'"listing_id"\s*:\s*(\d+).*?"shop_id"\s*:\s*(\d+)',
        re.DOTALL
    )

    seen = set()
    for m in pattern.finditer(html):
        lid = m.group(1)
        sid = m.group(2)
        if lid in seen:
            continue
        seen.add(lid)
        results.append({
            "listingId": lid,
            "shopId": sid,
            "title": None,
            "link": f"https://www.etsy.com/listing/{lid}",
            "image": None,
            "shopName": None,
        })
        if len(results) >= limit:
            break

    # Si rien trouvé avec listing_id, on tente une regex plus large
    if not results:
        pattern2 = re.compile(r'data-listing-id="(\d+)"[^>]*data-shop-id="(\d+)"')
        for m in pattern2.finditer(html):
            lid, sid = m.group(1), m.group(2)
            if lid in seen:
                continue
            seen.add(lid)
            results.append({
                "listingId": lid,
                "shopId": sid,
                "title": None,
                "link": f"https://www.etsy.com/listing/{lid}",
                "image": None,
                "shopName": None,
            })
            if len(results) >= limit:
                break

    log.info(f"HTML parse: {len(results)} listings")
    return results


# ── Search principal avec fallback ────────────────────────────────────────────

def _search_page(keyword: str, offset: int = 0, limit: int = 100):
    """
    Tente d'abord l'API JSON interne, puis fallback HTML si 403.
    """
    try:
        results = _search_via_json_api(keyword, offset, limit)
        if results:
            log.info(f"JSON API: {len(results)} résultats")
            return results
        log.warning("JSON API: 0 résultats, fallback HTML")
    except Exception as e:
        log.warning(f"JSON API failed ({e}), fallback HTML")

    random_delay()
    return _search_via_html(keyword, offset, limit)


# ── Shop info ─────────────────────────────────────────────────────────────────

def _get_shop_info(shop_name: str):
    session = get_session()
    url = f"https://www.etsy.com/shop/{quote_plus(shop_name)}"
    headers = {**BROWSER_HEADERS, "User-Agent": random_ua()}

    log.info(f"GET shop: {url}")
    r = session.get(url, headers=headers, timeout=25)

    if r.status_code != 200:
        raise RuntimeError(f"Etsy shop page returned HTTP {r.status_code}")

    html = r.text

    # Nom de la boutique
    name_match = re.search(r'<h1[^>]*>\s*([^<]+)\s*</h1>', html)
    resolved_name = name_match.group(1).strip() if name_match else shop_name
    shop_url = f"https://www.etsy.com/shop/{resolved_name}"

    # Images et listing IDs via regex
    listing_ids = re.findall(r'data-listing-id="(\d+)"', html)
    img_urls = re.findall(r'src="(https://i\.etsystatic\.com/[^"?]+)', html)

    # Déduplique
    seen_ids = []
    for lid in listing_ids:
        if lid not in seen_ids:
            seen_ids.append(lid)

    seen_imgs = []
    for img in img_urls:
        if img not in seen_imgs:
            seen_imgs.append(img)

    log.info(f"Shop {resolved_name}: {len(seen_ids)} listings, {len(seen_imgs)} images")
    return {
        "shopName": resolved_name,
        "shopUrl": shop_url,
        "images": seen_imgs[:4],
        "listingIds": seen_ids[:20],
    }


# ── Listing detail ─────────────────────────────────────────────────────────────

def _get_listing_images(listing_id: str):
    session = get_session()
    url = f"https://www.etsy.com/listing/{listing_id}"
    headers = {**BROWSER_HEADERS, "User-Agent": random_ua()}

    log.info(f"GET listing: {url}")
    r = session.get(url, headers=headers, timeout=25)
    if r.status_code != 200:
        return None, None

    html = r.text
    images = re.findall(r'"url_fullxfull"\s*:\s*"([^"]+)"', html)
    if not images:
        images = re.findall(r'src="(https://i\.etsystatic\.com/[^"?]+)', html)

    seen = []
    for img in images:
        clean = clean_image(img)
        if clean and clean not in seen:
            seen.append(clean)
        if len(seen) >= 5:
            break

    price_match = re.search(r'"price"\s*:\s*\{[^}]*"amount"\s*:\s*([\d.]+)', html)
    price = price_match.group(1) if price_match else None

    return seen, price


# ── Routes Flask ──────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "scrapling-etsy"})


@app.route("/search", methods=["POST"])
def search():
    body = request.get_json(force=True)
    keyword = (body.get("keyword") or "").strip()
    limit = int(body.get("limit") or 100)
    offset = int(body.get("offset") or 0)

    if not keyword:
        return jsonify({"error": "keyword required"}), 400

    try:
        results = _search_page(keyword, offset=offset, limit=limit)
        return jsonify(results)
    except Exception as e:
        log.exception("search error")
        return jsonify({"error": str(e)}), 500


@app.route("/shop-info", methods=["POST"])
def shop_info():
    body = request.get_json(force=True)
    shop_name = (body.get("shopName") or body.get("shopId") or "").strip()

    if not shop_name:
        return jsonify({"error": "shopName required"}), 400

    try:
        info = _get_shop_info(shop_name)
        images = info.get("images", [])
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
    body = request.get_json(force=True)
    shop_name = (body.get("shopName") or body.get("shopIdOrName") or "").strip()
    limit = int(body.get("limit") or 20)

    if not shop_name:
        return jsonify({"error": "shopName required"}), 400

    try:
        info = _get_shop_info(shop_name)
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
    body = request.get_json(force=True)
    listing_id = str(body.get("listingId") or "").strip()

    if not listing_id:
        return jsonify({"error": "listingId required"}), 400

    try:
        images, price = _get_listing_images(listing_id)
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
    warmup()
    app.run(host="0.0.0.0", port=port, debug=False)
