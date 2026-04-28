"""
scraper_service.py
Microservice Flask qui expose le spider Scrapy via HTTP.
Appelé par Node.js sur http://localhost:5001/scrape-etsy
"""

import os
import uuid
import json
import subprocess
import logging

from flask import Flask, jsonify, request
from flask_cors import CORS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

SPIDER_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "etsy_spider.py")
TIMEOUT_SEC = 300  # 5 minutes max par recherche


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "service": "etsy-scraper"})


@app.route("/scrape-etsy", methods=["POST"])
def scrape_etsy():
    data = request.get_json(silent=True) or {}
    keyword = str(data.get("keyword", "")).strip()
    max_pages = int(data.get("max_pages", 5))

    if not keyword:
        return jsonify({"ok": False, "error": "keyword manquant", "listings": []}), 400

    result_file = f"/tmp/etsy_{uuid.uuid4().hex}.json"

    env = os.environ.copy()

    cmd = [
        "scrapy",
        "runspider",
        SPIDER_FILE,
        "-a", f"keyword={keyword}",
        "-a", f"result_file={result_file}",
        "-a", f"max_pages={max_pages}",
        "-s", "LOG_LEVEL=WARNING",
    ]

    logger.info(f"[scraper_service] Lancement spider — keyword='{keyword}' pages={max_pages}")

    try:
        proc = subprocess.run(
            cmd,
            timeout=TIMEOUT_SEC,
            capture_output=True,
            env=env,
        )

        if proc.returncode != 0:
            err = proc.stderr.decode("utf-8", errors="replace")[-2000:]
            logger.error(f"[scraper_service] Spider erreur: {err}")

        if os.path.exists(result_file):
            with open(result_file, "r", encoding="utf-8") as f:
                listings = json.load(f)
            os.remove(result_file)
            logger.info(f"[scraper_service] {len(listings)} boutiques trouvées")
            return jsonify({"ok": True, "listings": listings})

        return jsonify({
            "ok": False,
            "listings": [],
            "error": "Le spider n'a produit aucun résultat",
        })

    except subprocess.TimeoutExpired:
        logger.error("[scraper_service] Timeout dépassé (5 min)")
        if os.path.exists(result_file):
            os.remove(result_file)
        return jsonify({"ok": False, "listings": [], "error": "Timeout (5 min)"}), 504

    except Exception as e:
        logger.exception("[scraper_service] Erreur inattendue")
        return jsonify({"ok": False, "listings": [], "error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("SCRAPER_PORT", 5001))
    logger.info(f"[scraper_service] Démarrage sur le port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
