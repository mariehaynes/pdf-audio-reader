import os
import re
import uuid
import time
from typing import List, Dict, Any, Optional
import requests
from bs4 import BeautifulSoup
try:
    from backend.pdf_processor import PDFProcessor
except ImportError:
    from pdf_processor import PDFProcessor

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)

class WebArticleProcessor:
    def __init__(self):
        self.pdf_processor = PDFProcessor()

    def fetch_url(self, url: str, timeout: int = 12) -> str:
        """Fetches the raw HTML content of a URL with browser-like headers."""
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://www.google.com/"
        }
        
        # Ensure scheme
        if not url.startswith("http://") and not url.startswith("https://"):
            url = "https://" + url

        resp = requests.get(url, headers=headers, timeout=timeout)
        resp.raise_for_status()
        return resp.text

    def extract_article(self, html: str, source_url: Optional[str] = None) -> Dict[str, Any]:
        """Parses HTML to extract the clean article title and narrative text."""
        soup = BeautifulSoup(html, "html.parser")

        # 1. Extract best title
        title = ""
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            title = og_title["content"].strip()
        elif soup.find("meta", attrs={"name": "twitter:title"}):
            title = soup.find("meta", attrs={"name": "twitter:title"}).get("content", "").strip()
        elif soup.find("h1"):
            title = soup.find("h1").get_text().strip()
        elif soup.find("title"):
            title = soup.find("title").get_text().strip()

        if not title:
            title = source_url or "Web Article"

        # Clean trailing site name in titles like "Article Name | TechCrunch" or "Article Name - The Verge"
        title = re.sub(r'\s+[|\-–—]\s+[^|\-–—]+$', '', title).strip()

        # 2. Decompose noisy, non-content tags
        unwanted_tags = [
            "script", "style", "nav", "header", "footer", "aside", "form",
            "noscript", "svg", "figure", "button", "iframe", "dialog", "menu"
        ]
        for tag in soup(unwanted_tags):
            tag.decompose()

        # Remove common ad / cookie / popup elements by class or id
        for el in soup.find_all(attrs={"class": re.compile(r'(ad-|advert|cookie|popup|newsletter-signup|social-share|author-bio|comments)', re.I)}):
            el.decompose()

        # 3. Locate the best main container
        container = (
            soup.find("article") or
            soup.find("main") or
            soup.find(attrs={"role": "main"}) or
            soup.find(attrs={"class": re.compile(r'(article-body|post-content|entry-content|story-content|rich-text)', re.I)}) or
            soup.body or
            soup
        )

        # 4. Extract meaningful text paragraphs and subheadings
        content_blocks = []
        for element in container.find_all(["p", "h2", "h3", "h4", "li"]):
            text = element.get_text().strip()
            # Skip tiny menu items or links
            if len(text) > 25:
                if element.name in ["h2", "h3", "h4"]:
                    content_blocks.append(f"\n\n## {text}\n\n")
                elif element.name == "li":
                    content_blocks.append(f"• {text}")
                else:
                    content_blocks.append(text)

        raw_text = "\n\n".join(content_blocks)
        cleaned_text = self.pdf_processor.clean_text_for_speech(raw_text)

        return {
            "title": title,
            "url": source_url or "",
            "cleaned_text": cleaned_text
        }

    def segment_article(self, article: Dict[str, Any], article_index: int, total_articles: int) -> List[Dict[str, Any]]:
        """Segments a single article into natural audio sections (approx ~350-450 words each)."""
        text = article["cleaned_text"]
        title = article["title"]
        paragraphs = [p.strip() for p in text.split("\n\n") if len(p.strip()) > 15]

        if not paragraphs:
            paragraphs = [f"This article titled {title} contains no readable narrative body text."]

        sections = []
        current_paras = []
        current_words = 0
        part_idx = 1

        # Calculate rough number of parts for naming
        total_words = len(text.split())
        needs_parts = total_words > 550

        prefix = f"Article {article_index}: " if total_articles > 1 else ""

        for p in paragraphs:
            words = len(p.split())
            if current_words + words > 450 and current_paras:
                sec_text = "\n\n".join(current_paras)
                part_title = f"{prefix}{title}"
                if needs_parts:
                    part_title += f" (Part {part_idx})"

                sections.append({
                    "title": part_title,
                    "text": sec_text,
                    "word_count": len(sec_text.split()),
                    "estimated_minutes": round(len(sec_text.split()) / 150, 1),
                    "article_url": article.get("url", ""),
                    "article_title": title
                })
                part_idx += 1
                current_paras = [p]
                current_words = words
            else:
                current_paras.append(p)
                current_words += words

        if current_paras:
            sec_text = "\n\n".join(current_paras)
            part_title = f"{prefix}{title}"
            if needs_parts and part_idx > 1:
                part_title += f" (Part {part_idx})"

            sections.append({
                "title": part_title,
                "text": sec_text,
                "word_count": len(sec_text.split()),
                "estimated_minutes": round(len(sec_text.split()) / 150, 1),
                "article_url": article.get("url", ""),
                "article_title": title
            })

        return sections

    def process_playlist(self, urls: List[str], playlist_title: Optional[str] = None) -> Dict[str, Any]:
        """Fetches multiple URLs and compiles them into a unified audio playlist document."""
        clean_urls = [u.strip() for u in urls if u.strip()]
        if not clean_urls:
            raise ValueError("No valid URLs provided.")

        articles = []
        errors = []

        for i, url in enumerate(clean_urls, 1):
            try:
                html = self.fetch_url(url)
                article_data = self.extract_article(html, source_url=url)
                articles.append(article_data)
            except Exception as e:
                errors.append(f"{url}: {str(e)}")

        if not articles and errors:
            raise RuntimeError(f"Failed to fetch articles: {'; '.join(errors)}")

        all_sections = []
        total_articles = len(articles)

        for i, article in enumerate(articles, 1):
            sec_list = self.segment_article(article, article_index=i, total_articles=total_articles)
            all_sections.extend(sec_list)

        # Re-number all section IDs sequentially 1..N
        for idx, sec in enumerate(all_sections, 1):
            sec["id"] = idx

        total_words = sum(s.get("word_count", 0) for s in all_sections)
        total_estimated_mins = sum(s.get("estimated_minutes", 0) for s in all_sections)

        doc_id = str(uuid.uuid4())[:8]

        # Determine playlist title
        if playlist_title and playlist_title.strip():
            final_title = playlist_title.strip()
        elif total_articles == 1:
            final_title = articles[0]["title"]
        else:
            final_title = f"Web Playlist: {articles[0]['title']} (+{total_articles - 1} more)"

        return {
            "id": doc_id,
            "title": final_title,
            "filename": f"playlist_{len(articles)}_articles.html",
            "type": "playlist",
            "num_pages": total_articles, # Use page count field to represent number of articles in UI
            "total_words": total_words,
            "total_estimated_minutes": round(total_estimated_mins, 1),
            "sections": all_sections,
            "articles": [{"title": a["title"], "url": a["url"]} for a in articles],
            "fetch_errors": errors,
            "created_at": time.time()
        }

    def process_raw_text(self, raw_text: str, custom_title: Optional[str] = None) -> Dict[str, Any]:
        """Converts pasted raw text, markdown, or newsletter content into an audio document."""
        cleaned_text = self.pdf_processor.clean_text_for_speech(raw_text)
        
        # Determine title
        first_line = cleaned_text.split("\n")[0].strip()
        first_line_clean = re.sub(r'^[#*\-\s]+', '', first_line)[:60].strip()
        
        title = custom_title.strip() if custom_title and custom_title.strip() else (first_line_clean or "Pasted Text Article")

        article_data = {
            "title": title,
            "url": "pasted-text",
            "cleaned_text": cleaned_text
        }

        sections = self.segment_article(article_data, article_index=1, total_articles=1)
        for idx, sec in enumerate(sections, 1):
            sec["id"] = idx

        total_words = sum(s.get("word_count", 0) for s in sections)
        total_estimated_mins = sum(s.get("estimated_minutes", 0) for s in sections)
        doc_id = str(uuid.uuid4())[:8]

        return {
            "id": doc_id,
            "title": title,
            "filename": "pasted_text.txt",
            "type": "text",
            "num_pages": 1,
            "total_words": total_words,
            "total_estimated_minutes": round(total_estimated_mins, 1),
            "sections": sections,
            "articles": [{"title": title, "url": "pasted-text"}],
            "created_at": time.time()
        }
