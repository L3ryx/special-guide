# Scrapling Microservice

Microservice Python qui remplace l'API officielle Etsy par du scraping via [Scrapling](https://github.com/D4Vinci/Scrapling).

## Installation

```bash
cd scrapling_service
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
scrapling install --force  # installe les dépendances navigateur (Playwright)
```

## Démarrage

```bash
SCRAPLING_PORT=5001 python app.py
```

Ou en production avec Gunicorn :
```bash
gunicorn -w 2 -b 0.0.0.0:5001 app:app
```

## Endpoints

| Méthode | Route | Remplace |
|---------|-------|---------|
| GET | `/health` | — |
| POST | `/search` | `etsyApi.searchListingIds()` |
| POST | `/shop-info` | `etsyApi.getShopNameAndImage()` |
| POST | `/shop-listings` | `etsyApi.getShopListings()` |
| POST | `/listing-detail` | `etsyApi.getListingDetail()` |

## Variables d'environnement

Ajouter dans le `.env` du projet Node.js :
```
SCRAPLING_SERVICE_URL=http://localhost:5001
```

Pour activer la rotation de proxies (optionnel), ajouter dans le `.env` du service Python :
```
SCRAPLING_PROXIES=http://user:pass@proxy1:8080,http://user:pass@proxy2:8080
```

Si `SCRAPLING_PROXIES` est absent ou vide, le service fonctionne sans proxy (comportement par défaut).
Les proxies sont rotés automatiquement à chaque nouvelle session via le `ProxyRotator` de Scrapling.
