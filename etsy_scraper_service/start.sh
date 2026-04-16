#!/bin/bash
# Démarrage du microservice Etsy Scraper (botasaurus)
set -e

SCRAPER_PORT=${SCRAPER_PORT:-5001}

echo "📦 Installation des dépendances Python..."
pip install -r requirements.txt -q

echo "🚀 Démarrage du scraper botasaurus sur port $SCRAPER_PORT..."
python etsy_scraper.py
