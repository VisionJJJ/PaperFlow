from __future__ import annotations

import html
import json
import random
import re
import time
from datetime import datetime
from typing import Any
from urllib.parse import quote

import requests
import xml.etree.ElementTree as ET


USER_AGENT = "Mozilla/5.0 (compatible; CodexNatureReader/1.0; +https://openai.com/)"
TIMEOUT = 20
REQUEST_DELAY_SEC = 0.35
REQUEST_JITTER_SEC = 0.25
MAX_FIGURES = 12
MISS_LIMIT = 2

NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "prism": "http://prismstandard.org/namespaces/basic/2.0/",
    "rss": "http://purl.org/rss/1.0/",
}

_SESSION = requests.Session()
_SESSION.headers.update({"User-Agent": USER_AGENT})


def pause() -> None:
    time.sleep(REQUEST_DELAY_SEC + random.random() * REQUEST_JITTER_SEC)


def normalize_space(text: str | None) -> str:
    if not text:
        return ""
    text = html.unescape(text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def normalize_journal_title(name: str | None) -> str:
    if not name:
        return ""
    words = []
    for word in normalize_space(name).split():
        if word.isupper() and len(word) <= 6:
            words.append(word)
        else:
            words.append(word.capitalize())
    return " ".join(words)


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-") or "item"


def article_id_from_doi(doi: str) -> str:
    return slugify(doi.replace("/", "-"))


def fetch_xml(url: str) -> ET.Element:
    response = _SESSION.get(url, timeout=TIMEOUT)
    response.raise_for_status()
    pause()
    return ET.fromstring(response.text)


def parse_rss_items(root: ET.Element) -> list[dict[str, str]]:
    publication_name = extract_publication_name(root)
    items: list[dict[str, str]] = []
    for item in root.findall(".//rss:item", NS):
        article_url = item.get(f"{{{NS['rdf']}}}about") or ""
        doi = item.findtext("prism:doi", default="", namespaces=NS).strip()
        title = normalize_space(item.findtext("rss:title", default="", namespaces=NS))
        if not article_url or not doi:
            continue
        items.append(
            {
                "doi": doi,
                "article_url": article_url,
                "title": title,
                "journal_title": publication_name,
            }
        )
    return items


def extract_publication_name(root: ET.Element) -> str:
    publication_name = root.findtext(".//prism:publicationName", default="", namespaces=NS)
    return normalize_journal_title(publication_name)


def extract_ld_json_objects(html_text: str) -> list[dict[str, Any]]:
    scripts = re.findall(
        r"<script[^>]*type=['\"]application/ld\+json['\"][^>]*>(.*?)</script>",
        html_text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    objects: list[dict[str, Any]] = []
    for raw in scripts:
        raw = raw.strip()
        if not raw:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        objects.extend(list(iterate_json_objects(data)))
    return objects


def iterate_json_objects(data: Any):
    if isinstance(data, dict):
        yield data
        for value in data.values():
            yield from iterate_json_objects(value)
    elif isinstance(data, list):
        for item in data:
            yield from iterate_json_objects(item)


def extract_meta_values(html_text: str) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    for attrs in re.findall(r"<meta\b([^>]+)>", html_text, flags=re.IGNORECASE):
        name_match = re.search(r"\b(?:name|property)\s*=\s*['\"]([^'\"]+)['\"]", attrs, flags=re.IGNORECASE)
        content_match = re.search(r"\bcontent\s*=\s*['\"](.*?)['\"]", attrs, flags=re.IGNORECASE | re.DOTALL)
        if not name_match or not content_match:
            continue
        key = name_match.group(1).strip().lower()
        value = normalize_space(content_match.group(1))
        if not value:
            continue
        result.setdefault(key, []).append(value)
    return result


def first_value(meta: dict[str, list[str]], *keys: str) -> str:
    for key in keys:
        values = meta.get(key.lower())
        if values:
            return values[0]
    return ""


def parse_date(value: str | None) -> str | None:
    if not value:
        return None
    raw = value.strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d %b %Y", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    if "T" in raw:
        return raw.split("T", 1)[0]
    return None


def fetch_article_html(article_url: str) -> str:
    response = _SESSION.get(article_url, timeout=TIMEOUT)
    response.raise_for_status()
    pause()
    return response.text


def fetch_article_summary(article_url: str, rss_title: str = "", doi: str = "") -> dict[str, Any]:
    html_text = fetch_article_html(article_url)
    meta = extract_meta_values(html_text)
    ld_objects = extract_ld_json_objects(html_text)
    main_entity = next(
        (
            obj.get("mainEntity")
            for obj in ld_objects
            if isinstance(obj, dict) and isinstance(obj.get("mainEntity"), dict)
        ),
        {},
    )

    keywords = []
    raw_keywords = main_entity.get("keywords")
    if isinstance(raw_keywords, list):
        keywords = [normalize_space(str(item)) for item in raw_keywords if normalize_space(str(item))]
    elif isinstance(raw_keywords, str):
        keywords = [normalize_space(item) for item in raw_keywords.split(",") if normalize_space(item)]

    title = first_value(meta, "citation_title", "dc.title") or normalize_space(main_entity.get("headline")) or rss_title
    abstract = first_value(meta, "dc.description", "description") or normalize_space(main_entity.get("description"))
    journal_title = normalize_journal_title(first_value(meta, "citation_journal_title", "prism.publicationname"))
    publish_date = parse_date(
        first_value(meta, "citation_publication_date", "citation_online_date", "dc.date")
        or main_entity.get("datePublished")
    )
    article_type = normalize_space(first_value(meta, "citation_article_type", "dc.type", "prism.section"))
    authors = meta.get("citation_author", [])
    first_author_affiliation = first_value(meta, "citation_author_institution")

    return {
        "title": title,
        "abstract": abstract,
        "journal_title": journal_title,
        "published_at": publish_date,
        "article_type": article_type or "Article",
        "keywords": keywords[:6],
        "authors": authors,
        "first_author_affiliation": first_author_affiliation,
        "doi": doi or first_value(meta, "citation_doi"),
    }


def build_media_url(doi: str, fig_num: int) -> str | None:
    suffix = doi.split("/", 1)[-1]
    match = re.match(r"s(\d+)-(\d{3})-(\d+)-([a-z0-9]+)", suffix, re.IGNORECASE)
    if not match:
        return None
    journal, year3, article_number, _ = match.groups()
    year = str(2000 + int(year3))
    article_number = article_number.lstrip("0") or "0"
    filename = f"{journal}_{year}_{article_number}_Fig{fig_num}_HTML.png"
    doi_encoded = quote(doi, safe="")
    return (
        "https://media.springernature.com/full/springer-static/image/"
        f"art%3A{doi_encoded}/MediaObjects/{filename}?as=webp"
    )


def discover_figure_urls(doi: str, max_figures: int = MAX_FIGURES) -> list[dict[str, Any]]:
    figures: list[dict[str, Any]] = []
    misses = 0
    for index in range(1, max_figures + 1):
        url = build_media_url(doi, index)
        if not url:
            break
        try:
            response = _SESSION.head(url, timeout=TIMEOUT, allow_redirects=True)
        except requests.RequestException:
            misses += 1
            if misses >= MISS_LIMIT:
                break
            continue
        pause()
        if response.status_code == 200 and str(response.headers.get("content-type", "")).startswith("image/"):
            figures.append({"index": index, "title": f"Figure {index}", "image_url": url})
            misses = 0
        else:
            misses += 1
            if misses >= MISS_LIMIT:
                break
    return figures


def should_include_article(title: str, article_type: str) -> bool:
    title_text = (title or "").lower()
    type_text = (article_type or "").lower()
    blocked_prefixes = (
        "retraction note",
        "publisher correction",
        "author correction",
        "correction:",
        "editorial expression of concern",
    )
    if any(title_text.startswith(prefix) for prefix in blocked_prefixes):
        return False
    if not type_text:
        return True
    allowed = {"article", "research article", "review", "letter", "originalpaper", "original paper"}
    return type_text in allowed or "article" in type_text or "review" in type_text or "letter" in type_text
