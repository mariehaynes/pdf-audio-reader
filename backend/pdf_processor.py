import os
import re
import uuid
import json
from typing import List, Dict, Any, Optional
from pypdf import PdfReader

class PDFProcessor:
    def __init__(self):
        pass

    def is_toc_or_index_page(self, text: str, page_num: int) -> bool:
        """Detects if a page is a Table of Contents, Index, or Outline to skip for audio narration."""
        if not text or len(text.strip()) < 30:
            return False

        cleaned = text.strip()
        first_lines = cleaned[:300].lower()

        # 1. Front-matter TOC header check (usually in early pages, e.g. pages 1-15)
        if page_num <= 15 and any(h in first_lines for h in [
            'table of contents', 'contents\n', 'contents ', 'contents\r',
            'table des matières', 'list of figures', 'list of tables', 'outline\n', 'index of tables'
        ]):
            return True

        # 2. Check for sequences of section number + title + trailing page number
        # e.g. '1.3 Changes to RSP 13' or '4.5.3.2.4 Bug-bounty-sourced jailbreak 139'
        toc_inline_entries = len(re.findall(r'\b\d+(?:\.\d+)+\s+[A-Za-z][^\n\d]{3,80}\s+\d{1,4}\b', cleaned))
        
        # Check dot leaders: 'Introduction ....... 5'
        dot_leaders = len(re.findall(r'[A-Za-z].*?[\.·\-_]{3,}\s*\d{1,4}\b', cleaned))
        
        # Count sentences ending in periods/punctuation
        full_sentences = len(re.findall(r'[a-z]{2,}[.?!]\s+[A-Z]', cleaned))

        lines = [l.strip() for l in cleaned.split('\n') if len(l.strip()) > 3]
        if not lines:
            return False
            
        lines_ending_in_number = sum(1 for l in lines if re.search(r'\b\d{1,4}\s*$', l) and not re.search(r'[.?!]\s*$', l))

        # If a page has multiple TOC entries and virtually no narrative sentences
        if (toc_inline_entries + dot_leaders) >= 4 and full_sentences < 5:
            return True

        if len(lines) >= 6 and (lines_ending_in_number / len(lines)) > 0.45 and full_sentences < 5:
            return True

        if page_num <= 15 and (toc_inline_entries + dot_leaders) >= 3 and full_sentences < 3:
            return True

        return False

    def extract_raw_text(self, pdf_path: str) -> Dict[str, Any]:
        """Extracts text page by page from a PDF file, skipping Table of Contents pages."""
        reader = PdfReader(pdf_path)
        num_pages = len(reader.pages)
        pages_text = []
        skipped_toc_pages = 0

        for i, page in enumerate(reader.pages):
            page_num = i + 1
            try:
                page_content = page.extract_text() or ""
                if self.is_toc_or_index_page(page_content, page_num):
                    skipped_toc_pages += 1
                    continue

                pages_text.append({
                    "page_number": page_num,
                    "text": page_content.strip()
                })
            except Exception as e:
                pages_text.append({
                    "page_number": page_num,
                    "text": f"[Error reading page {page_num}: {str(e)}]"
                })

        total_text = "\n\n".join([p["text"] for p in pages_text if p["text"]])
        return {
            "num_pages": num_pages,
            "skipped_toc_pages": skipped_toc_pages,
            "pages": pages_text,
            "raw_total_text": total_text
        }

    def clean_text_for_speech(self, raw_text: str) -> str:
        """Comprehensive local cleaning of PDF text for smooth, natural audio narration."""
        text = raw_text

        # 1. Remove bracketed citations like [1], [12, 13], [1-4]
        text = re.sub(r'\[\s*\d+(?:[\s,–-]+\d+)*\s*\]', '', text)

        # 2. Fix hyphenated line breaks (e.g. "experi-\nment" -> "experiment")
        text = re.sub(r'(\w+)-\n+(\w+)', r'\1\2', text)

        # 3. Remove standalone page headers/footers like "Page 12 of 45", "Page 3", or isolated page digits
        text = re.sub(r'(?i)\bpage\s+\d+(\s+of\s+\d+)?\b', '', text)
        text = re.sub(r'\n+\s*\d+\s*\n+', '\n\n', text)

        # 4. Remove inline TOC dot leaders (e.g. "Introduction ........... 5")
        text = re.sub(r'^[^\n.]{3,70}\s*[\.·\-_]{3,}\s*\d{1,4}\s*$', '', text, flags=re.MULTILINE)

        # 5. Remove raw URLs or web links
        text = re.sub(r'https?://\S+', '', text)

        # 6. Clean up markdown or table borders/dividers like |---|---|
        text = re.sub(r'\|[-:\s|]+\|', '', text)
        text = re.sub(r'\|', ' ', text)

        # 7. Smart line unwrapping: Merge single lines / isolated word wraps into fluent sentences
        # PDFs often extract text with \n \n between single words or arbitrary soft line breaks.
        raw_lines = [l.strip() for l in text.split('\n')]
        unwrapped = []
        for line in raw_lines:
            if not line:
                continue
            # If previous line doesn't end in punctuation (.?!:;) and current line isn't a new bullet/heading
            if unwrapped and not re.search(r'[.?!:;]$', unwrapped[-1]) and not line.startswith(('●', '■', '○', '•', '-', '*')) and not re.match(r'^(?:(?:Chapter|Section)\s+)?\d+(?:\.\d+)*\s+[A-Z]', line):
                unwrapped[-1] = unwrapped[-1] + ' ' + line
            else:
                unwrapped.append(line)

        # 8. Clean bullets and list markers for smooth spoken flow
        cleaned_paras = []
        for p in unwrapped:
            p_clean = re.sub(r'^[ \t]*[•\-\*●■○]\s*', '', p)
            p_clean = re.sub(r'[ \t]+', ' ', p_clean).strip()
            if p_clean:
                cleaned_paras.append(p_clean)

        return '\n\n'.join(cleaned_paras).strip()

    def segment_into_chapters(self, cleaned_text: str, doc_title: str) -> List[Dict[str, Any]]:
        """Splits cleaned text into digestible, logical sections (~400-500 words) with smart titles."""
        paragraphs = [p.strip() for p in cleaned_text.split("\n\n") if len(p.strip()) > 25]

        if not paragraphs:
            paragraphs = [cleaned_text] if cleaned_text else ["No readable text found in document."]

        def extract_heading_title(p: str, fallback_idx: int) -> Optional[str]:
            first_line = p.split('\n')[0].strip()
            # Check for numbered section headers e.g. "1 Introduction and executive summary"
            m = re.match(r'^(?:(?:Chapter|Section)\s+)?(\d+(?:\.\d+)*)\s+([A-Z][^\n.]{3,80})', first_line)
            if m:
                sec_num, sec_title = m.group(1), m.group(2).strip()
                sec_title = re.sub(r'\s+', ' ', sec_title)
                return f"{sec_num}: {sec_title}"
            return None

        def make_fallback_title(p: str, fallback_idx: int) -> str:
            first_line = p.split('\n')[0].strip()
            clean_line = re.sub(r'[^a-zA-Z0-9\s,\'-]', '', first_line)[:50].strip()
            if len(clean_line) > 10:
                return f"Section {fallback_idx}: {clean_line}..."
            return f"Section {fallback_idx}"

        sections = []
        current_paras = []
        current_words = 0
        current_heading = None
        section_idx = 1

        for p in paragraphs:
            p_words = len(p.split())
            heading = extract_heading_title(p, section_idx)
            is_major_heading = bool(heading and len(heading.split(':')[0].split('.')) <= 2)

            # Split if a major new chapter heading is reached or word limit exceeded
            if (is_major_heading and current_paras and current_words > 80) or (current_words + p_words > 480 and current_paras):
                sec_text = "\n\n".join(current_paras)
                words = len(sec_text.split())
                title = current_heading or extract_heading_title(current_paras[0], section_idx) or make_fallback_title(current_paras[0], section_idx)

                sections.append({
                    "id": section_idx,
                    "title": title,
                    "text": sec_text,
                    "word_count": words,
                    "estimated_minutes": round(words / 150, 1)
                })
                section_idx += 1
                current_paras = [p]
                current_words = p_words
                current_heading = heading
            else:
                if not current_heading and heading:
                    current_heading = heading
                current_paras.append(p)
                current_words += p_words

        if current_paras:
            sec_text = "\n\n".join(current_paras)
            words = len(sec_text.split())
            title = current_heading or extract_heading_title(current_paras[0], section_idx) or make_fallback_title(current_paras[0], section_idx)

            sections.append({
                "id": section_idx,
                "title": title,
                "text": sec_text,
                "word_count": words,
                "estimated_minutes": round(words / 150, 1)
            })

        return sections

    def process_pdf(self, pdf_path: str, doc_title: Optional[str] = None) -> Dict[str, Any]:
        """Main processing pipeline for a PDF with 100% local text cleaning."""
        title = doc_title or os.path.splitext(os.path.basename(pdf_path))[0]
        raw_data = self.extract_raw_text(pdf_path)
        cleaned_text = self.clean_text_for_speech(raw_data["raw_total_text"])
        sections = self.segment_into_chapters(cleaned_text, title)

        total_words = sum(s.get("word_count", 0) for s in sections)
        total_estimated_mins = sum(s.get("estimated_minutes", 0) for s in sections)

        doc_id = str(uuid.uuid4())[:8]

        return {
            "id": doc_id,
            "title": title,
            "filename": os.path.basename(pdf_path),
            "num_pages": raw_data["num_pages"],
            "skipped_toc_pages": raw_data.get("skipped_toc_pages", 0),
            "total_words": total_words,
            "total_estimated_minutes": round(total_estimated_mins, 1),
            "sections": sections,
            "created_at": os.path.getctime(pdf_path) if os.path.exists(pdf_path) else None
        }
