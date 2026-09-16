# Smart Audio Reader 🎧 (PDFs, Webpages, & URL Playlists)

A mobile-first, high-quality audio reader designed to turn PDFs, online articles, web playlists, newsletters, and books into natural spoken audiobooks.

- **100% Free**: Uses Microsoft Edge Neural TTS with zero per-minute audio charges and zero AI token costs.
- **Natural Voice Narration**: Broadcast-quality voices (e.g. *Christopher*, *Jenny*, *Eric*, *Aria*, *Sonia*) that sound like human audiobook narrators.
- **Webpage & Multi-URL Playlists**: Enter a list of article links (one per line). The reader automatically extracts the clean article content (stripping ads, navbars, sidebars, cookie banners) and queues them into a continuous audiobook queue.
- **Paste Text Fallback**: Paste raw text, notes, memos, or paywalled articles directly into the reader.
- **Smart Local Text Cleaning**: Cleans running headers, footers, page numbering (e.g. `Page 12 of 80`), footnotes, and citation brackets (e.g. `[1]`, `[14-16]`).
- **Full Mobile Lock-Screen & Headphone Controls**: Skip $\pm 15$s, pause/resume, and advance chapters or articles directly from your phone lock-screen or Bluetooth headphones.
- **Interactive Synced Reader**: Paragraph-by-paragraph visual highlighting that tracks the voice in real time with tap-to-listen scrubbing.
- **Smart Bookmarking & Caching**: Remembers your exact document, chapter, and second timestamp, caching audio locally so you never wait or reload twice.

---

## 1. Technical Architecture

```
[ Upload PDF / Web URLs Playlist / Paste Text ]
                       │
                       ▼
              [ FastAPI Backend ]
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
  [ PyPDF Engine ] [ Web Scraper ] [ Text Normalizer ]
   Extract pages    BS4 Clean Extr   Speech Regex
        └──────────────┬──────────────┘
                       │
                       ▼
         [ Logical Chapter Segmentation ]
   • Splits into ~350-450 word digestible audio chunks
   • Sequences multi-article playlists into consecutive tracks
                       │
                       ▼
        [ Free Edge Neural TTS & Local Cache ]
   • Christopher, Jenny, Eric, Aria, Sonia, etc.
   • Pre-buffers upcoming chapters in background
   • MP3 caching in `data/cache/` (0 latency on repeat listens)
                       │
                       ▼
          [ Responsive Frontend / PWA ]
   • Brand Colors: #f15a25, #5c2882, #662d91, #333333
   • Typography: Poppins (headings), Noto Sans (body)
   • MediaSession lock-screen controls & real-time sentence highlighter
   • Automatic consecutive track progression across playlist articles
```

---

## 2. Terminal Commands to Run the Project

### Quick Start (One Command)
Run the automated startup script:

```bash
./run.sh
```

### Manual Setup & Execution
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r backend/requirements.txt
python3 -m uvicorn backend.app:app --host 0.0.0.0 --port 8000 --reload
```

### Google Cloud Run Deployment (Permanent 24/7 Hosting)
Deploy directly to Google Cloud Run:

```bash
gcloud run deploy pdf-audio-reader \
  --source . \
  --project=YOUR_GOOGLE_CLOUD_PROJECT_ID \
  --region=us-central1 \
  --allow-unauthenticated \
  --memory=1Gi \
  --cpu=1
```

- **Mobile Access**: Open your deployed URL in Safari or Chrome on your phone, tap **Share** > **Add to Home Screen** to install as a standalone audio app with full lock-screen & Bluetooth controls.

---

## 3. License & Acceptable Use

This project is licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE)**.

- ✅ **Permitted**: Personal reading, private self-hosting for your own use, educational review, and academic research.
- ❌ **Not Permitted**: Commercial use, selling the software, bundling into commercial products, or offering as a paid SaaS service.
- ⚠️ **Third-Party TTS Notice**: Voice narration utilizes Microsoft Edge Neural Text-to-Speech endpoints, which are intended for individual personal reading. Any commercial application requires licensing an official commercial API (such as Microsoft Azure Speech Services or Google Cloud TTS).
