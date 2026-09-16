import os
import sys
import json
import shutil
import asyncio
from typing import Dict, Any, List, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.join(BASE_DIR, "backend")
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from pdf_processor import PDFProcessor
from web_processor import WebArticleProcessor
from tts_engine import TTSEngine

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
UPLOADS_DIR = os.path.join(DATA_DIR, "uploads")
CACHE_DIR = os.path.join(DATA_DIR, "cache")
DOCS_FILE = os.path.join(DATA_DIR, "documents.json")
BOOKMARKS_FILE = os.path.join(DATA_DIR, "bookmarks.json")

os.makedirs(UPLOADS_DIR, exist_ok=True)
os.makedirs(CACHE_DIR, exist_ok=True)

app = FastAPI(title="Smart PDF Audio Reader API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_header(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

tts_engine = TTSEngine(cache_dir=CACHE_DIR)

def load_json_store(file_path: str, default: Any) -> Any:
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return default
    return default

def save_json_store(file_path: str, data: Any):
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

class BookmarkPayload(BaseModel):
    doc_id: str
    section_id: int
    current_time: float
    duration: Optional[float] = 0.0
    voice: Optional[str] = "en-US-ChristopherNeural"
    playback_rate: Optional[float] = 1.0

class PlaylistPayload(BaseModel):
    urls: List[str]
    title: Optional[str] = None

class RawTextPayload(BaseModel):
    text: str
    title: Optional[str] = None

@app.get("/api/voices")
async def get_voices():
    """Returns curated natural neural voice options."""
    return {"voices": tts_engine.list_voices()}

@app.get("/api/documents")
async def list_documents():
    """Returns all uploaded and processed PDF documents."""
    docs = load_json_store(DOCS_FILE, {})
    # Return as list sorted by creation time
    doc_list = list(docs.values())
    doc_list.sort(key=lambda d: d.get("created_at", 0), reverse=True)
    return {"documents": doc_list}

@app.get("/api/documents/{doc_id}")
async def get_document(doc_id: str):
    """Returns detailed structure and sections of a document."""
    docs = load_json_store(DOCS_FILE, {})
    if doc_id not in docs:
        raise HTTPException(status_code=404, detail="Document not found")
    return docs[doc_id]

@app.delete("/api/documents/{doc_id}")
async def delete_document(doc_id: str):
    """Deletes a document from the library."""
    docs = load_json_store(DOCS_FILE, {})
    if doc_id in docs:
        del docs[doc_id]
        save_json_store(DOCS_FILE, docs)
    return {"status": "deleted", "doc_id": doc_id}

@app.post("/api/upload")
async def upload_pdf(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...)
):
    """Uploads, extracts, cleans, and segments a PDF file with 100% free local processing."""
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    file_path = os.path.join(UPLOADS_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    processor = PDFProcessor()
    try:
        doc_data = processor.process_pdf(
            pdf_path=file_path,
            doc_title=os.path.splitext(file.filename)[0].replace("_", " ").replace("-", " ")
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {str(e)}")

    docs = load_json_store(DOCS_FILE, {})
    docs[doc_data["id"]] = doc_data
    save_json_store(DOCS_FILE, docs)

    # Immediately begin background pre-caching for this newly uploaded document
    background_tasks.add_task(_precache_all_worker, doc_data["id"], "en-US-ChristopherNeural", "+0%")

    return doc_data

@app.post("/api/playlist")
async def create_web_playlist(
    payload: PlaylistPayload,
    background_tasks: BackgroundTasks
):
    """Fetches, cleans, segments a playlist of web article URLs into a continuous audio document."""
    clean_urls = [u.strip() for u in payload.urls if u.strip()]
    if not clean_urls:
        raise HTTPException(status_code=400, detail="Please provide at least one valid URL.")

    processor = WebArticleProcessor()
    try:
        doc_data = processor.process_playlist(clean_urls, playlist_title=payload.title)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process web playlist: {str(e)}")

    docs = load_json_store(DOCS_FILE, {})
    docs[doc_data["id"]] = doc_data
    save_json_store(DOCS_FILE, docs)

    # Immediately begin background pre-caching
    background_tasks.add_task(_precache_all_worker, doc_data["id"], "en-US-ChristopherNeural", "+0%")

    return doc_data

@app.post("/api/raw-text")
async def create_from_raw_text(
    payload: RawTextPayload,
    background_tasks: BackgroundTasks
):
    """Converts pasted article or newsletter text into a segmented audio document."""
    if not payload.text or not payload.text.strip():
        raise HTTPException(status_code=400, detail="Please provide article text to read.")

    processor = WebArticleProcessor()
    try:
        doc_data = processor.process_raw_text(payload.text, custom_title=payload.title)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process pasted text: {str(e)}")

    docs = load_json_store(DOCS_FILE, {})
    docs[doc_data["id"]] = doc_data
    save_json_store(DOCS_FILE, docs)

    # Immediately begin background pre-caching
    background_tasks.add_task(_precache_all_worker, doc_data["id"], "en-US-ChristopherNeural", "+0%")

    return doc_data

async def _prefetch_upcoming_sections(doc_id: str, start_section_id: int, count: int = 3, voice: str = "en-US-ChristopherNeural", rate: str = "+0%"):
    """Background task that pre-synthesizes upcoming sections into disk cache."""
    try:
        docs = load_json_store(DOCS_FILE, {})
        doc = docs.get(doc_id)
        if not doc:
            return
        for offset in range(count):
            target_id = start_section_id + offset
            target_sec = next((s for s in doc.get("sections", []) if s.get("id") == target_id), None)
            if target_sec and target_sec.get("text"):
                if not tts_engine.is_cached(target_sec["text"], voice=voice, rate=rate):
                    await tts_engine.synthesize(text=target_sec["text"], voice=voice, rate=rate)
    except Exception as e:
        print(f"Background prefetch error: {e}")

@app.get("/api/documents/{doc_id}/sections/{section_id}/audio")
async def get_section_audio(
    doc_id: str,
    section_id: int,
    background_tasks: BackgroundTasks,
    voice: str = "en-US-ChristopherNeural",
    rate: str = "+0%"
):
    """Generates (or streams from cache) the audio for a specific document section and auto-prefetches the next 3."""
    docs = load_json_store(DOCS_FILE, {})
    if doc_id not in docs:
        raise HTTPException(status_code=404, detail="Document not found")

    doc = docs[doc_id]
    section = next((s for s in doc.get("sections", []) if s.get("id") == section_id), None)
    if not section:
        raise HTTPException(status_code=404, detail=f"Section {section_id} not found")

    text_to_speak = section.get("text", "").strip()
    if not text_to_speak:
        raise HTTPException(status_code=400, detail="Section text is empty")

    try:
        audio_path = await tts_engine.synthesize(
            text=text_to_speak,
            voice=voice,
            rate=rate
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Audio synthesis error: {str(e)}")

    # Automatically queue background prefetching of the next 3 sections
    background_tasks.add_task(_prefetch_upcoming_sections, doc_id, section_id + 1, 3, voice, rate)

    return FileResponse(audio_path, media_type="audio/mpeg", filename=f"{doc_id}_sec_{section_id}.mp3")

@app.get("/api/documents/{doc_id}/cache_status")
async def get_document_cache_status(doc_id: str, voice: str = "en-US-ChristopherNeural"):
    """Returns the count of cached sections vs total sections."""
    docs = load_json_store(DOCS_FILE, {})
    if doc_id not in docs:
        raise HTTPException(status_code=404, detail="Document not found")

    doc = docs[doc_id]
    sections = doc.get("sections", [])
    total = len(sections)
    cached_count = sum(1 for s in sections if tts_engine.is_cached(s.get("text", ""), voice=voice))
    
    return {
        "doc_id": doc_id,
        "total_sections": total,
        "cached_sections": cached_count,
        "is_fully_cached": cached_count == total,
        "percentage": round((cached_count / total) * 100, 1) if total > 0 else 0
    }

async def _precache_all_worker(doc_id: str, voice: str, rate: str):
    docs = load_json_store(DOCS_FILE, {})
    doc = docs.get(doc_id)
    if not doc:
        return
    for sec in doc.get("sections", []):
        if sec.get("text") and not tts_engine.is_cached(sec["text"], voice=voice, rate=rate):
            try:
                await tts_engine.synthesize(text=sec["text"], voice=voice, rate=rate)
            except Exception as e:
                print(f"Error precaching section {sec.get('id')}: {e}")

@app.post("/api/documents/{doc_id}/precache_all")
async def precache_all_document_audio(doc_id: str, background_tasks: BackgroundTasks, voice: str = "en-US-ChristopherNeural", rate: str = "+0%"):
    """Starts a background worker to pre-generate audio for every section in the document."""
    docs = load_json_store(DOCS_FILE, {})
    if doc_id not in docs:
        raise HTTPException(status_code=404, detail="Document not found")

    background_tasks.add_task(_precache_all_worker, doc_id, voice, rate)
    return {"status": "started", "doc_id": doc_id, "message": "Background audio pre-generation started."}

@app.post("/api/bookmark")
async def save_bookmark(payload: BookmarkPayload):
    """Saves user playback bookmark for resume functionality."""
    bookmarks = load_json_store(BOOKMARKS_FILE, {})
    bookmarks[payload.doc_id] = payload.model_dump()
    save_json_store(BOOKMARKS_FILE, bookmarks)
    return {"status": "saved", "bookmark": payload}

@app.get("/api/bookmark/{doc_id}")
async def get_bookmark(doc_id: str):
    """Retrieves last playback position for a document."""
    bookmarks = load_json_store(BOOKMARKS_FILE, {})
    return bookmarks.get(doc_id, None)

@app.post("/api/sample")
async def create_sample_document(background_tasks: BackgroundTasks):
    """Generates a sample document to test audio reading immediately."""
    sample_id = "sample-doc"
    sample_data = {
        "id": sample_id,
        "title": "The Future of AI Voice & Search",
        "filename": "Future_of_AI_Voice.pdf",
        "num_pages": 4,
        "total_words": 1050,
        "total_estimated_minutes": 7.0,
        "created_at": 1723650000,
        "sections": [
            {
                "id": 1,
                "title": "1. Introduction: Beyond Robotic Text-to-Speech",
                "text": "For years, listening to documents and PDFs felt like an endurance test. Standard screen readers sounded robotic, stilted, and robotic, often stumbling over simple punctuation, footnotes, and citation markers. But today, the combination of modern large language models and neural speech synthesis has completely transformed spoken audio into an experience that rivals top-tier studio audiobook narrators.",
                "word_count": 62,
                "estimated_minutes": 0.4
            },
            {
                "id": 2,
                "title": "2. Why Intelligent Document Pre-Processing Matters",
                "text": "When you try to read a raw PDF aloud, you quickly encounter frustrating obstacles. Page numbers like 'Page 3 of 42', running header titles, table footnotes, and bracketed academic citations like '[14]' disrupt the natural rhythm of speech. By using Gemini to understand document layout, we clean out the formatting noise and rewrite complex tables or bullet points into clear, conversational sentences that flow naturally when spoken.",
                "word_count": 69,
                "estimated_minutes": 0.5
            },
            {
                "id": 3,
                "title": "3. The Power of Mobile Media Controls",
                "text": "Listening while walking, driving, or relaxing requires seamless playback controls. Standard phone media sessions allow you to skip backward fifteen seconds to catch a missed sentence, jump forward, adjust narration speed, and switch chapters right from your lock screen or Bluetooth headphones without ever having to unlock your phone.",
                "word_count": 52,
                "estimated_minutes": 0.4
            },
            {
                "id": 4,
                "title": "4. Conclusion: Your Custom Audio Companion",
                "text": "With zero recurring fees on free neural voices, instant local caching, and smart text adaptation, you now have a personal audio companion that turns any lengthy research paper, book, or work document into an engaging, high-quality audio experience on any device.",
                "word_count": 42,
                "estimated_minutes": 0.3
            }
        ]
    }
    docs = load_json_store(DOCS_FILE, {})
    docs[sample_id] = sample_data
    save_json_store(DOCS_FILE, docs)

    # Immediately begin background pre-caching for sample document
    background_tasks.add_task(_precache_all_worker, sample_id, "en-US-ChristopherNeural", "+0%")

    return sample_data

# Mount frontend static files
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
