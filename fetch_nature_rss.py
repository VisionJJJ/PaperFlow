import os
import re
import json
import time
import argparse
import io
import random
from urllib.parse import quote

import requests
from requests.exceptions import RequestException
import xml.etree.ElementTree as ET
from PIL import Image

USER_AGENT = "Mozilla/5.0 (compatible; CodexBot/1.0; +https://openai.com/)"
TIMEOUT = 20
REQUEST_DELAY_SEC = 0.8
REQUEST_JITTER_SEC = 0.4

NS = {
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "prism": "http://prismstandard.org/namespaces/basic/2.0/",
    "rss": "http://purl.org/rss/1.0/",
}


def safe_folder_name(doi: str) -> str:
    # Windows doesn't allow ":*?<>|" and slashes
    return doi.replace("/", "_").replace(":", "_")


def safe_journal_name(name: str) -> str:
    if not name:
        return "Unknown Journal"
    cleaned = re.sub(r"[\\\\/:*?\"<>|]+", "_", name).strip()
    return cleaned or "Unknown Journal"


def normalize_journal_title(name: str) -> str:
    if not name or not isinstance(name, str):
        return ""
    # Basic title-case normalization while preserving common acronyms.
    words = []
    for w in name.strip().split():
        if w.isupper() and len(w) <= 6:
            words.append(w)
        else:
            words.append(w.capitalize())
    return " ".join(words)


def clean_caption(text: str) -> str:
    if not text:
        return ""
    # Remove control characters and normalize whitespace
    text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def fetch_xml(url: str) -> ET.Element:
    r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
    r.raise_for_status()
    time.sleep(REQUEST_DELAY_SEC + random.random() * REQUEST_JITTER_SEC)
    return ET.fromstring(r.text)


def parse_items(root: ET.Element):
    items = []
    for item in root.findall(".//rss:item", NS):
        # rdf:about attribute is on item element
        about = item.get(f"{{{NS['rdf']}}}about")
        doi_el = item.find("prism:doi", NS)
        doi = doi_el.text.strip() if doi_el is not None and doi_el.text else None
        if about and doi:
            items.append((about, doi))
    return items


def extract_publication_name(root: ET.Element):
    # Try RSS channel-level publication name if available
    el = root.find(".//prism:publicationName", NS)
    if el is not None and el.text:
        return normalize_journal_title(el.text.strip())
    return ""


def extract_ld_json(html: str):
    # Find all <script type="application/ld+json"> blocks
    scripts = re.findall(
        r"<script[^>]*type=['\"]application/ld\+json['\"][^>]*>(.*?)</script>",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for raw in scripts:
        content = raw.strip()
        if not content:
            continue
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            # Sometimes multiple JSON objects are concatenated; try to salvage by wrapping
            try:
                data = json.loads("[" + content + "]")
            except Exception:
                continue
        for obj in iterate_json_objects(data):
            if isinstance(obj, dict) and "mainEntity" in obj:
                return obj
    return None


def iterate_json_objects(data):
    if isinstance(data, list):
        for item in data:
            yield from iterate_json_objects(item)
    elif isinstance(data, dict):
        yield data
        for v in data.values():
            yield from iterate_json_objects(v)


def parse_article_metadata(article_url: str):
    r = None
    for attempt in range(3):
        try:
            r = requests.get(article_url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
            r.raise_for_status()
            break
        except RequestException as e:
            if attempt == 2:
                print(f"  Warning: failed to fetch article page: {e}")
                return None
            time.sleep(0.5)
    if r is None:
        return None, None
    time.sleep(REQUEST_DELAY_SEC + random.random() * REQUEST_JITTER_SEC)
    html = r.text
    data_layer = extract_data_layer_content(html)
    content_type = data_layer.get("content_type") if data_layer else None
    content_subgroup = data_layer.get("content_subgroup") if data_layer else None
    journal_title = data_layer.get("journal_title") if data_layer else None
    journal_title = normalize_journal_title(journal_title)

    ld = extract_ld_json(html)
    if not ld:
        return {
            "headline": None,
            "description": None,
            "first_author_affiliation": None,
            "content_type": content_type,
            "content_subgroup": content_subgroup,
            "journal_title": normalize_journal_title(journal_title),
            "article_url": article_url,
            "publish_date": None,
            "authors": [],
        }, html

    main = ld.get("mainEntity", {}) if isinstance(ld, dict) else {}
    headline = main.get("headline")
    description = main.get("description")
    date_published = main.get("datePublished")
    if isinstance(date_published, str) and "T" in date_published:
        date_published = date_published.split("T", 1)[0]
    elif not isinstance(date_published, str):
        date_published = None

    # author could be list or dict
    author = ld.get("author")
    first_aff = None
    authors_list = []
    if isinstance(author, list) and author:
        first_aff = extract_affiliation(author[0])
        for a in author:
            if isinstance(a, dict) and a.get("name"):
                authors_list.append(a.get("name"))
    elif isinstance(author, dict):
        first_aff = extract_affiliation(author)
        if author.get("name"):
            authors_list.append(author.get("name"))

    journal_from_ld = None
    is_part_of = ld.get("isPartOf")
    if isinstance(is_part_of, dict):
        journal_from_ld = normalize_journal_title(is_part_of.get("name"))

    return {
        "headline": headline,
        "description": description,
        "first_author_affiliation": first_aff,
        "authors": authors_list,
        "content_type": content_type,
        "content_subgroup": content_subgroup,
        "journal_title": journal_title or journal_from_ld,
        "article_url": article_url,
        "publish_date": date_published,
    }, html


def extract_affiliation(author_obj):
    if not isinstance(author_obj, dict):
        return None
    aff = author_obj.get("affiliation")
    if isinstance(aff, list) and aff:
        aff = aff[0]
    if isinstance(aff, dict):
        return aff.get("name") or aff.get("@id") or None
    if isinstance(aff, str):
        return aff
    return None


def extract_data_layer_content(html: str):
    # Example: window.dataLayer = [{... "content": {"category": {"contentType": "news & views"}, "journal": {"title": "Nature Geoscience"}} ...}];
    m = re.search(r"window\\.dataLayer\\s*=\\s*(\\[.*?\\]);", html, flags=re.DOTALL)
    if not m:
        return {}
    raw = m.group(1).strip()
    try:
        data = json.loads(raw)
    except Exception:
        return {}
    result = {}
    if isinstance(data, list):
        for obj in data:
            if isinstance(obj, dict):
                content = obj.get("content") or {}
                category = content.get("category") or {}
                journal = content.get("journal") or {}
                legacy = content.get("legacy") or {}
                ct = category.get("contentType")
                jt = journal.get("title")
                wt = legacy.get("webtrendsContentGroup")
                wts = legacy.get("webtrendsContentSubGroup")
                if ct and "content_type" not in result:
                    result["content_type"] = ct
                if jt and "journal_title" not in result:
                    result["journal_title"] = jt
                if wt and "journal_title" not in result:
                    result["journal_title"] = wt
                if wts and "content_subgroup" not in result:
                    result["content_subgroup"] = wts
    return result


def extract_figures(html: str):
    figures = []
    # First try figure blocks with captions (more reliable on Nature pages)
    fig_blocks = re.findall(r"<figure[^>]*>.*?</figure>", html, flags=re.DOTALL | re.IGNORECASE)
    for block in fig_blocks:
        # caption text
        caption_match = re.search(r"<figcaption[^>]*>(.*?)</figcaption>", block, flags=re.DOTALL | re.IGNORECASE)
        caption = ""
        if caption_match:
            caption = re.sub(r"<[^>]+>", "", caption_match.group(1)).strip()
            caption = clean_caption(caption)
        # image srcset or img
        srcset_match = re.search(r"srcset=(['\"])(.*?)\1", block, flags=re.IGNORECASE)
        img_match = re.search(r"<img[^>]*src=(['\"])(.*?)\1[^>]*>", block, flags=re.IGNORECASE)
        src = ""
        if srcset_match:
            srcset = srcset_match.group(2).strip()
            src = re.split(r"[\s,]", srcset)[0]
        elif img_match:
            src = img_match.group(2).strip()
        if not src:
            continue
        if src.startswith("//"):
            src = "https:" + src
        # Prefer larger size if thumbnail
        src = src.replace("/m312/", "/lw685/")
        figures.append({"url": src, "title": caption})

    if figures:
        return figures

    # Fallback: match figure link blocks
    blocks = re.findall(
        r"<a[^>]*class=(['\"])(?:(?!\\1).)*c-article-section__figure-link(?:(?!\\1).)*\\1[^>]*>(.*?)</a>",
        html,
        flags=re.DOTALL | re.IGNORECASE,
    )
    for block in blocks:
        if isinstance(block, tuple):
            block = block[1]
        srcset_match = re.search(r"srcset=(['\"])(.*?)\1", block, flags=re.IGNORECASE)
        data_srcset_match = re.search(r"data-srcset=(['\"])(.*?)\1", block, flags=re.IGNORECASE)
        img_match = re.search(r"<img[^>]*src=(['\"])(.*?)\1[^>]*>", block, flags=re.IGNORECASE)
        data_img_match = re.search(r"<img[^>]*data-src=(['\"])(.*?)\1[^>]*>", block, flags=re.IGNORECASE)
        alt_match = re.search(r"<img[^>]*alt=(['\"])(.*?)\1", block, flags=re.IGNORECASE)
        src = ""
        if srcset_match:
            srcset = srcset_match.group(2).strip()
            src = re.split(r"[\s,]", srcset)[0]
        elif data_srcset_match:
            srcset = data_srcset_match.group(2).strip()
            src = re.split(r"[\s,]", srcset)[0]
        elif img_match:
            src = img_match.group(2).strip()
        elif data_img_match:
            src = data_img_match.group(2).strip()
        if not src:
            continue
        if src.startswith("//"):
            src = "https:" + src
        alt = alt_match.group(2).strip() if alt_match else ""
        alt = clean_caption(alt)
        figures.append({"url": src, "title": alt})
    return figures


def build_media_url(doi: str, fig_num: int):
    # Example: 10.1038/s41561-026-01928-z
    # MediaObjects file example: 41561_2026_1928_Fig1_HTML.png
    suffix = doi.split("/", 1)[-1]
    m = re.match(r"s(\d+)-(\d{3})-(\d+)-([a-z0-9]+)", suffix, re.IGNORECASE)
    if not m:
        return None
    journal, year3, artnum, _tail = m.groups()
    # year3 is a 3-digit year offset like 026 -> 2026
    year = str(2000 + int(year3))
    # strip leading zeros only if present; keep as-is otherwise
    art = artnum.lstrip("0") or "0"
    filename = f"{journal}_{year}_{art}_Fig{fig_num}_HTML.png"
    doi_encoded = quote(doi, safe="")
    return (
        "https://media.springernature.com/full/springer-static/image/"
        f"art%3A{doi_encoded}/MediaObjects/{filename}?as=webp"
    )


def download_images(doi: str, out_dir: str, figures):
    saved = []
    for i, fig in enumerate(figures, start=1):
        url = fig.get("url")
        if not url:
            continue
        r = None
        for attempt in range(3):
            try:
                r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
                break
            except RequestException as e:
                if attempt == 2:
                    print(f"  Warning: request failed for Fig{i}: {e}")
                time.sleep(0.5)
        if r is None:
            # Network failure: skip this figure and try next
            continue
        content_type = (r.headers.get("content-type") or "").lower()
        if not r.content:
            continue
        # If it's not an image response, treat as missing and stop.
        if not content_type.startswith("image/"):
            continue
        time.sleep(REQUEST_DELAY_SEC + random.random() * REQUEST_JITTER_SEC)
        fname = f"{doi.replace('/', '_')}_Fig{i}.png"
        fpath = os.path.join(out_dir, fname)
        try:
            img = Image.open(io.BytesIO(r.content))
            if img.mode in ("P", "LA"):
                img = img.convert("RGBA")
            img.save(fpath, format="PNG")
        except Exception as e:
            print(f"  Warning: failed to convert Fig{i} to PNG: {e}")
            continue
        saved.append({"file": fname, "title": clean_caption(fig.get("title") or "")})
    return saved


def write_text(out_dir: str, meta: dict):
    fpath = os.path.join(out_dir, "info.txt")
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(f"Journal: {meta.get('journal_title') or ''}\n")
        f.write(f"Article URL: {meta.get('article_url') or ''}\n")
        f.write(f"Content Subgroup: {meta.get('content_subgroup') or ''}\n")
        f.write(f"Publish Date: {meta.get('publish_date') or ''}\n")
        f.write(f"Title: {meta.get('headline') or ''}\n")
        f.write(f"Abstract: {meta.get('description') or ''}\n")
        if meta.get("authors"):
            f.write(f"Authors: {', '.join(meta.get('authors'))}\n")
        f.write(f"First author affiliation: {meta.get('first_author_affiliation') or ''}\n")
    return fpath


def collect_existing_doi_folders(out_root: str):
    existing = set()
    if not os.path.isdir(out_root):
        return existing
    for root, dirs, _files in os.walk(out_root):
        for d in dirs:
            existing.add(d)
    return existing


def load_rss_list(rss_file: str):
    if not rss_file or not os.path.isfile(rss_file):
        return []
    try:
        with open(rss_file, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
            urls = []
            for item in data:
                if isinstance(item, dict) and item.get("url"):
                    urls.append(str(item.get("url")).strip())
                elif isinstance(item, str):
                    urls.append(item.strip())
            return [u for u in urls if u]
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("rss_url", nargs="?", default="", help="RSS URL, e.g. https://www.nature.com/ngeo.rss")
    ap.add_argument("--out", default="output", help="output directory")
    ap.add_argument("--max-figs", type=int, default=50)
    ap.add_argument("--rss-list", default="rss_list.json", help="RSS list JSON file")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    existing_dirs = collect_existing_doi_folders(args.out)
    # Resolve rss_list.json: prefer current working directory; fallback to script directory.
    if args.rss_list and not os.path.isabs(args.rss_list):
        cwd_path = os.path.abspath(args.rss_list)
        script_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.rss_list)
        if os.path.isfile(cwd_path):
            args.rss_list = cwd_path
        elif os.path.isfile(script_path):
            args.rss_list = script_path
    rss_urls = []
    if args.rss_url:
        rss_urls = [args.rss_url]
    else:
        rss_urls = load_rss_list(args.rss_list)
    if not rss_urls:
        print("No RSS URLs provided.")
        return

    for rss_url in rss_urls:
        root = fetch_xml(rss_url)
        items = parse_items(root)
        rss_pub_name = extract_publication_name(root)

        print(f"RSS {rss_url} -> {len(items)} items")
        for article_url, doi in items:
            safe_doi = safe_folder_name(doi)
            if safe_doi in existing_dirs:
                print(f"Skipping {doi} (already downloaded)")
                continue

            print(f"Processing {doi}")
            meta, meta_html = parse_article_metadata(article_url)
            if meta and meta.get("content_type") and str(meta.get("content_type")).strip().lower() == "news & views":
                print("  Skipped (news & views)")
                continue

            journal_name = safe_journal_name(meta.get("journal_title") if meta else None)
            if journal_name == "Unknown Journal" and rss_pub_name:
                journal_name = safe_journal_name(rss_pub_name)

            journal_dir = os.path.join(args.out, journal_name)
            folder = os.path.join(journal_dir, safe_doi)
            os.makedirs(folder, exist_ok=True)

            figures = extract_figures(meta_html if meta_html else "")
            if meta:
                if not meta.get("journal_title"):
                    meta["journal_title"] = journal_name
                else:
                    meta["journal_title"] = normalize_journal_title(meta.get("journal_title"))
                write_text(folder, meta)
            else:
                print(f"  Warning: no ld+json found for {article_url}")
                write_text(folder, {"journal_title": journal_name, "article_url": article_url})

            imgs = download_images(doi, folder, figures)
            # Save image titles mapping
            try:
                with open(os.path.join(folder, "images.json"), "w", encoding="utf-8") as f:
                    json.dump(imgs, f, ensure_ascii=False, indent=2)
            except Exception as e:
                print(f"  Warning: failed to write images.json: {e}")
            print(f"  Saved {len(imgs)} images")
            if len(imgs) == 0:
                # Remove folder if no images were saved
                try:
                    for name in os.listdir(folder):
                        os.remove(os.path.join(folder, name))
                    os.rmdir(folder)
                    print("  Removed empty folder (no images)")
                    if os.path.isdir(journal_dir) and not os.listdir(journal_dir):
                        os.rmdir(journal_dir)
                except Exception as e:
                    print(f"  Warning: failed to remove empty folder: {e}")
            else:
                existing_dirs.add(safe_doi)


if __name__ == "__main__":
    main()
