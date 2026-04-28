"""
etsy_spider.py
Spider Scrapy pour scraper Etsy :
  - 5 pages de résultats de recherche
  - Première image de chaque annonce
  - Deuxième image depuis la boutique
  - Nom et avatar de chaque boutique
  - Toutes les fonctionnalités anti-détection intégrées
"""

import scrapy
import random
import json
import re
import time
import requests
import logging

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
#  ROTATION USER-AGENTS
# ─────────────────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
]

# ─────────────────────────────────────────────
#  ROTATION ACCEPT-LANGUAGE
# ─────────────────────────────────────────────
ACCEPT_LANGUAGES = [
    "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
    "en-US,en;q=0.9,fr;q=0.8",
    "en-GB,en;q=0.9,fr-FR;q=0.8,fr;q=0.7",
    "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
    "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
]

# ─────────────────────────────────────────────
#  ROTATION REFERERS
# ─────────────────────────────────────────────
REFERERS = [
    "https://www.google.com/",
    "https://www.google.fr/",
    "https://www.bing.com/",
    "https://duckduckgo.com/",
    "https://www.google.co.uk/",
    "https://search.yahoo.com/",
    "https://www.ecosia.org/",
]


# ─────────────────────────────────────────────
#  MIDDLEWARE : ROTATION HEADERS COMPLETS
# ─────────────────────────────────────────────
class RandomHeadersMiddleware:
    def process_request(self, request, spider):
        ua = random.choice(USER_AGENTS)
        request.headers["User-Agent"] = ua
        request.headers["Accept-Language"] = random.choice(ACCEPT_LANGUAGES)
        request.headers["Accept"] = (
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
        )
        request.headers["Accept-Encoding"] = "gzip, deflate, br"
        request.headers["Upgrade-Insecure-Requests"] = "1"

        if random.random() > 0.4:
            request.headers["DNT"] = "1"

        if "Chrome" in ua and "Edg" not in ua:
            request.headers["sec-ch-ua"] = (
                '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'
            )
            request.headers["sec-ch-ua-mobile"] = "?0"
            request.headers["sec-ch-ua-platform"] = random.choice(
                ['"Windows"', '"macOS"', '"Linux"']
            )
            request.headers["Sec-Fetch-Dest"] = "document"
            request.headers["Sec-Fetch-Mode"] = "navigate"
            request.headers["Sec-Fetch-Site"] = random.choice(
                ["none", "same-origin", "cross-site"]
            )
            request.headers["Sec-Fetch-User"] = "?1"


# ─────────────────────────────────────────────
#  MIDDLEWARE : ROTATION REFERER
# ─────────────────────────────────────────────
class RandomRefererMiddleware:
    def process_request(self, request, spider):
        existing = request.headers.get("Referer")
        if not existing:
            ref = random.choice(REFERERS + [None])
            if ref:
                request.headers["Referer"] = ref


# ─────────────────────────────────────────────
#  MIDDLEWARE : ROTATION PROXY (ProxyScrape)
# ─────────────────────────────────────────────
class ProxyScrapeMiddleware:
    def __init__(self, protocol, anonymity, country, timeout, api_key=""):
        self.protocol = protocol
        self.anonymity = anonymity
        self.country = country
        self.timeout = timeout
        self.api_key = api_key
        self.proxies = []
        self.index = 0
        self._load_proxies()

    @classmethod
    def from_crawler(cls, crawler):
        import os
        return cls(
            protocol=crawler.settings.get("PROXYSCRAPE_PROTOCOL", "http"),
            anonymity=crawler.settings.get("PROXYSCRAPE_ANONYMITY", "elite"),
            country=crawler.settings.get("PROXYSCRAPE_COUNTRY", "all"),
            timeout=crawler.settings.get("PROXYSCRAPE_TIMEOUT", 10000),
            api_key=os.environ.get("PROXYSCRAPE_API_KEY", ""),
        )

    def _build_url(self):
        if self.api_key:
            return (
                f"https://api.proxyscrape.com/v3/free-proxy-list/get"
                f"?request=displayproxies&protocol={self.protocol}"
                f"&anonymity={self.anonymity}&country={self.country}"
                f"&timeout={self.timeout}&apikey={self.api_key}"
            )
        return (
            f"https://api.proxyscrape.com/v2/?request=displayproxies"
            f"&protocol={self.protocol}&anonymity={self.anonymity}"
            f"&country={self.country}&timeout={self.timeout}"
        )

    def _load_proxies(self):
        try:
            resp = requests.get(self._build_url(), timeout=15)
            if resp.status_code == 200:
                lines = [l.strip() for l in resp.text.splitlines() if ":" in l.strip()]
                self.proxies = [f"{self.protocol}://{l}" for l in lines]
                random.shuffle(self.proxies)
                logger.info(f"[ProxyScrapeMiddleware] {len(self.proxies)} proxies chargés")
        except Exception as e:
            logger.warning(f"[ProxyScrapeMiddleware] Erreur chargement proxies: {e}")

    def _next_proxy(self):
        if not self.proxies:
            return None
        proxy = self.proxies[self.index % len(self.proxies)]
        self.index += 1
        if self.index >= len(self.proxies):
            random.shuffle(self.proxies)
            self.index = 0
        return proxy

    def process_request(self, request, spider):
        proxy = self._next_proxy()
        if proxy:
            request.meta["proxy"] = proxy

    def process_exception(self, request, exception, spider):
        bad = request.meta.get("proxy")
        if bad and bad in self.proxies:
            self.proxies.remove(bad)
            logger.warning(f"[ProxyScrapeMiddleware] Proxy retiré: {bad}")
        new_proxy = self._next_proxy()
        if new_proxy:
            request.meta["proxy"] = new_proxy
        return request


# ─────────────────────────────────────────────
#  SPIDER PRINCIPAL
# ─────────────────────────────────────────────
class EtsySpider(scrapy.Spider):
    name = "etsy"

    custom_settings = {
        # 🧱 Faible concurrency
        "CONCURRENT_REQUESTS": 1,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 1,
        "CONCURRENT_REQUESTS_PER_IP": 1,
        # ⏱️ Délais aléatoires réalistes
        "DOWNLOAD_DELAY": 3,
        "RANDOMIZE_DOWNLOAD_DELAY": True,
        "AUTOTHROTTLE_ENABLED": True,
        "AUTOTHROTTLE_START_DELAY": 2,
        "AUTOTHROTTLE_MAX_DELAY": 12,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 1.0,
        # Retry
        "RETRY_ENABLED": True,
        "RETRY_TIMES": 4,
        "RETRY_HTTP_CODES": [429, 403, 500, 502, 503, 408],
        # Cookies (simule un vrai navigateur)
        "COOKIES_ENABLED": True,
        # 🎭 Middlewares anti-détection
        "DOWNLOADER_MIDDLEWARES": {
            "etsy_spider.RandomHeadersMiddleware": 400,
            "etsy_spider.RandomRefererMiddleware": 410,
            "etsy_spider.ProxyScrapeMiddleware": 750,
            "scrapy.downloadermiddlewares.useragent.UserAgentMiddleware": None,
        },
        "ROBOTSTXT_OBEY": False,
        "LOG_LEVEL": "WARNING",
        "TELNETCONSOLE_ENABLED": False,
    }

    def __init__(self, keyword="", result_file="/tmp/etsy_results.json", max_pages=5, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.keyword = keyword
        self.result_file = result_file
        self.max_pages = int(max_pages)
        # shop_name → entry dict
        self.results = {}
        self.pages_done = 0

    # ── Construit les headers principaux ──
    def _headers(self, referer=None):
        ua = random.choice(USER_AGENTS)
        h = {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": random.choice(ACCEPT_LANGUAGES),
            "Accept-Encoding": "gzip, deflate, br",
            "Upgrade-Insecure-Requests": "1",
            "Referer": referer or random.choice(REFERERS),
        }
        if random.random() > 0.4:
            h["DNT"] = "1"
        return h

    # ─────────────────────────────────────
    #  DÉMARRAGE : 5 pages de recherche
    # ─────────────────────────────────────
    def start_requests(self):
        for page in range(1, self.max_pages + 1):
            url = (
                f"https://www.etsy.com/search?q={self.keyword}"
                f"&page={page}&ref=pagination"
            )
            # 🧠 Délai non-linéaire entre pages
            delay = random.uniform(2.0, 6.0) * (1 + 0.3 * random.random())
            yield scrapy.Request(
                url,
                callback=self.parse_search,
                headers=self._headers(referer="https://www.google.com/"),
                meta={"page": page, "download_latency": delay},
                priority=-page,
            )

    # ─────────────────────────────────────
    #  PARSE PAGE DE RÉSULTATS DE RECHERCHE
    # ─────────────────────────────────────
    def parse_search(self, response):
        page = response.meta.get("page", "?")
        logger.info(f"[EtsySpider] parse_search page={page} url={response.url}")

        listings_data = []

        # ── Méthode 1 : extraction JSON depuis les scripts (plus fiable) ──
        for script_text in response.css("script::text").getall():
            if '"listings"' in script_text or '"listing_id"' in script_text:
                extracted = self._extract_from_json_blob(script_text)
                if extracted:
                    listings_data.extend(extracted)
                    break

        # ── Méthode 2 : CSS selectors (fallback) ──
        if not listings_data:
            listings_data = self._extract_from_css(response)

        logger.info(f"[EtsySpider] page={page} → {len(listings_data)} annonces extraites")

        for item in listings_data:
            shop_name = item.get("shop_name")
            if not shop_name or shop_name in self.results:
                continue

            self.results[shop_name] = {
                "listing_id": item.get("listing_id"),
                "title": item.get("title"),
                "image1": item.get("image"),
                "image2": None,
                "shop_name": shop_name,
                "shop_url": f"https://www.etsy.com/shop/{shop_name}",
                "shop_avatar": None,
                "listing_url": item.get("link"),
                "source": "etsy",
            }

            # Visite la page boutique pour avatar + 2ème image
            shop_url = f"https://www.etsy.com/shop/{shop_name}"
            yield scrapy.Request(
                shop_url,
                callback=self.parse_shop,
                headers=self._headers(referer=response.url),
                meta={"shop_name": shop_name},
            )

    # ─────────────────────────────────────
    #  EXTRACTION JSON depuis les scripts
    # ─────────────────────────────────────
    def _extract_from_json_blob(self, text):
        results = []
        try:
            # Cherche les blocs JSON dans le texte du script
            # Etsy embeds data in window.__NUXT__ or window.__INITIAL_STATE__ or similar
            for pattern in [
                r'"listing_id"\s*:\s*(\d+)',
                r'"listingId"\s*:\s*"?(\d+)"?',
            ]:
                ids = re.findall(pattern, text)
                if ids:
                    break

            # Cherche shop_name associé
            shop_names = re.findall(r'"shop_name"\s*:\s*"([^"]+)"', text)
            if not shop_names:
                shop_names = re.findall(r'"shopName"\s*:\s*"([^"]+)"', text)

            # Cherche images
            images = re.findall(
                r'"url"\s*:\s*"(https://[^"]+(?:jpg|jpeg|png|webp)[^"]*)"', text
            )
            if not images:
                images = re.findall(
                    r'"src"\s*:\s*"(https://i\.etsystatic\.com[^"]+)"', text
                )

            # Cherche titres
            titles = re.findall(r'"title"\s*:\s*"([^"]{5,120})"', text)
            if not titles:
                titles = re.findall(r'"listing_title"\s*:\s*"([^"]{5,120})"', text)

            count = min(len(ids), len(shop_names))
            for i in range(count):
                img = images[i] if i < len(images) else None
                title = titles[i] if i < len(titles) else None
                shop = shop_names[i]
                lid = ids[i]
                if img and "il_" in img:
                    img = re.sub(r"il_\d+x\d+", "il_794xN", img)
                results.append(
                    {
                        "listing_id": lid,
                        "title": title,
                        "image": img,
                        "shop_name": shop,
                        "link": f"https://www.etsy.com/listing/{lid}",
                    }
                )
        except Exception as e:
            logger.debug(f"[_extract_from_json_blob] {e}")
        return results

    # ─────────────────────────────────────
    #  EXTRACTION CSS (fallback)
    # ─────────────────────────────────────
    def _extract_from_css(self, response):
        results = []

        # Sélecteurs CSS Etsy (plusieurs variantes pour robustesse)
        listing_selectors = [
            "li[data-listing-id]",
            "div[data-listing-id]",
            "[data-listing-id]",
        ]

        listings = []
        for sel in listing_selectors:
            listings = response.css(sel)
            if listings:
                break

        for listing in listings:
            listing_id = listing.attrib.get("data-listing-id")
            if not listing_id:
                continue

            # Image
            image = (
                listing.css("img::attr(src)").get()
                or listing.css("img::attr(data-src)").get()
                or listing.css("img::attr(data-srcset)").get()
            )
            if image and "," in image:
                image = image.split(",")[0].split(" ")[0]

            # Shop name depuis attribut ou lien
            shop_name = listing.attrib.get("data-shop-name")
            if not shop_name:
                shop_link = listing.css('a[href*="/shop/"]::attr(href)').get()
                if shop_link:
                    m = re.search(r"/shop/([^/?#]+)", shop_link)
                    if m:
                        shop_name = m.group(1)

            # Titre
            title = (
                listing.css("h3::text").get()
                or listing.css("h2::text").get()
                or listing.css("[data-listing-title]::text").get()
                or listing.css(".v2-listing-card__info p::text").get()
            )

            # Lien listing
            link = listing.css("a::attr(href)").get()
            if link and link.startswith("/"):
                link = "https://www.etsy.com" + link

            if shop_name and image:
                results.append(
                    {
                        "listing_id": listing_id,
                        "title": title,
                        "image": image,
                        "shop_name": shop_name,
                        "link": link,
                    }
                )
        return results

    # ─────────────────────────────────────
    #  PARSE PAGE BOUTIQUE (avatar + image2)
    # ─────────────────────────────────────
    def parse_shop(self, response):
        shop_name = response.meta.get("shop_name")
        if not shop_name or shop_name not in self.results:
            return

        # ── Avatar de la boutique ──
        avatar = (
            response.css("img.shop-icon-indicator::attr(src)").get()
            or response.css("[data-shop-icon] img::attr(src)").get()
            or response.css(".shop-icon img::attr(src)").get()
            or response.css("img[class*='shop-icon']::attr(src)").get()
            or response.css("img[class*='shopIcon']::attr(src)").get()
            or response.css(".wt-flex-shrink-0 img::attr(src)").get()
            # Fallback JSON
            or self._find_avatar_in_scripts(response)
        )

        # ── Deuxième image de listing (différente de image1) ──
        image1 = self.results[shop_name]["image1"]
        image2 = None

        # Cherche dans les listings de la boutique
        for sel in ["li[data-listing-id]", "div[data-listing-id]", "[data-listing-id]"]:
            for listing in response.css(sel):
                img = (
                    listing.css("img::attr(src)").get()
                    or listing.css("img::attr(data-src)").get()
                )
                if img and img != image1:
                    image2 = img
                    break
            if image2:
                break

        # Fallback : cherche images dans les scripts
        if not image2:
            image2 = self._find_second_image_in_scripts(response, image1)

        # Met à jour le résultat
        self.results[shop_name]["shop_avatar"] = avatar
        self.results[shop_name]["image2"] = image2

        logger.info(
            f"[EtsySpider] shop={shop_name} avatar={'✓' if avatar else '✗'} image2={'✓' if image2 else '✗'}"
        )

    def _find_avatar_in_scripts(self, response):
        for text in response.css("script::text").getall():
            if "shop_icon" in text or "shopIcon" in text or "avatar" in text.lower():
                matches = re.findall(
                    r'"(?:shop_icon_url|avatarUrl|shop_icon)"\s*:\s*"(https://[^"]+)"',
                    text,
                )
                if matches:
                    return matches[0]
                # Cherche images etsystatic qui ressemblent à des avatars
                matches = re.findall(
                    r'"(https://i\.etsystatic\.com[^"]+(?:il_|avatar)[^"]+)"', text
                )
                if matches:
                    return matches[0]
        return None

    def _find_second_image_in_scripts(self, response, image1):
        for text in response.css("script::text").getall():
            if "etsystatic" in text:
                all_imgs = re.findall(
                    r'"(https://i\.etsystatic\.com[^"]+(?:jpg|jpeg|png|webp)[^"]*)"',
                    text,
                )
                for img in all_imgs:
                    if img != image1:
                        return img
        return None

    # ─────────────────────────────────────
    #  FIN DU SPIDER → écriture JSON
    # ─────────────────────────────────────
    def closed(self, reason):
        output = list(self.results.values())
        # Filtre : garde seulement les boutiques avec au moins image1
        output = [r for r in output if r.get("image1")]
        try:
            with open(self.result_file, "w", encoding="utf-8") as f:
                json.dump(output, f, ensure_ascii=False)
            logger.info(
                f"[EtsySpider] Résultats écrits : {len(output)} boutiques → {self.result_file}"
            )
        except Exception as e:
            logger.error(f"[EtsySpider] Erreur écriture résultats: {e}")
