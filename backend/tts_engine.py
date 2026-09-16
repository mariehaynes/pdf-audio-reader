import os
import re
import hashlib
import asyncio
import unicodedata
from typing import Dict, Any, List, Tuple
import edge_tts
import aiofiles

CURATED_VOICES = [
    {
        "id": "en-US-ChristopherNeural",
        "name": "Christopher (US Male - Audiobook Narration)",
        "gender": "Male",
        "locale": "en-US",
        "tags": ["warm", "natural", "audiobook", "recommended"]
    },
    {
        "id": "en-US-JennyNeural",
        "name": "Jenny (US Female - Clear & Engaging)",
        "gender": "Female",
        "locale": "en-US",
        "tags": ["articulate", "friendly", "recommended"]
    },
    {
        "id": "en-US-EricNeural",
        "name": "Eric (US Male - Casual & Conversational)",
        "gender": "Male",
        "locale": "en-US",
        "tags": ["dynamic", "conversational"]
    },
    {
        "id": "en-US-AriaNeural",
        "name": "Aria (US Female - Expressive & Rich)",
        "gender": "Female",
        "locale": "en-US",
        "tags": ["expressive", "smooth"]
    },
    {
        "id": "en-US-GuyNeural",
        "name": "Guy (US Male - Professional & Crisp)",
        "gender": "Male",
        "locale": "en-US",
        "tags": ["professional", "clear"]
    },
    {
        "id": "en-GB-SoniaNeural",
        "name": "Sonia (UK Female - Warm British)",
        "gender": "Female",
        "locale": "en-GB",
        "tags": ["british", "warm"]
    },
    {
        "id": "en-GB-RyanNeural",
        "name": "Ryan (UK Male - Polished British)",
        "gender": "Male",
        "locale": "en-GB",
        "tags": ["british", "polished"]
    },
    {
        "id": "en-AU-NatashaNeural",
        "name": "Natasha (AU Female - Australian)",
        "gender": "Female",
        "locale": "en-AU",
        "tags": ["australian", "friendly"]
    }
]

def sanitize_for_tts(raw_text: str) -> str:
    """Cleans text of ligatures, special XML chars, and formatting for robust Edge-TTS synthesis."""
    if not raw_text:
        return ""
    # Normalize unicode (ligatures like fi, fl, ffi -> standard letters)
    text = unicodedata.normalize("NFKD", raw_text)
    # Replace XML problematic characters
    text = text.replace("&", " and ")
    text = re.sub(r'[<>]', '', text)
    # Smart quotes & dashes
    text = text.replace('“', '"').replace('”', '"').replace('’', "'").replace('‘', "'")
    text = text.replace('—', ' - ').replace('–', ' - ')
    # Clean excessive whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def split_text_into_chunks(text: str, max_chunk_chars: int = 750) -> List[str]:
    """Splits a long text into sentence-aware smaller chunks for parallel Edge-TTS streaming."""
    text = sanitize_for_tts(text)
    if len(text) <= max_chunk_chars:
        return [text]

    # Split by sentence boundaries (. ! ?)
    sentences = re.split(r'(?<=[.!?])\s+', text)
    chunks = []
    current_chunk = []
    current_len = 0

    for s in sentences:
        s_len = len(s)
        if current_len + s_len > max_chunk_chars and current_chunk:
            chunks.append(" ".join(current_chunk))
            current_chunk = [s]
            current_len = s_len
        else:
            current_chunk.append(s)
            current_len += s_len

    if current_chunk:
        chunks.append(" ".join(current_chunk))

    return chunks

class TTSEngine:
    def __init__(self, cache_dir: str = "data/cache"):
        self.cache_dir = cache_dir
        os.makedirs(self.cache_dir, exist_ok=True)

    def get_cache_key(self, text: str, voice: str, rate: str = "+0%", pitch: str = "+0Hz") -> str:
        """Generates a stable unique hash for the synthesis request."""
        clean = sanitize_for_tts(text)
        content = f"{voice}:{rate}:{pitch}:{clean}"
        return hashlib.md5(content.encode("utf-8")).hexdigest()

    def get_cached_audio_path(self, cache_key: str) -> str:
        return os.path.join(self.cache_dir, f"{cache_key}.mp3")

    def is_cached(self, text: str, voice: str = "en-US-ChristopherNeural", rate: str = "+0%") -> bool:
        cache_key = self.get_cache_key(text, voice, rate)
        path = self.get_cached_audio_path(cache_key)
        return os.path.exists(path) and os.path.getsize(path) > 1024

    def list_voices(self) -> List[Dict[str, Any]]:
        """Returns list of curated available voices."""
        return CURATED_VOICES

    async def _fetch_chunk_audio(self, index: int, chunk: str, voice: str, rate: str, pitch: str, volume: str = "+50%") -> Tuple[int, bytes]:
        """Fetches a single chunk over Edge-TTS WebSocket with volume boost, timeout, and retry."""
        for attempt in range(2):
            try:
                communicate = edge_tts.Communicate(text=chunk, voice=voice, rate=rate, pitch=pitch, volume=volume)
                buffer = bytearray()
                async for msg in communicate.stream():
                    if msg["type"] == "audio":
                        buffer.extend(msg["data"])
                if len(buffer) > 200:
                    return index, bytes(buffer)
            except Exception as e:
                if attempt == 1:
                    print(f"Error synthesizing chunk {index} on attempt {attempt+1}: {e}")
                    raise e
                await asyncio.sleep(0.5)

        return index, b""

    async def synthesize(self, text: str, voice: str = "en-US-ChristopherNeural", rate: str = "+0%", pitch: str = "+0Hz", volume: str = "+50%") -> str:
        """Synthesizes text using parallel chunked Edge TTS with disk caching and volume boost."""
        clean_text = sanitize_for_tts(text)
        if not clean_text:
            raise ValueError("Text cannot be empty.")

        cache_key = self.get_cache_key(clean_text, voice, rate, pitch)
        file_path = self.get_cached_audio_path(cache_key)

        # Return cached if already completed
        if os.path.exists(file_path) and os.path.getsize(file_path) > 1024:
            return file_path

        chunks = split_text_into_chunks(clean_text, max_chunk_chars=750)
        temp_path = f"{file_path}.tmp_{os.getpid()}_{hashlib.md5(clean_text[:20].encode()).hexdigest()[:6]}"

        try:
            # Parallel synthesis of all chunks with volume boost
            tasks = [self._fetch_chunk_audio(i, chunk, voice, rate, pitch, volume) for i, chunk in enumerate(chunks)]
            results = await asyncio.gather(*tasks)
            results.sort(key=lambda x: x[0])

            # Write combined MP3 stream
            async with aiofiles.open(temp_path, "wb") as out_f:
                for idx, chunk_bytes in results:
                    await out_f.write(chunk_bytes)

            if os.path.exists(temp_path) and os.path.getsize(temp_path) > 500:
                os.replace(temp_path, file_path)
                return file_path
            else:
                raise Exception("Generated audio file was empty or corrupted.")

        except Exception as e:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            raise e
