"""
etsy_scraper.py
Microservice Flask pour scraper Etsy via Tor (IPs résidentielles rotatives, gratuit).
"""

import os
import re
import time
import json
import socket
import subprocess
import threading
from urllib.parse import quote_plus
from flask import Flask, request as flask_request, jsonify
import requests
from bs4 import BeautifulSoup

app = Flask(__name__)

TOR_SOCKS = "socks5h://127.0.0.1:9050"
TOR_CONTROL_PORT = 9051
_tor_proc = None
_tor_ready = False

# ── Démarrage Tor ─────────────────────────────────────────────────────────────

def start_tor():
    global _tor_proc, _tor_ready
    os.makedirs("/tmp/tor_data", exist_ok=True)
    config = (
        "SocksPort 9050\n"
        "ControlPort 9051\n"
        "DataDirectory /tmp/tor_data\n"
        "CookieAuthentication 0\n"
        "HashedControlPassword \"\"\n"
        "ExitNodes {us},{de},{fr},{nl},{gb}\n"
        "StrictNodes 0\n"
    )
    with open("/tmp/torrc", "w") as f:
        f.write(config)

    _tor_proc = subprocess.Popen(
        ["tor", "-f", "/tmp/torrc"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )

    # Attendre que Tor soit prêt (max 40s)
    deadline = time.time() + 40
    while time.time() < deadline:
        try:
            s = socket.socket()
            s.settimeout(1)
            s.connect(("127.0.0.1", 9050))
            s.close()
            _tor_ready = True
            print("[Tor] ✅ Prêt sur port 9050")
            return
        except Exception:
            time.sleep(1)
    print("[Tor] ⚠️  Timeout — Tor n'a pas démarré à temps")


def rotate_tor_ip():
    """Demande un nouveau circuit Tor (nouvelle IP de sortie)."""
    try:
        from stem import Signal
        from stem.control import Controller
        with Controller.from_port(port=TOR_CONTROL_PORT) as ctrl:
            ctrl.authenticate()
            ctrl.signal(Signal.NEWNYM)
            time.sleep(5)
            print("[Tor] 🔄 Nouvelle IP demandée")
    except Exception as e:
        print(f"[Tor] rotate_ip failed: {e}")


def get_session():
    """Retourne une session requests configurée via Tor."""
    session = requests.Session()
    if _tor_ready:
        session.proxies = {"http": TOR_SOCKS, "https": TOR_SOCKS}
    return session


# ── Helpers ───────────────────────────────────────────────────────────────────

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "DNT": "1",
}

def clean_image(url):
    if not url:
        return None
    if url.startswith("//"):
        url = "https:" + url
    return url.split("?")[0] or None


def fetch(url, timeout=35):
    for attempt in range(3):
        try:
            session = get_session()
            resp = session.get(url, headers=HEADERS, timeout=timeout)
            if resp.status_code == 429:
                print(f"[fetch] 429 — rotation IP Tor...")
                rotate_tor_ip()
                continue
            if resp.status_code in (403, 503):
                print(f"[fetch] {resp.status_code} — rotation IP Tor...")
                rotate_tor_ip()
                continue
            return resp
        except Exception as e:
            print(f"[fetch] attempt {attempt+1}: {e}")
            if attempt < 2:
                time.sleep(2)
    return None


def parse_etsy_search(html):
    soup = BeautifulSoup(html, "html.parser")
    listings = []

    # 1. JSON-LD embarqué
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
                    p = str(offers.get("price", ""))
                    c = offers.get("priceCurrency", "")
                    price = f"{c} {p}".strip() if p else None
                listings.append({
                    "listingId": listing_id, "shopId": None,
                    "title": item.get("name"), "link": link,
                    "image": image, "shopName": shop_name,
                    "shopUrl": f"https://www.etsy.com/shop/{shop_name}" if shop_name else None,
                    "price": price, "source": "etsy",
                })
        except Exception:
            pass

    if listings:
        return listings

    # 2. Fallback HTML
    for card in soup.select("li[data-palette-listing-id], [data-listing-id]"):
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
            "listingId": listing_id, "shopId": None,
            "title": title, "link": link, "image": image,
            "shopName": shop_name,
            "shopUrl": f"https://www.etsy.com/shop/{shop_name}" if shop_name else None,
            "price": price, "source": "etsy",
        })
    return listings


# ── Routes Flask ──────────────────────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "tor": _tor_ready})


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
            r = fetch(f"https://www.etsy.com/listing/{lid}", timeout=25)
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

    return jsonify({"shopName": sn1, "shopUrl": su1, "image": img1,
                    "image2": image2, "image3": None, "image4": None})


@app.route("/shop-listings", methods=["POST"])
def shop_listings():
    body = flask_request.get_json(force=True, silent=True) or {}
    shop_id_or_name = body.get("shopIdOrName", "").strip()
    limit = int(body.get("limit", 20))
    if not shop_id_or_name:
        return jsonify({"error": "shopIdOrName required"}), 400
    try:
        resp = fetch(f"https://www.etsy.com/shop/{shop_id_or_name}", timeout=30)
        if not resp or not resp.ok:
            return jsonify({"results": []})
        soup = BeautifulSoup(resp.text, "html.parser")
        listings = []
        for card in soup.select("li[data-palette-listing-id], [data-listing-id]")[:limit]:
            lid = card.get("data-palette-listing-id") or card.get("data-listing-id")
            link_el = card.select_one("a[href*='/listing/']")
            link = link_el.get("href") if link_el else None
            if link and not link.startswith("http"):
                link = "https://www.etsy.com" + link
            img_el = card.select_one("img")
            image = clean_image(img_el.get("data-src") or img_el.get("src")) if img_el else None
            title_el = card.select_one("h3, .v2-listing-card__title")
            title = title_el.get_text(strip=True) if title_el else None
            listings.append({"listingId": lid, "title": title, "link": link,
                             "image": image, "source": "etsy",
                             "shopName": str(shop_id_or_name),
                             "shopUrl": f"https://www.etsy.com/shop/{shop_id_or_name}"})
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
        resp = fetch(f"https://www.etsy.com/shop/{shop_id_or_name}", timeout=25)
        if not resp or not resp.ok:
            return jsonify({"error": "shop not found"}), 404
        soup = BeautifulSoup(resp.text, "html.parser")
        name_el = soup.select_one("h1")
        shop_name = name_el.get_text(strip=True) if name_el else str(shop_id_or_name)
        return jsonify({"shopName": shop_name,
                        "shopUrl": f"https://www.etsy.com/shop/{shop_id_or_name}",
                        "shopAvatar": None, "title": shop_name, "numSales": 0})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/listing-detail", methods=["POST"])
def listing_detail():
    body = flask_request.get_json(force=True, silent=True) or {}
    listing_id = body.get("listingId")
    if not listing_id:
        return jsonify({"error": "listingId required"}), 400
    try:
        resp = fetch(f"https://www.etsy.com/listing/{listing_id}", timeout=30)
        if not resp or not resp.ok:
            return jsonify({"error": "listing not found"}), 404
        soup = BeautifulSoup(resp.text, "html.parser")
        title_el = soup.select_one("h1")
        title = title_el.get_text(strip=True) if title_el else None
        images = []
        for img in soup.select("img"):
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
        return jsonify({"title": title, "price": None,
                        "images": images, "shopName": shop_name, "shopId": None})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Démarrage ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Démarrer Tor en arrière-plan
    tor_thread = threading.Thread(target=start_tor, daemon=True)
    tor_thread.start()
    tor_thread.join(timeout=45)  # Attendre max 45s

    port = int(os.environ.get("PORT") or os.environ.get("SCRAPER_PORT") or 5001)
    print(f"✅ Etsy Scraper Service démarré sur port {port} | Tor: {'✅' if _tor_ready else '❌'}")
    app.run(host="0.0.0.0", port=port, debug=False)
