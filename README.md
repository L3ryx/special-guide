# 🔍 ReverseScout — Etsy × AliExpress Analyzer

Automatically scrape Etsy listings, reverse image search them on Google, filter for AliExpress results, and compare similarity using OpenAI Vision.

## ✨ Features

1. **Keyword search on Etsy** via ScraperAPI
2. **Extracts top 10 listings** (title, link, image)
3. **Uploads images to ImgBB** to get public URLs
4. **Google Reverse Image Search** via Serper API
5. **AliExpress filter** on reverse search results (top 5)
6. **AI similarity comparison** using GPT-4o Vision
7. **Visual results** — shows Etsy vs AliExpress side by side for ≥60% similarity

---

## 🚀 Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure API keys

Copy the example env file:
```bash
cp .env.example .env
```

Edit `.env` and fill in your API keys:

| Key | Where to get it |
|-----|----------------|
| `SCRAPEAPI_KEY` | https://www.scraperapi.com (free tier: 1000 req/month) |
| `IMGBB_API_KEY` | https://api.imgbb.com (free) |
| `SERPER_API_KEY` | https://serper.dev (free tier: 2500 queries) |
| `OPENAI_API_KEY` | https://platform.openai.com/api-keys |

### 3. Start the server

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

### 4. Open in browser

```
http://localhost:3000
```

---

## 📁 Project Structure

```
etsy-scraper/
├── src/
│   ├── server.js                  # Express server entry point
│   ├── routes/
│   │   └── scrape.js              # API routes (POST /api/search)
│   └── services/
│       ├── etsyScraper.js         # Etsy scraping via ScraperAPI
│       ├── imgbbUploader.js       # Image hosting via ImgBB
│       ├── reverseImageSearch.js  # Google reverse search via Serper
│       └── imageSimilarity.js     # GPT-4o Vision comparison
├── public/
│   └── index.html                 # Frontend UI
├── .env.example                   # Environment variables template
├── package.json
└── README.md
```

---

## 🔌 API Endpoints

### `POST /api/search`
Runs the full pipeline.

**Body:**
```json
{
  "keyword": "personalized jewelry",
  "similarityThreshold": 60
}
```

**Response:** Server-Sent Events stream with progress + final results.

### `GET /api/health`
Returns API key configuration status.

---

## 💡 Tips

- **Lower the threshold** (e.g., 50%) to find more matches
- **Higher threshold** (e.g., 80%) for near-identical products only
- The pipeline takes 2–5 minutes for 10 listings due to API rate limits
- ScraperAPI's `render=true` is needed for Etsy's JavaScript-rendered pages

---

## 🛠 Deploying to a Server

### Using PM2 (recommended)

```bash
npm install -g pm2
pm2 start src/server.js --name reversescout
pm2 startup
pm2 save
```

### Using Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t reversescout .
docker run -p 3000:3000 --env-file .env reversescout
```

### Nginx reverse proxy (optional)

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
        # Required for SSE
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

---

## ⚠️ Notes

- Etsy's HTML structure may change — update parsing patterns in `etsyScraper.js` if needed
- OpenAI GPT-4o Vision is billed per image analyzed (~$0.001-0.003 per comparison)
- Respect rate limits: ScraperAPI, Serper, and ImgBB all have free tier limits
