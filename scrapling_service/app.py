"""
scrapling_service/app.py
Microservice Python qui remplace l'API officielle Etsy.
Utilise la librairie Scrapling (FetcherSession) pour le TLS fingerprinting.

Logique principale du /search :
  - Recherche Etsy par mot-clé
  - Pour chaque boutique unique trouvée, on récupère 2 images de listings différents
  - Si une boutique a déjà été vue (passée dans `usedShops`), elle est ignorée
  - Les résultats sont compatibles avec ce qu'attend etsyApi.js / scrape.js

Endpoints :
  POST /search          — recherche de listings (avec déduplication par boutique)
  POST /shop-info       — nom + images d'une boutique
  POST /shop-listings   — listings actifs d'une boutique
  POST /listing-detail  — détail d'un listing
  GET  /health          — vérification que le service est vivant
"""

import re
import time
import random
import logging
from urllib.parse import urlencode, quote_plus

from flask import Flask, request, jsonify
from scrapling.fetchers import Fetcher, FetcherSession
from scrapling import ProxyRotator

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="[scrapling] %(message)s")
log = logging.getLogger(__name__)

app = Flask(__name__)

# ── Session globale réutilisable (cookies persistants + TLS fingerprint) ──────
_session: FetcherSession | None = None
_proxy_rotator: ProxyRotator | None = None


def get_proxy_rotator() -> ProxyRotator | None:
    """
    Retourne un ProxyRotator si des proxies sont configurés via la variable
    d'environnement SCRAPLING_PROXIES (liste séparée par des virgules).

    Exemple :
        SCRAPLING_PROXIES=http://user:pass@proxy1:8080,http://user:pass@proxy2:8080
    """
    global _proxy_rotator
    if _proxy_rotator is None:
        import os
        raw = os.environ.get("SCRAPLING_PROXIES", "")
        proxies = [p.strip() for p in raw.split(",") if p.strip()]
        if proxies:
            _proxy_rotator = ProxyRotator(proxies)
            log.info(f"ProxyRotator initialisé avec {len(proxies)} proxy(s)")
        else:
            log.info("Aucun proxy configuré (SCRAPLING_PROXIES non défini)")
    return _proxy_rotator


def get_session() -> FetcherSession:
    global _session
    if _session is None:
        rotator = get_proxy_rotator()
        _session = FetcherSession(
            impersonate="chrome124",
            stealthy_headers=True,
            proxy_rotator=rotator,  # None si aucun proxy configuré
        )
        log.info("FetcherSession créée (chrome124)")
    return _session


# ── Utilitaires ───────────────────────────────────────────────────────────────

def random_delay(min_s: float = 0.3, max_s: float = 0.9):
    time.sleep(random.uniform(min_s, max_s))


def clean_image(url: str | None) -> str | None:
    if not url:
        return None
    return url.split("?")[0]


# ── Warm-up : visite la homepage Etsy pour obtenir des cookies valides ─────────

def warmup():
    """Visite Etsy une fois pour récupérer les cookies de session."""
    try:
        session = get_session()
        session.get("https://www.etsy.com/", timeout=15)
        log.info("Warm-up Etsy OK — cookies récupérés")
    except Exception as e:
        log.warning(f"Warm-up failed (non-bloquant): {e}")


# ── Méthode 1 : endpoint JSON interne Etsy (/api/v3/ajax) ────────────────────

def _search_via_json_api(keyword: str, offset: int = 0, limit: int = 100) -> list[dict]:
    """
    Utilise l'endpoint JSON interne d'Etsy pour la recherche.
    Moins protégé que les pages HTML — Scrapling gère le TLS fingerprint.
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
    log.info(f"JSON API GET: {url}")

    r = session.get(url, timeout=25, headers={
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://www.etsy.com/",
    })

    if r.status == 403:
        raise RuntimeError("Etsy JSON API returned HTTP 403")
    if r.status != 200:
        raise RuntimeError(f"Etsy JSON API returned HTTP {r.status}")

    data = r.json()
    return _parse_json_api_results(data)


def _parse_json_api_results(data: dict) -> list[dict]:
    """Parse la réponse JSON de l'API interne Etsy."""
    results = []

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

        results.append({
            "listingId": str(lid),
            "shopId": str(shop_id),
            "title": item.get("title"),
            "link": f"https://www.etsy.com/listing/{lid}",
            "image": image,
            "shopName": shop_name,
        })

    return results


# ── Méthode 2 : parsing HTML avec Scrapling (fallback) ───────────────────────

def _search_via_html(keyword: str, offset: int = 0, limit: int = 100) -> list[dict]:
    """Fallback : scrape la page HTML de recherche Etsy."""
    session = get_session()

    params = urlencode({
        "q": keyword,
        "explicit": "1",
        "ref": "search_bar",
        "page": str(offset // 48 + 1),
    })
    url = f"https://www.etsy.com/search?{params}"

    log.info(f"HTML GET: {url}")
    r = session.get(url, timeout=30)

    if r.status != 200:
        raise RuntimeError(f"Etsy returned HTTP {r.status} for search")

    return _parse_html_listings(r.html, limit)


def _parse_html_listings(html: str, limit: int = 100) -> list[dict]:
    """Parse les listings depuis le HTML brut d'Etsy via regex."""
    results = []

    pattern = re.compile(
        r'"listing_id"\s*:\s*(\d+).*?"shop_id"\s*:\s*(\d+)',
        re.DOTALL
    )

    seen = set()
    for m in pattern.finditer(html):
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

def _search_page(keyword: str, offset: int = 0, limit: int = 100) -> list[dict]:
    """Tente d'abord l'API JSON interne, puis fallback HTML si 403."""
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


# ── Recherche avec déduplication par boutique + 2 images ──────────────────────

def _search_with_shop_dedup(
    keyword: str,
    limit: int = 100,
    offset: int = 0,
    used_shops: set | None = None,
) -> list[dict]:
    """
    Recherche Etsy avec logique de déduplication par boutique.

    Pour chaque boutique unique :
      - On collecte jusqu'à 2 listings distincts (image1, image2)
      - Si la boutique est dans `used_shops`, elle est ignorée
      - Retourne des objets compatibles avec ce qu'attend scrape.js :
        { listingId, shopId, shopName, title, link, image, image2 }

    Scanne plusieurs pages si nécessaire pour atteindre `limit` boutiques uniques.
    """
    if used_shops is None:
        used_shops = set()

    MAX_PAGES = 7
    per_page = 48

    # shop_id → { listingId, listingId2, image, image2, shopName, link, title }
    shop_map: dict[str, dict] = {}
    current_offset = offset
    page = 0

    while len(shop_map) < limit and page < MAX_PAGES:
        raw = _search_page(keyword, offset=current_offset, limit=per_page)
        if not raw:
            break

        for item in raw:
            shop_id = item.get("shopId") or ""
            shop_name = item.get("shopName") or shop_id

            # Ignore les boutiques déjà analysées
            key = shop_name if shop_name else shop_id
            if not key:
                continue
            if key in used_shops:
                continue

            listing_id = item.get("listingId")
            image = item.get("image")

            if shop_id not in shop_map:
                shop_map[shop_id] = {
                    "listingId":  listing_id,
                    "listingId2": None,
                    "image":      image,
                    "image2":     None,
                    "shopId":     shop_id,
                    "shopName":   shop_name,
                    "title":      item.get("title"),
                    "link":       item.get("link"),
                }
            else:
                # On complète avec un 2ème listing si on n'en a pas encore
                existing = shop_map[shop_id]
                if (
                    not existing["listingId2"]
                    and listing_id != existing["listingId"]
                ):
                    existing["listingId2"] = listing_id
                    existing["image2"] = image

            if len(shop_map) >= limit:
                break

        page += 1
        current_offset += per_page
        log.info(f"Scan page {page}/{MAX_PAGES}: {len(shop_map)} boutiques uniques")

        if len(raw) < per_page:
            break  # Etsy n'a plus de résultats

    # Convertit en liste plate pour la réponse JSON
    results = []
    for entry in shop_map.values():
        results.append({
            "listingId":  entry["listingId"],
            "listingId2": entry["listingId2"],
            "shopId":     entry["shopId"],
            "shopName":   entry["shopName"],
            "title":      entry["title"],
            "link":       entry["link"],
            "image":      entry["image"],
            "image2":     entry["image2"],
        })

    log.info(f"_search_with_shop_dedup: {len(results)} boutiques uniques retournées")
    return results


# ── Shop info ─────────────────────────────────────────────────────────────────

def _get_shop_info(shop_name: str) -> dict:
    session = get_session()
    url = f"https://www.etsy.com/shop/{quote_plus(shop_name)}"

    log.info(f"GET shop: {url}")
    r = session.get(url, timeout=25)

    if r.status != 200:
        raise RuntimeError(f"Etsy shop page returned HTTP {r.status}")

    html = r.html

    name_match = re.search(r'<h1[^>]*>\s*([^<]+)\s*</h1>', html)
    resolved_name = name_match.group(1).strip() if name_match else shop_name
    shop_url = f"https://www.etsy.com/shop/{resolved_name}"

    listing_ids = re.findall(r'data-listing-id="(\d+)"', html)
    img_urls = re.findall(r'src="(https://i\.etsystatic\.com/[^"?]+)', html)

    seen_ids: list[str] = []
    for lid in listing_ids:
        if lid not in seen_ids:
            seen_ids.append(lid)

    seen_imgs: list[str] = []
    for img in img_urls:
        if img not in seen_imgs:
            seen_imgs.append(img)

    log.info(f"Shop {resolved_name}: {len(seen_ids)} listings, {len(seen_imgs)} images")
    return {
        "shopName":   resolved_name,
        "shopUrl":    shop_url,
        "images":     seen_imgs[:4],
        "listingIds": seen_ids[:20],
    }


# ── Listing detail ─────────────────────────────────────────────────────────────

def _get_listing_images(listing_id: str) -> tuple[list[str] | None, str | None]:
    session = get_session()
    url = f"https://www.etsy.com/listing/{listing_id}"

    log.info(f"GET listing: {url}")
    r = session.get(url, timeout=25)
    if r.status != 200:
        return None, None

    html = r.html
    images = re.findall(r'"url_fullxfull"\s*:\s*"([^"]+)"', html)
    if not images:
        images = re.findall(r'src="(https://i\.etsystatic\.com/[^"?]+)', html)

    seen: list[str] = []
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
    """
    Corps JSON attendu :
      { "keyword": "...", "limit": 100, "offset": 0, "usedShops": ["Shop1", "Shop2"] }

    Retourne une liste de boutiques uniques avec 2 images chacune :
      [{ listingId, listingId2, shopId, shopName, title, link, image, image2 }, ...]
    """
    body = request.get_json(force=True)
    keyword = (body.get("keyword") or "").strip()
    limit = int(body.get("limit") or 100)
    offset = int(body.get("offset") or 0)
    used_shops = set(body.get("usedShops") or [])

    if not keyword:
        return jsonify({"error": "keyword required"}), 400

    try:
        results = _search_with_shop_dedup(keyword, limit=limit, offset=offset, used_shops=used_shops)
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
            "shopUrl":  info["shopUrl"],
            "image":    images[0],
            "image2":   images[1],
            "image3":   images[2],
            "image4":   images[3],
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
                "title":     None,
                "link":      f"https://www.etsy.com/listing/{lid}",
                "image":     None,
                "shopName":  info["shopName"],
                "shopUrl":   info["shopUrl"],
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
            "title":    None,
            "price":    price,
            "images":   images or [],
            "shopName": None,
            "shopId":   None,
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
