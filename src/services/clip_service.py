#!/usr/bin/env python3
"""
clip_service.py
───────────────
Microservice HTTP (Flask) qui expose un endpoint POST /compare-images.

Il reçoit deux URLs d'images (Etsy + AliExpress) et retourne un score
de similarité cosinus calculé avec CLIP (openai/clip-vit-base-patch32)
depuis HuggingFace Transformers — 100% gratuit, pas d'API key.

Stratégie anti-fond :
  - Preprocessing : découpage centre-crop + segmentation naïve
    (suppression du fond blanc/uniforme via masque de seuillage HSV)
  - Les embeddings CLIP sont invariants au fond dans la plupart des cas
    car CLIP est entraîné à matcher sémantique (objet > fond)
  
Installation :
  pip install flask transformers torch torchvision pillow requests
  
Démarrage :
  python clip_service.py  (port 5001 par défaut)
"""

import io
import os
import sys
import logging
import numpy as np
import requests
from flask import Flask, request, jsonify
from PIL import Image, ImageFilter

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("clip_service")

app = Flask(__name__)

# ──────────────────────────────────────────────
# Chargement du modèle CLIP (une seule fois au démarrage)
# ──────────────────────────────────────────────
try:
    from transformers import CLIPProcessor, CLIPModel
    import torch

    MODEL_NAME = "openai/clip-vit-base-patch32"
    logger.info(f"Chargement du modèle CLIP : {MODEL_NAME} …")
    model     = CLIPModel.from_pretrained(MODEL_NAME)
    processor = CLIPProcessor.from_pretrained(MODEL_NAME)
    model.eval()
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(DEVICE)
    logger.info(f"✅ CLIP chargé sur {DEVICE}")
    CLIP_READY = True

except ImportError as e:
    logger.error(f"❌ Impossible de charger CLIP : {e}")
    logger.error("   Installe : pip install transformers torch torchvision pillow")
    CLIP_READY = False

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.google.com/",
}

def download_image(url: str, timeout: int = 10) -> Image.Image:
    """Télécharge une image depuis une URL et retourne un PIL.Image RGB."""
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content)).convert("RGB")
    return img


def remove_uniform_background(img: Image.Image, threshold: int = 240) -> Image.Image:
    """
    Supprime les fonds très clairs (blancs / crème) courants sur Etsy & AliExpress.
    Retourne l'image avec le fond remplacé par du gris neutre (128,128,128)
    afin que CLIP se concentre sur l'objet central.
    """
    arr = np.array(img).astype(np.int32)
    # Masque : pixels où R, G, B sont tous > threshold (fond clair)
    mask = (arr[:, :, 0] > threshold) & \
           (arr[:, :, 1] > threshold) & \
           (arr[:, :, 2] > threshold)
    
    # Si moins de 10% de fond détecté → ne rien faire (fond coloré ou foncé)
    if mask.sum() / mask.size < 0.10:
        return img
    
    # Remplacer le fond par gris neutre
    result = arr.copy()
    result[mask] = [128, 128, 128]
    return Image.fromarray(result.astype(np.uint8))


def center_crop_square(img: Image.Image) -> Image.Image:
    """Crop carré centré — extrait l'objet principal sans les bandes latérales."""
    w, h   = img.size
    side   = min(w, h)
    left   = (w - side) // 2
    top    = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def preprocess_image(img: Image.Image) -> Image.Image:
    """Pipeline de preprocessing : crop → suppression fond → redimensionnement."""
    img = center_crop_square(img)
    img = remove_uniform_background(img)
    # Légère netteté pour renforcer les contours de l'objet
    img = img.filter(ImageFilter.SHARPEN)
    return img


def get_clip_embedding(img: Image.Image) -> np.ndarray:
    """Retourne l'embedding CLIP normalisé (shape : [512])."""
    import torch
    inputs  = processor(images=img, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        feats = model.get_image_features(**inputs)
    # Normalisation L2 → similarité cosinus = produit scalaire
    feats   = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().numpy()[0]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Similarité cosinus entre deux vecteurs normalisés."""
    return float(np.dot(a, b))


def multi_scale_similarity(img_etsy: Image.Image, img_ali: Image.Image) -> float:
    """
    Calcule la similarité à plusieurs échelles :
      - Image entière preprocessée
      - Crop centre 60% (objet principal)
      - Crop centre 40% (détail)
    
    Score final = moyenne pondérée (50% entier + 30% 60% + 20% 40%)
    Cette approche est robuste aux différences de fond et d'angle.
    """
    scores = []
    weights = []

    # Échelle 1 : image entière preprocessée
    e1 = preprocess_image(img_etsy.copy())
    a1 = preprocess_image(img_ali.copy())
    emb_e1 = get_clip_embedding(e1)
    emb_a1 = get_clip_embedding(a1)
    scores.append(cosine_similarity(emb_e1, emb_a1))
    weights.append(0.50)

    # Échelle 2 : 60% central
    def crop_center_pct(img, pct):
        w, h = img.size
        margin_x = int(w * (1 - pct) / 2)
        margin_y = int(h * (1 - pct) / 2)
        return img.crop((margin_x, margin_y, w - margin_x, h - margin_y))

    e2 = preprocess_image(crop_center_pct(img_etsy, 0.6))
    a2 = preprocess_image(crop_center_pct(img_ali, 0.6))
    emb_e2 = get_clip_embedding(e2)
    emb_a2 = get_clip_embedding(a2)
    scores.append(cosine_similarity(emb_e2, emb_a2))
    weights.append(0.30)

    # Échelle 3 : 40% central
    e3 = preprocess_image(crop_center_pct(img_etsy, 0.4))
    a3 = preprocess_image(crop_center_pct(img_ali, 0.4))
    emb_e3 = get_clip_embedding(e3)
    emb_a3 = get_clip_embedding(a3)
    scores.append(cosine_similarity(emb_e3, emb_a3))
    weights.append(0.20)

    final = sum(s * w for s, w in zip(scores, weights))
    return round(final, 4), scores


# ──────────────────────────────────────────────
# Routes Flask
# ──────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ready" if CLIP_READY else "clip_not_loaded"})


@app.route("/compare-images", methods=["POST"])
def compare_images():
    """
    Body JSON :
      {
        "etsy_url":   "https://i.etsystatic.com/...",
        "ali_url":    "https://ae01.alicdn.com/...",
        "threshold":  0.78   // optionnel, défaut 0.78
      }
    
    Réponse :
      {
        "similarity":  0.8234,
        "match":       true,
        "threshold":   0.78,
        "scales":      [0.85, 0.81, 0.79],
        "error":       null
      }
    """
    if not CLIP_READY:
        return jsonify({"error": "CLIP model not loaded", "match": False}), 503

    data      = request.get_json(force=True)
    etsy_url  = data.get("etsy_url", "").strip()
    ali_url   = data.get("ali_url", "").strip()
    threshold = float(data.get("threshold", 0.78))

    if not etsy_url or not ali_url:
        return jsonify({"error": "etsy_url et ali_url sont requis", "match": False}), 400

    try:
        logger.info(f"⬇ Téléchargement : {etsy_url[:60]}...")
        img_etsy = download_image(etsy_url)

        logger.info(f"⬇ Téléchargement : {ali_url[:60]}...")
        img_ali  = download_image(ali_url)

        logger.info("🔍 Calcul CLIP multi-échelle...")
        similarity, scales = multi_scale_similarity(img_etsy, img_ali)
        match = similarity >= threshold

        logger.info(f"✅ Similarité : {similarity} | Match : {match} | Seuil : {threshold}")
        return jsonify({
            "similarity": similarity,
            "match":      match,
            "threshold":  threshold,
            "scales":     scales,
            "error":      None,
        })

    except requests.exceptions.RequestException as e:
        logger.error(f"❌ Téléchargement échoué : {e}")
        return jsonify({"error": f"Download failed: {str(e)}", "match": False}), 502

    except Exception as e:
        logger.error(f"❌ Erreur CLIP : {e}", exc_info=True)
        return jsonify({"error": str(e), "match": False}), 500


@app.route("/embed", methods=["POST"])
def embed_single():
    """
    Retourne l'embedding CLIP d'une image (utile pour cacher côté serveur).
    Body JSON : { "url": "https://..." }
    """
    if not CLIP_READY:
        return jsonify({"error": "CLIP model not loaded"}), 503

    data = request.get_json(force=True)
    url  = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "url requis"}), 400

    try:
        img = download_image(url)
        img = preprocess_image(img)
        emb = get_clip_embedding(img).tolist()
        return jsonify({"embedding": emb, "dim": len(emb)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("CLIP_PORT", 5001))
    logger.info(f"🚀 CLIP Service démarré sur port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
