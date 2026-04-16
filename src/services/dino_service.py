#!/usr/bin/env python3
"""
dino_service.py
───────────────
Microservice HTTP (Flask) pour HuggingFace Spaces.
Remplace clip_service.py — utilise DINOv2 (facebook/dinov2-base) au lieu de CLIP.

DINOv2 avantages vs CLIP :
  - Embeddings purement visuels (pas text-image) → meilleure comparaison objet-à-objet
  - Plus robuste aux changements de fond / éclairage
  - Meilleure précision sur les textures et formes fines (idéal dropship detection)
  - facebook/dinov2-base : 768 dims, rapide sur CPU

Routes exposées (même interface que clip_service.py) :
  GET  /health
  GET  /
  POST /compare-images   → { similarity, match, threshold, scales, error }
  POST /compare-hybrid   → { similarity, clip_score, structure_score, match, scales, error }
  POST /embed            → { embedding, dim }
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
logger = logging.getLogger("dino_service")

app = Flask(__name__)

# ──────────────────────────────────────────────
# Chargement du modèle DINOv2 (une seule fois au démarrage)
# ──────────────────────────────────────────────
try:
    from transformers import AutoImageProcessor, AutoModel
    import torch

    # dinov2-base : 768 dims, bon équilibre vitesse/précision sur CPU gratuit HF
    # dinov2-large si plus de mémoire disponible (+10% précision, 2× plus lent)
    MODEL_NAME = os.environ.get("DINO_MODEL", "facebook/dinov2-base")
    logger.info(f"Chargement du modèle DINOv2 : {MODEL_NAME} …")

    try:
        processor = AutoImageProcessor.from_pretrained(MODEL_NAME)
        model     = AutoModel.from_pretrained(MODEL_NAME)
    except Exception as mem_err:
        logger.warning(f"⚠️ {MODEL_NAME} échoué ({mem_err}) — fallback sur dinov2-small")
        MODEL_NAME = "facebook/dinov2-small"
        processor  = AutoImageProcessor.from_pretrained(MODEL_NAME)
        model      = AutoModel.from_pretrained(MODEL_NAME)

    model.eval()
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(DEVICE)
    logger.info(f"✅ DINOv2 chargé sur {DEVICE} ({MODEL_NAME})")
    DINO_READY = True

except ImportError as e:
    logger.error(f"❌ Impossible de charger DINOv2 : {e}")
    DINO_READY = False

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
    Utilise la variance locale pour détecter toute zone uniforme.
    """
    arr = np.array(img).astype(np.float32)

    mask_light   = (arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)
    mask_dark    = (arr[:, :, 0] < 15)  & (arr[:, :, 1] < 15)  & (arr[:, :, 2] < 15)

    gray         = arr.mean(axis=2)
    local_mean   = uniform_filter(gray, size=5)
    local_sq     = uniform_filter(gray ** 2, size=5)
    local_var    = np.clip(local_sq - local_mean ** 2, 0, None)
    mask_uniform = local_var < variance_threshold

    mask = mask_light | mask_dark | mask_uniform

    if mask.sum() / mask.size < 0.10:
        return img

    result = arr.copy()
    result[mask] = [128, 128, 128]
    return Image.fromarray(result.astype(np.uint8))


def smart_object_crop(img: Image.Image) -> Image.Image:
    """
    Détecte la bounding box de l'objet principal (pixels non-fond)
    et crop dessus avec un padding de 5%.
    """
    arr  = np.array(img)
    mask = ~(
        ((arr[:, :, 0] > 240) & (arr[:, :, 1] > 240) & (arr[:, :, 2] > 240)) |
        ((arr[:, :, 0] < 15)  & (arr[:, :, 1] < 15)  & (arr[:, :, 2] < 15))
    )
    rows = np.any(mask, axis=1)
    cols = np.any(mask, axis=0)
    if not rows.any() or not cols.any():
        return img
    rmin, rmax = np.where(rows)[0][[0, -1]]
    cmin, cmax = np.where(cols)[0][[0, -1]]
    pad_r = int((rmax - rmin) * 0.05)
    pad_c = int((cmax - cmin) * 0.05)
    return img.crop((
        max(0, cmin - pad_c),
        max(0, rmin - pad_r),
        min(img.width,  cmax + pad_c),
        min(img.height, rmax + pad_r),
    ))


def remove_background_alpha(img: Image.Image) -> Image.Image:
    """
    Supprime le fond via rembg (silhouette précise).
    Fallback sur remove_uniform_background si rembg absent.
    """
    try:
        from rembg import remove as rembg_remove
        img_rgba   = rembg_remove(img)
        background = Image.new("RGB", img_rgba.size, (255, 255, 255))
        background.paste(img_rgba, mask=img_rgba.split()[3])
        logger.debug("✅ rembg utilisé pour la suppression de fond")
        return background
    except ImportError:
        logger.debug("rembg absent — fallback sur remove_uniform_background")
        return remove_uniform_background(img)


def center_crop_square(img: Image.Image) -> Image.Image:
    """Crop carré centré."""
    w, h = img.size
    side = min(w, h)
    left = (w - side) // 2
    top  = (h - side) // 2
    return img.crop((left, top, left + side, top + side))


def crop_center_pct(img: Image.Image, pct: float) -> Image.Image:
    """Crop le centre d'une image selon un pourcentage."""
    w, h = img.size
    mx   = int(w * (1 - pct) / 2)
    my   = int(h * (1 - pct) / 2)
    return img.crop((mx, my, w - mx, h - my))


def preprocess_image(img: Image.Image) -> Image.Image:
    """
    Pipeline de prétraitement :
      1. smart_object_crop  → crop sur l'objet
      2. center_crop_square → normalise en carré
      3. remove_background_alpha → suppression fond (rembg ou variance)
      4. SHARPEN             → accentue les contours pour DINOv2
    """
    img = smart_object_crop(img)
    img = center_crop_square(img)
    img = remove_background_alpha(img)
    img = img.filter(ImageFilter.SHARPEN)
    return img


def get_dino_embedding(img: Image.Image) -> np.ndarray:
    """
    Retourne l'embedding DINOv2 normalisé (CLS token, shape : [768] pour dinov2-base).
    DINOv2 utilise AutoImageProcessor (pas CLIPProcessor).
    """
    import torch
    inputs = processor(images=img, return_tensors="pt").to(DEVICE)
    with torch.no_grad():
        outputs = model(**inputs)
    # CLS token = représentation globale de l'image
    cls_embedding = outputs.last_hidden_state[:, 0, :]
    # Normalisation L2 pour similarité cosinus
    cls_embedding = cls_embedding / cls_embedding.norm(dim=-1, keepdim=True)
    return cls_embedding.cpu().numpy()[0]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def multi_scale_similarity(img_a: Image.Image, img_b: Image.Image):
    """
    Calcule la similarité DINOv2 à plusieurs échelles + détection flip miroir.

    Poids (favorise objet central) :
      - Image entière          (20%) : contexte global
      - Crop centre 80%        (25%) : objet + environnement proche
      - Crop centre 60%        (30%) ← poids dominant
      - Crop centre 40%        (25%) : textures, motifs, logos
      + Bonus flip horizontal si image miroir détectée
    """
    scales_config = [
        (None, 0.20),
        (0.80, 0.25),
        (0.60, 0.30),
        (0.40, 0.25),
    ]
    scores  = []
    weights = []

    for pct, w in scales_config:
        if pct is None:
            e = preprocess_image(img_a.copy())
            a = preprocess_image(img_b.copy())
        else:
            e = preprocess_image(crop_center_pct(img_a.copy(), pct))
            a = preprocess_image(crop_center_pct(img_b.copy(), pct))

        emb_e = get_dino_embedding(e)
        emb_a = get_dino_embedding(a)
        scores.append(cosine_similarity(emb_e, emb_a))
        weights.append(w)

    # ── Détection flip horizontal ──
    a_flip = preprocess_image(img_a.copy().transpose(Image.FLIP_LEFT_RIGHT))
    b_norm = preprocess_image(img_b.copy())
    flip_score = cosine_similarity(get_dino_embedding(a_flip), get_dino_embedding(b_norm))

    if flip_score > scores[0]:
        logger.info(f"🪞 Flip détecté : {flip_score:.4f} > {scores[0]:.4f} — intégration score miroir")
        scores.append(flip_score)
        weights = [0.15, 0.22, 0.28, 0.22, 0.13]

    final = sum(s * w for s, w in zip(scores, weights))
    return round(final, 4), scores


# ──────────────────────────────────────────────
# Routes Flask (interface identique à clip_service.py)
# ──────────────────────────────────────────────

@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ready" if DINO_READY else "dino_not_loaded"})


@app.route("/", methods=["GET"])
def root():
    return jsonify({
        "service": "DINOv2 Image Comparator",
        "model":   MODEL_NAME if DINO_READY else "not loaded",
        "status":  "ready" if DINO_READY else "loading",
    })


@app.route("/compare-images", methods=["POST"])
def compare_images():
    """
    Body JSON :
      { "etsy_url": "...", "ali_url": "...", "threshold": 0.78 }

    Réponse :
      { "similarity": 0.82, "match": true, "threshold": 0.78, "scales": [...], "error": null }
    """
    if not DINO_READY:
        return jsonify({"error": "DINOv2 model not loaded", "match": False}), 503

    data      = request.get_json(force=True)
    etsy_url  = data.get("etsy_url", "").strip()
    ali_url   = data.get("ali_url",  "").strip()
    threshold = float(data.get("threshold", 0.78))

    if not etsy_url or not ali_url:
        return jsonify({"error": "etsy_url et ali_url sont requis", "match": False}), 400

    try:
        logger.info(f"⬇ Téléchargement Etsy : {etsy_url[:60]}...")
        img_etsy = download_image(etsy_url)

        logger.info(f"⬇ Téléchargement Ali  : {ali_url[:60]}...")
        img_ali  = download_image(ali_url)

        logger.info("🔍 Calcul DINOv2 multi-échelle...")
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
        logger.error(f"❌ Erreur DINOv2 : {e}", exc_info=True)
        return jsonify({"error": str(e), "match": False}), 500


@app.route("/compare-hybrid", methods=["POST"])
def compare_hybrid():
    """
    Score hybride = 0.75 × DINOv2_score + 0.25 × structure_score.
    Structure = ratio d'aspect (50%) + distance couleur (50%).

    Interface identique à /compare-hybrid de clip_service.py.
    """
    if not DINO_READY:
        return jsonify({"error": "DINOv2 model not loaded", "match": False}), 503

    data      = request.get_json(force=True)
    etsy_url  = data.get("etsy_url", "").strip()
    ali_url   = data.get("ali_url",  "").strip()
    threshold = float(data.get("threshold", 0.78))

    if not etsy_url or not ali_url:
        return jsonify({"error": "etsy_url et ali_url sont requis", "match": False}), 400

    try:
        img_etsy = download_image(etsy_url)
        img_ali  = download_image(ali_url)

        # ── Score DINOv2 ──
        dino_score, scales = multi_scale_similarity(img_etsy, img_ali)

        # ── Score structurel ──
        ratio_e     = img_etsy.width / img_etsy.height
        ratio_a     = img_ali.width  / img_ali.height
        ratio_score = max(0.0, 1.0 - abs(ratio_e - ratio_a) / 2.0)

        thumb_e     = np.array(img_etsy.resize((64, 64))).astype(np.float32).mean(axis=(0, 1))
        thumb_a     = np.array(img_ali.resize((64, 64))).astype(np.float32).mean(axis=(0, 1))
        color_score = max(0.0, 1.0 - np.linalg.norm(thumb_e - thumb_a) / (255.0 * np.sqrt(3)))

        structure_score = round(0.5 * ratio_score + 0.5 * color_score, 4)

        # ── Score final ──
        final = round(0.75 * dino_score + 0.25 * structure_score, 4)
        match = final >= threshold

        logger.info(f"✅ Hybrid — DINOv2:{dino_score} struct:{structure_score} final:{final} match:{match}")
        return jsonify({
            "similarity":      final,
            "clip_score":      dino_score,       # clé conservée pour compatibilité avec clipCompare.js
            "structure_score": structure_score,
            "match":           match,
            "threshold":       threshold,
            "scales":          scales,
            "error":           None,
        })

    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Download failed: {str(e)}", "match": False}), 502
    except Exception as e:
        logger.error(f"❌ Erreur compare-hybrid : {e}", exc_info=True)
        return jsonify({"error": str(e), "match": False}), 500


@app.route("/embed", methods=["POST"])
def embed_single():
    """Retourne l'embedding DINOv2 d'une image. Body JSON : { "url": "https://..." }"""
    if not DINO_READY:
        return jsonify({"error": "DINOv2 model not loaded"}), 503

    data = request.get_json(force=True)
    url  = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "url requis"}), 400

    try:
        img = download_image(url)
        img = preprocess_image(img)
        emb = get_dino_embedding(img).tolist()
        return jsonify({"embedding": emb, "dim": len(emb)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 7860))   # HuggingFace Spaces utilise 7860
    logger.info(f"🚀 DINOv2 Service démarré sur port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
