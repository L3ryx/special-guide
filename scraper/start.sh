#!/bin/bash
# Démarre le microservice Python Scrapy
# Usage : bash scraper/start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Installe les dépendances si besoin
if ! python3 -c "import scrapy" 2>/dev/null; then
  echo "[start.sh] Installation des dépendances Python..."
  pip3 install -r requirements.txt
fi

PORT="${SCRAPER_PORT:-5001}"
echo "[start.sh] Démarrage du scraper sur le port $PORT"
python3 scraper_service.py
