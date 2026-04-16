#!/usr/bin/env python3
"""
clip_service.py
───────────────
Microservice HTTP (Flask) pour HuggingFace Spaces.
Expose POST /compare-images pour comparer une image Etsy et AliExpress
avec CLIP (openai/clip-vit-base-patch32) — 100% gratuit.

Stratégie anti-fond (améliorée) :
  - Suppression des fonds clairs ET sombres ET colorés uniformes
  - Multi-échelle avec poids optimisés pour l'objet central
  - Détection flip horizontal (photos miroir fréquentes sur AliExpress)
"""

import io
import os
import logging
import numpy as np
import requests
from flask import Flask, request, jsonify
from PIL import Image, ImageFilter
from scipy.ndimage import uniform_filter

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
    CLIP_READY = False

# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://www.google.com/",
}

def download_image(url: str, timeout: int = 15) -> Image.Image:
    """Télécharge une image depuis une URL et retourne un PIL.Image RGB."""
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    img = Image.open(io.BytesIO(resp.content)).convert("RGB")
    return img


def remove_uniform_background(img: Image.Image, variance_threshold: int = 30) -> Image.Image:
    """
    Supprime les fonds uniformes : blancs, sombres ET colorés.
    Utilise la variance locale pour détecter toute zone uniforme,
    quelle que soit sa couleur (fond studio, dégradé doux, fond noir, etc.)
    """
    arr = np.array(img).astype(np.float32)

    # Fond clair (blanc / crème — très courant sur Etsy)
    mask_light = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)

    # Fond sombre (noir / gris foncé — courant sur AliExpress)
    mask_dark = (arr[:, :, 0] < 15) & (arr[:, :, 1] < 15) & (arr[:, :, 2] < 15)

    # Fond coloré uniforme : faible variance dans un voisinage 5×5
    gray = arr.mean(axis=2)
    local_mean = uniform_filter(gray, size=5)
    local_sq   = uniform_filter(gray ** 2, size=5)
    local_var  = np.clip(local_sq - local_mean ** 2, 0, None)
    mask_uniform = local_var < variance_threshold

    mask = mask_light | mask_dark | mask_uniform

    # Si moins de 10% de fond détecté → ne rien faire (image complexe)
    if mask.sum() / mask.size < 0.10:
        return img

    result = arr.copy()
    result[mask] = [128, 128, 128]  # gris neutre = fond standardisé
    return Image.fromarray(result.astype(np.uint8))


def center_crop_square(img: Image.Image) -> Image.Image:
    """Crop carré centré."""
    w, h  = img.size
    side  = min(w, h)
    left  = (w - side) // 2
    top   = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def crop_center_pct(img: Image.Image, pct: float) -> Image.Image:
    """Crop le centre d'une image selon un pourcentage."""
    w, h = img.size
    mx   = int(w * (1 - pct) / 2)
    my   = int(h * (1 - pct) / 2)
    return img.crop((mx, my, w - mx, h - my))


def preprocess_image(img: Image.Image) -> Image.Image:
    """Pipeline : crop carré → suppression fond améliorée → netteté."""
    img = center_crop_square(img)
    img = remove_uniform_background(img)
    img = img.filter(ImageFilter.SHARPEN)
    return img


def get_clip_embedding(img: Image.Image) -> np.ndarray:
    """Retourne l'embedding CLIP normalisé (shape : [512])."""
    import torch
    inputs = processor(images=img, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        feats = model.get_image_features(**inputs)
    feats = feats / feats.norm(dim=-1, keepdim=True)
    return feats.cpu().numpy()[0]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def multi_scale_similarity(img_etsy: Image.Image, img_ali: Image.Image):
    """
    Calcule la similarité à plusieurs échelles + détection flip miroir :
      - Image entière preprocessée        (40%)
      - Crop centre 60% (objet principal) (35%)
      - Crop centre 40% (détail fin)      (25%)
      + Bonus flip horizontal si AliExpress a mirroir l'image

    Les poids favorisent l'objet central (60% + 40%) pour ignorer le fond.
    """
    scales_config = [
        (None, 0.40),  # image entière
        (0.60, 0.35),  # centre 60%
        (0.40, 0.25),  # centre 40%
    ]
    scores  = []
    weights = []

    for pct, w in scales_config:
        if pct is None:
            e = preprocess_image(img_etsy.copy())
            a = preprocess_image(img_ali.copy())
        else:
            e = preprocess_image(crop_center_pct(img_etsy.copy(), pct))
            a = preprocess_image(crop_center_pct(img_ali.copy(), pct))

        emb_e = get_clip_embedding(e)
        emb_a = get_clip_embedding(a)
        scores.append(cosine_similarity(emb_e, emb_a))
        weights.append(w)

    # ── Détection flip horizontal ──
    # Certains vendeurs AliExpress retournent les photos en miroir
    e_flip = preprocess_image(img_etsy.copy().transpose(Image.FLIP_LEFT_RIGHT))
    a_norm = preprocess_image(img_ali.copy())
    flip_score = cosine_similarity(get_clip_embedding(e_flip), get_clip_embedding(a_norm))

    if flip_score > scores[0]:
        logger.info(f"🪞 Flip détecté : {flip_score:.4f} > {scores[0]:.4f} — intégration du score miroir")
        scores.append(flip_score)
        # Redistribue 10% vers le flip si pertinent
        weights = [0.35, 0.30, 0.20, 0.15]

    final = sum(s * w for s, w in zip(scores, weights))
    return round(final, 4), scores


# ──────────────────────────────────────────────
# Routes Flask
# ──────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ready" if CLIP_READY else "clip_not_loaded"})


@app.route("/", methods=["GET"])
def root():
    return jsonify({"service": "CLIP Image Comparator", "status": "ready" if CLIP_READY else "loading"})


@app.route("/compare-images", methods=["POST"])
def compare_images():
    """
    Body JSON :
      {
        "etsy_url":   "https://i.etsystatic.com/...",
        "ali_url":    "https://ae01.alicdn.com/...",
        "threshold":  0.78
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
        logger.info(f"⬇ Téléchargement Etsy : {etsy_url[:60]}...")
        img_etsy = download_image(etsy_url)

        logger.info(f"⬇ Téléchargement Ali : {ali_url[:60]}...")
        img_ali  = download_image(ali_url)

        logger.info("🔍 Calcul CLIP multi-échelle...")
        similarity, scales = multi_scale_similarity(img_etsy, img_ali)
        match = similarity >= threshold

        logger.info(f"✅ Similarité : {similarity} | Match : {match}")
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
    """Retourne l'embedding CLIP d'une image. Body JSON : { "url": "https://..." }"""
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
    port = int(os.environ.get("PORT", 7860))  # HuggingFace Spaces utilise 7860
    logger.info(f"🚀 CLIP Service démarré sur port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
