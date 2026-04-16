from __future__ import annotations

import io
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any

import requests
from PIL import Image

try:
    from zoneinfo import ZoneInfo
except ImportError:  # Python < 3.9
    from backports.zoneinfo import ZoneInfo

from .config import (
    ARTICLES_PATH,
    ARTICLE_CACHE_DIR,
    DEFAULT_BATCH_SIZE,
    DEFAULT_IMAGE_BATCH,
    IMAGE_LOOKBACK_DAYS,
    MAX_BATCH_SIZE,
    RSS_SEED_PATH,
    STATE_PATH,
    SUBSCRIPTIONS_PATH,
    THUMBNAIL_CACHE_DIR,
    USERS_DIR,
    USER_TIMEZONE,
)
from .nature import (
    article_id_from_doi,
    discover_figure_urls,
    fetch_article_summary,
    fetch_xml,
    parse_rss_items,
    should_include_article,
    slugify,
)
from .storage import read_json, write_json


LOCK = Lock()
TZ = ZoneInfo(USER_TIMEZONE)
STATE_SCHEMA_VERSION = 3
THUMBNAIL_MAX_EDGE = 560
DEFAULT_ACTIVE_COLUMN = "未归档"
DEFAULT_ARCHIVED_COLUMN = "已归档"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today_local() -> str:
    return datetime.now(TZ).date().isoformat()


def parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def article_cache_path(article_id: str):
    return ARTICLE_CACHE_DIR / f"{article_id}.json"


def thumbnail_cache_path(article_id: str, figure_index: int):
    return THUMBNAIL_CACHE_DIR / article_id / f"{int(figure_index)}.webp"


def thumbnail_public_url(article_id: str, figure_index: int) -> str:
    return f"/media/thumbs/{article_id}/{int(figure_index)}.webp"


def normalize_user_id(raw_user_id: str | None) -> str:
    return slugify(str(raw_user_id or "").strip()) or "guest"


def user_state_path(user_id: str | None) -> Any:
    return USERS_DIR / f"{normalize_user_id(user_id)}.json"


def article_sort_key(article: dict[str, Any]) -> tuple[Any, ...]:
    stamp = article.get("published_at") or article.get("first_seen_local_date") or ""
    return (int(article.get("priority", 999)), stamp, article.get("title", ""))


def empty_resume_state() -> dict[str, Any]:
    return {"article_id": None, "archive_seq": 0, "updated_at": None}


def default_state(user_id: str | None = None) -> dict[str, Any]:
    normalized_user_id = normalize_user_id(user_id)
    now_iso = utc_now_iso()
    return {
        "schema_version": STATE_SCHEMA_VERSION,
        "meta": {
            "user_id": normalized_user_id,
            "display_name": normalized_user_id,
            "created_at": now_iso,
            "last_seen_at": now_iso,
        },
        "article_states": {},
        "saved_images": {},
        "columns": [DEFAULT_ACTIVE_COLUMN, DEFAULT_ARCHIVED_COLUMN],
        "reading": {
            "today": empty_resume_state(),
            "queue": empty_resume_state(),
            "last_seen_archive_seq": 0,
            "last_opened_mode": "today",
        },
    }


def normalize_article_state(raw: Any) -> dict[str, Any]:
    base = {"status": "unread", "note": "", "column": "", "saved_at": None, "handled_at": None}
    if isinstance(raw, dict):
        base.update(
            {
                "status": str(raw.get("status", base["status"]) or base["status"]).strip() or "unread",
                "note": str(raw.get("note", "") or "").strip(),
                "column": str(raw.get("column", "") or "").strip(),
                "saved_at": raw.get("saved_at"),
                "handled_at": raw.get("handled_at"),
            }
        )
    if base["status"] not in {"unread", "viewed", "saved", "dismissed"}:
        base["status"] = "unread"
    return base


def parse_saved_image_key(key: str) -> tuple[str, int]:
    article_id, _, suffix = str(key or "").rpartition(":")
    if not article_id:
        return "", 0
    try:
        return article_id, int(suffix)
    except ValueError:
        return article_id, 0


def normalize_saved_image(raw_key: str, raw_value: Any) -> dict[str, Any] | None:
    if not isinstance(raw_value, dict):
        return None
    article_id = str(raw_value.get("article_id", "")).strip()
    figure_index = raw_value.get("figure_index")
    if not article_id:
        article_id, inferred_index = parse_saved_image_key(raw_key)
        figure_index = inferred_index if figure_index is None else figure_index
    try:
        figure_index = int(figure_index if figure_index is not None else 0)
    except (TypeError, ValueError):
        figure_index = 0
    if not article_id:
        return None
    return {
        "article_id": article_id,
        "figure_index": figure_index,
        "saved_at": raw_value.get("saved_at"),
    }


def normalize_resume(raw: Any) -> dict[str, Any]:
    resume = empty_resume_state()
    if isinstance(raw, dict):
        resume["article_id"] = str(raw.get("article_id", "")).strip() or None
        try:
            resume["archive_seq"] = int(raw.get("archive_seq", 0) or 0)
        except (TypeError, ValueError):
            resume["archive_seq"] = 0
        resume["updated_at"] = raw.get("updated_at")
    return resume


def normalize_state(raw: Any, user_id: str | None = None) -> tuple[dict[str, Any], bool]:
    changed = False
    base = default_state(user_id)
    if not isinstance(raw, dict):
        return base, True

    if "article_states" in raw or "reading" in raw or raw.get("schema_version") == STATE_SCHEMA_VERSION:
        meta = raw.get("meta", {})
        if not isinstance(meta, dict):
            meta = {}
            changed = True
        created_at = meta.get("created_at") or base["meta"]["created_at"]
        last_seen_at = meta.get("last_seen_at") or created_at
        display_name = str(meta.get("display_name", base["meta"]["display_name"])).strip() or base["meta"]["display_name"]
        if meta.get("user_id") != base["meta"]["user_id"]:
            changed = True
        if not meta:
            changed = True
        base["meta"] = {
            "user_id": base["meta"]["user_id"],
            "display_name": display_name,
            "created_at": created_at,
            "last_seen_at": last_seen_at,
        }

        article_states = raw.get("article_states", {})
        if not isinstance(article_states, dict):
            article_states = {}
            changed = True
        for article_id, payload in article_states.items():
            normalized = normalize_article_state(payload)
            base["article_states"][str(article_id)] = normalized
            if normalized != payload:
                changed = True

        saved_images = raw.get("saved_images", {})
        if not isinstance(saved_images, dict):
            saved_images = {}
            changed = True
        for key, payload in saved_images.items():
            normalized = normalize_saved_image(str(key), payload)
            if normalized:
                base["saved_images"][f"{normalized['article_id']}:{normalized['figure_index']}"] = normalized
                if normalized != payload or key != f"{normalized['article_id']}:{normalized['figure_index']}":
                    changed = True

        reading = raw.get("reading", {})
        if not isinstance(reading, dict):
            reading = {}
            changed = True
        base["reading"]["today"] = normalize_resume(reading.get("today"))
        base["reading"]["queue"] = normalize_resume(reading.get("queue"))
        base["reading"]["last_opened_mode"] = (
            str(reading.get("last_opened_mode", "today")).strip() or "today"
        )
        try:
            base["reading"]["last_seen_archive_seq"] = int(reading.get("last_seen_archive_seq", 0) or 0)
        except (TypeError, ValueError):
            base["reading"]["last_seen_archive_seq"] = 0
            changed = True

        columns = raw.get("columns", [])
        if not isinstance(columns, list):
            columns = []
            changed = True
        base["columns"] = [str(item).strip() for item in columns if str(item).strip()]
        for default_column in (DEFAULT_ACTIVE_COLUMN, DEFAULT_ARCHIVED_COLUMN):
            if default_column not in base["columns"]:
                base["columns"].append(default_column)

        if raw.get("schema_version") != STATE_SCHEMA_VERSION:
            changed = True
        return base, changed

    old_articles = raw.get("articles", {})
    if isinstance(old_articles, dict):
        for article_id, payload in old_articles.items():
            base["article_states"][str(article_id)] = normalize_article_state(payload)

    old_saved_images = raw.get("saved_images", {})
    if isinstance(old_saved_images, dict):
        for key, payload in old_saved_images.items():
            normalized = normalize_saved_image(str(key), payload)
            if normalized:
                base["saved_images"][f"{normalized['article_id']}:{normalized['figure_index']}"] = normalized

    old_columns = raw.get("columns", [])
    if isinstance(old_columns, list):
        base["columns"] = [str(item).strip() for item in old_columns if str(item).strip()]
    for default_column in (DEFAULT_ACTIVE_COLUMN, DEFAULT_ARCHIVED_COLUMN):
        if default_column not in base["columns"]:
            base["columns"].append(default_column)

    return base, True


def normalize_articles(raw_articles: Any) -> tuple[list[dict[str, Any]], bool]:
    if not isinstance(raw_articles, list):
        return [], True

    changed = False
    normalized: list[dict[str, Any]] = []
    for raw in raw_articles:
        if not isinstance(raw, dict):
            changed = True
            continue
        article = dict(raw)
        article.setdefault("id", "")
        article.setdefault("doi", "")
        article.setdefault("article_url", "")
        article.setdefault("rss_title", "")
        article.setdefault("title", article.get("rss_title", ""))
        article.setdefault("journal_title", article.get("subscription_name", "Nature"))
        article.setdefault("subscription_id", "")
        article.setdefault("subscription_name", "")
        article.setdefault("rss_url", "")
        article.setdefault("priority", 999)
        article.setdefault("archive_seq", 0)
        article.setdefault("first_seen_at", None)
        article.setdefault("first_seen_local_date", today_local())
        article.setdefault("summary_hydrated_at", None)
        article.setdefault("detail_hydrated_at", None)
        article.setdefault("published_at", None)
        article.setdefault("article_type", "")
        article.setdefault("keywords", [])
        article.setdefault("figure_count", 0)
        article.setdefault("thumbnail_url", None)
        article.setdefault("initial_backfill", False)
        if not article.get("title"):
            article["title"] = article.get("rss_title", "")
            changed = True
        normalized.append(article)

    ordered_oldest = sorted(normalized, key=article_sort_key)
    seqs = [item.get("archive_seq") for item in ordered_oldest]
    if any(not isinstance(seq, int) or seq <= 0 for seq in seqs) or len(set(seqs)) != len(ordered_oldest):
        changed = True
        for archive_seq, article in enumerate(ordered_oldest, start=1):
            article["archive_seq"] = archive_seq

    return sorted(ordered_oldest, key=article_sort_key, reverse=True), changed


def load_subscriptions() -> list[dict[str, Any]]:
    subscriptions = read_json(SUBSCRIPTIONS_PATH, [])
    if subscriptions:
        return subscriptions

    seeds = read_json(RSS_SEED_PATH, [])
    subscriptions = []
    for index, item in enumerate(seeds, start=1):
        url = str(item.get("url", "") if isinstance(item, dict) else item).strip()
        name = str(item.get("name", "") if isinstance(item, dict) else item).strip() or url
        if not url:
            continue
        subscriptions.append(
            {"id": slugify(name), "name": name, "url": url, "priority": index, "last_synced_at": None}
        )
    if not subscriptions:
        subscriptions = [
            {
                "id": "nature-communications",
                "name": "Nature Communications",
                "url": "https://www.nature.com/ncomms.rss",
                "priority": 1,
                "last_synced_at": None,
            }
        ]
    write_json(SUBSCRIPTIONS_PATH, subscriptions)
    return subscriptions


def load_articles() -> list[dict[str, Any]]:
    articles, changed = normalize_articles(read_json(ARTICLES_PATH, []))
    if changed:
        write_json(ARTICLES_PATH, articles)
    return articles


def save_articles(articles: list[dict[str, Any]]) -> None:
    ordered, _ = normalize_articles(articles)
    write_json(ARTICLES_PATH, ordered)


def migrate_legacy_state_if_needed(user_id: str) -> None:
    path = user_state_path(user_id)
    if path.exists():
        return
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    if any(USERS_DIR.glob("*.json")):
        return
    legacy_raw = read_json(STATE_PATH, None)
    if legacy_raw is None:
        return
    legacy_state, _ = normalize_state(legacy_raw, user_id=user_id)
    write_json(path, legacy_state)


def load_state(user_id: str | None = None, touch: bool = False) -> dict[str, Any]:
    normalized_user_id = normalize_user_id(user_id)
    path = user_state_path(normalized_user_id)
    migrate_legacy_state_if_needed(normalized_user_id)
    state, changed = normalize_state(read_json(path, default_state(normalized_user_id)), user_id=normalized_user_id)
    if touch:
        state.setdefault("meta", default_state(normalized_user_id)["meta"])
        state["meta"]["last_seen_at"] = utc_now_iso()
        changed = True
    if changed:
        write_json(path, state)
    return state


def save_state(user_id: str | None, state: dict[str, Any]) -> None:
    normalized_user_id = normalize_user_id(user_id)
    normalized, _ = normalize_state(state, user_id=normalized_user_id)
    write_json(user_state_path(normalized_user_id), normalized)


def list_user_states() -> list[dict[str, Any]]:
    USERS_DIR.mkdir(parents=True, exist_ok=True)
    states: list[dict[str, Any]] = []
    for path in sorted(USERS_DIR.glob("*.json")):
        state, changed = normalize_state(read_json(path, {}), user_id=path.stem)
        if changed:
            write_json(path, state)
        states.append(state)
    if states:
        return states
    legacy_raw = read_json(STATE_PATH, None)
    if legacy_raw is not None:
        legacy_state, _ = normalize_state(legacy_raw, user_id="legacy")
        states.append(legacy_state)
    return states


def initialize_if_empty() -> None:
    subscriptions = load_subscriptions()
    if not load_articles() and subscriptions:
        sync_subscriptions()


def get_article_state(state: dict[str, Any], article_id: str) -> dict[str, Any]:
    return normalize_article_state(state.get("article_states", {}).get(article_id, {}))


def get_saved_image_index(state: dict[str, Any], article_id: str) -> list[dict[str, Any]]:
    return [
        item
        for item in state.get("saved_images", {}).values()
        if item.get("article_id") == article_id
    ]


def bucket_for_article(article: dict[str, Any], state: dict[str, Any], day: str) -> str | None:
    article_state = get_article_state(state, article["id"])
    if article_state["status"] in {"viewed", "saved", "dismissed"}:
        return None
    if article.get("first_seen_local_date") == day and not article.get("initial_backfill"):
        return "today"
    return "queue"


def merge_article_with_state(article: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(article)
    merged["state"] = get_article_state(state, article["id"])
    merged["saved_image_count"] = len(get_saved_image_index(state, article["id"]))
    return merged


def max_archive_seq(articles: list[dict[str, Any]]) -> int:
    return max([int(article.get("archive_seq", 0) or 0) for article in articles] or [0])


def read_detail_cache(article_id: str) -> dict[str, Any]:
    return read_json(article_cache_path(article_id), {})


def normalize_figure_payload(article_id: str, figure: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(figure or {})
    figure_index = int(normalized.get("index", 0) or 0)
    normalized["index"] = figure_index
    normalized["thumbnail_url"] = thumbnail_public_url(article_id, figure_index)
    return normalized


def normalize_figures(article_id: str, figures: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return [normalize_figure_payload(article_id, figure) for figure in (figures or [])]


def resolve_figure_image_url(article_id: str, figure_index: int) -> str | None:
    detail = read_detail_cache(article_id)
    for figure in detail.get("figures", []):
        try:
            current_index = int(figure.get("index", -1))
        except (TypeError, ValueError):
            current_index = -1
        if current_index == int(figure_index):
            return str(figure.get("image_url", "")).strip() or None
    return None


def ensure_thumbnail_cached(article_id: str, figure_index: int) -> Any | None:
    target = thumbnail_cache_path(article_id, figure_index)
    if target.exists():
        return target

    image_url = resolve_figure_image_url(article_id, figure_index)
    if not image_url:
        return None

    response = requests.get(image_url, timeout=25)
    response.raise_for_status()

    image = Image.open(io.BytesIO(response.content))
    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGBA")

    background = Image.new("RGB", image.size, "#ffffff")
    alpha = image.getchannel("A") if "A" in image.getbands() else None
    background.paste(image.convert("RGB") if alpha is None else image, mask=alpha)
    background.thumbnail((THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE), Image.Resampling.LANCZOS)

    target.parent.mkdir(parents=True, exist_ok=True)
    background.save(target, format="WEBP", quality=84, method=6)
    return target


def prefetch_article_detail(article: dict[str, Any]) -> dict[str, Any]:
    figures = discover_figure_urls(article["doi"])
    hydrated_at = utc_now_iso()
    detail = {
        "id": article["id"],
        "doi": article["doi"],
        "article_url": article["article_url"],
        "source_urls": {
            "article": article["article_url"],
            "figures": [figure["image_url"] for figure in figures],
        },
        "figures": normalize_figures(article["id"], figures),
        "detail_hydrated_at": hydrated_at,
    }
    write_json(article_cache_path(article["id"]), detail)
    article["detail_hydrated_at"] = hydrated_at
    article["figure_count"] = len(detail["figures"])
    article["thumbnail_url"] = detail["figures"][0]["thumbnail_url"] if detail["figures"] else None
    return detail


def backfill_missing_article_details(
    articles: list[dict[str, Any]],
    limit: int = 0,
) -> tuple[list[dict[str, Any]], int]:
    if limit == 0:
        return sorted(articles, key=article_sort_key, reverse=True), 0
    if limit is not None and limit < 0:
        limit = 0
    updated = 0
    for article in sorted(articles, key=article_sort_key, reverse=True):
        cache = read_detail_cache(article["id"])
        if article.get("detail_hydrated_at") and cache.get("detail_hydrated_at"):
            continue
        prefetch_article_detail(article)
        updated += 1
        if limit and updated >= limit:
            break
    return sorted(articles, key=article_sort_key, reverse=True), updated


def sync_subscriptions(single_url: str | None = None, backfill_missing_limit: int = 0) -> dict[str, Any]:
    with LOCK:
        subscriptions = load_subscriptions()
        articles = load_articles()
        article_map = {article["id"]: article for article in articles}
        now_iso = utc_now_iso()
        local_today = today_local()
        created = 0
        skipped_existing = 0
        next_seq = max_archive_seq(articles) + 1

        targets = subscriptions
        if single_url:
            targets = [item for item in subscriptions if item.get("url") == single_url]
            if not targets:
                appended = {
                    "id": slugify(single_url),
                    "name": single_url,
                    "url": single_url,
                    "priority": len(subscriptions) + 1,
                    "last_synced_at": None,
                }
                subscriptions.append(appended)
                targets = [appended]

        for subscription in targets:
            initial_sync = not subscription.get("last_synced_at")
            root = fetch_xml(subscription["url"])
            for item in parse_rss_items(root):
                article_id = article_id_from_doi(item["doi"])
                existing = article_map.get(article_id)
                if existing:
                    skipped_existing += 1
                    existing["priority"] = subscription.get("priority", existing.get("priority", 999))
                    existing["subscription_name"] = subscription["name"]
                    existing["subscription_id"] = subscription["id"]
                    existing["rss_url"] = subscription["url"]
                    if not existing.get("journal_title"):
                        existing["journal_title"] = item["journal_title"] or subscription["name"]
                    continue

                summary = fetch_article_summary(item["article_url"], rss_title=item["title"], doi=item["doi"])
                if not should_include_article(summary.get("title", ""), summary.get("article_type", "")):
                    continue

                article = {
                    "id": article_id,
                    "archive_seq": next_seq,
                    "doi": item["doi"],
                    "article_url": item["article_url"],
                    "rss_title": item["title"],
                    "title": item["title"],
                    "journal_title": item["journal_title"] or subscription["name"],
                    "subscription_id": subscription["id"],
                    "subscription_name": subscription["name"],
                    "rss_url": subscription["url"],
                    "priority": subscription.get("priority", 999),
                    "first_seen_at": now_iso,
                    "first_seen_local_date": local_today,
                    "summary_hydrated_at": now_iso,
                    "detail_hydrated_at": None,
                    "published_at": None,
                    "article_type": "",
                    "keywords": [],
                    "figure_count": 0,
                    "thumbnail_url": None,
                    "initial_backfill": False,
                }
                article.update(summary)
                publish_date = article.get("published_at")
                article["initial_backfill"] = bool(initial_sync and publish_date and publish_date != local_today)
                prefetch_article_detail(article)
                article_map[article_id] = article
                next_seq += 1
                created += 1

            subscription["last_synced_at"] = now_iso

        ordered = sorted(article_map.values(), key=article_sort_key, reverse=True)
        ordered, backfilled = backfill_missing_article_details(ordered, limit=backfill_missing_limit)
        save_articles(ordered)
        write_json(SUBSCRIPTIONS_PATH, subscriptions)
        return {
            "created": created,
            "skipped_existing": skipped_existing,
            "backfilled": backfilled,
            "count": len(ordered),
            "synced_at": now_iso,
            "latest_archive_seq": max_archive_seq(ordered),
        }


def hydrate_article_details(
    article_id: str,
    state: dict[str, Any],
    hydrate_missing: bool = False,
) -> dict[str, Any] | None:
    articles = load_articles()
    article_map = {item["id"]: item for item in articles}
    article = article_map.get(article_id)
    if not article:
        return None

    cache_path = article_cache_path(article_id)
    detail = read_json(cache_path, {})
    if hydrate_missing and (not detail or not detail.get("detail_hydrated_at")):
        detail = prefetch_article_detail(article)
        save_articles(sorted(article_map.values(), key=article_sort_key, reverse=True))

    merged = merge_article_with_state(article, state)
    merged["figures"] = normalize_figures(article_id, detail.get("figures", []))
    merged["detail_hydrated_at"] = detail.get("detail_hydrated_at")
    merged["source_urls"] = detail.get("source_urls", {})
    return merged


def unread_bucket_articles(mode: str, articles: list[dict[str, Any]], state: dict[str, Any], day: str) -> list[dict[str, Any]]:
    return [
        article
        for article in sorted(articles, key=article_sort_key, reverse=True)
        if bucket_for_article(article, state, day) == mode
    ]


def resolve_resume_index(mode: str, articles: list[dict[str, Any]], state: dict[str, Any]) -> int:
    reading = state.get("reading", {}).get(mode, {})
    article_id = reading.get("article_id")
    if article_id:
        for index, article in enumerate(articles):
            if article["id"] == article_id:
                return index
    archive_seq = reading.get("archive_seq") or 0
    if archive_seq:
        for index, article in enumerate(articles):
            if int(article.get("archive_seq", 0) or 0) == int(archive_seq):
                return index
    return 0


def update_resume_anchor(state: dict[str, Any], mode: str, article: dict[str, Any] | None) -> None:
    reading = state.setdefault("reading", default_state(state.get("meta", {}).get("user_id"))["reading"])
    reading.setdefault(mode, empty_resume_state())
    if article:
        reading[mode] = {
            "article_id": article["id"],
            "archive_seq": int(article.get("archive_seq", 0) or 0),
            "updated_at": utc_now_iso(),
        }
        reading["last_opened_mode"] = mode
    else:
        reading[mode] = empty_resume_state()


def get_feed(user_id: str | None, mode: str, offset: int = 0, limit: int = DEFAULT_BATCH_SIZE) -> dict[str, Any]:
    initialize_if_empty()
    limit = max(1, min(limit, MAX_BATCH_SIZE))
    state = load_state(user_id, touch=offset == 0)
    day = today_local()
    articles = unread_bucket_articles(mode, load_articles(), state, day)
    resume_index = resolve_resume_index(mode, articles, state)
    visible = articles[resume_index:]
    page = visible[offset : offset + limit]
    if offset == 0:
        update_resume_anchor(state, mode, visible[0] if visible else None)
        save_state(user_id, state)
    return {
        "mode": mode,
        "offset": offset,
        "limit": limit,
        "total": len(visible),
        "ids": [article["id"] for article in page],
        "has_more": offset + limit < len(visible),
        "resume_index": resume_index,
    }


def get_article_details(user_id: str | None, article_ids: list[str]) -> list[dict[str, Any]]:
    state = load_state(user_id)
    details = []
    for article_id in article_ids[:MAX_BATCH_SIZE]:
        detail = hydrate_article_details(article_id, state, hydrate_missing=False)
        if detail:
            details.append(detail)
    return details


def next_bucket_anchor(
    state: dict[str, Any],
    mode: str,
    current_article_id: str,
    articles: list[dict[str, Any]],
    day: str,
) -> None:
    bucket_articles = unread_bucket_articles(mode, articles, state, day)
    if not bucket_articles:
        update_resume_anchor(state, mode, None)
        return
    current_index = next(
        (index for index, article in enumerate(bucket_articles) if article["id"] == current_article_id),
        None,
    )
    if current_index is None:
        update_resume_anchor(state, mode, bucket_articles[0])
        return
    next_index = min(current_index, len(bucket_articles) - 1)
    update_resume_anchor(state, mode, bucket_articles[next_index] if bucket_articles else None)


def set_article_action(
    user_id: str | None,
    article_id: str,
    action: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = payload or {}
    with LOCK:
        state = load_state(user_id, touch=True)
        articles = load_articles()
        article_map = {item["id"]: item for item in articles}
        article = article_map.get(article_id)
        now_iso = utc_now_iso()
        day = today_local()
        current_mode = bucket_for_article(article, state, day) if article else None

        article_state = state.setdefault("article_states", {}).setdefault(article_id, {})
        article_state.update(get_article_state(state, article_id))

        if action == "viewed":
            if article_state.get("status") != "saved":
                article_state["status"] = "viewed"
            article_state["handled_at"] = now_iso
        elif action == "dismissed":
            article_state["status"] = "dismissed"
            article_state["handled_at"] = now_iso
        elif action == "saved":
            article_state["status"] = "saved"
            article_state["column"] = article_state.get("column") or DEFAULT_ACTIVE_COLUMN
            article_state["saved_at"] = now_iso
            article_state["handled_at"] = now_iso
            columns = state.setdefault("columns", default_state(user_id)["columns"])
            for default_column in (DEFAULT_ACTIVE_COLUMN, DEFAULT_ARCHIVED_COLUMN):
                if default_column not in columns:
                    columns.append(default_column)
        elif action == "unsave":
            article_state["status"] = "viewed"
            article_state["saved_at"] = None
            article_state["handled_at"] = now_iso
        elif action == "note":
            article_state["note"] = str(payload.get("note", "")).strip()
        elif action == "column":
            column_name = str(payload.get("column", "")).strip()
            article_state["column"] = column_name
            columns = state.setdefault("columns", [])
            if column_name and column_name not in columns:
                columns.append(column_name)
        elif action == "reset":
            article_state["status"] = "unread"
            article_state["saved_at"] = None
            article_state["handled_at"] = None
        else:
            raise ValueError(f"Unsupported action: {action}")

        if action in {"viewed", "dismissed", "saved"} and article:
            last_seen = int(
                state.setdefault("reading", default_state(user_id)["reading"]).get("last_seen_archive_seq", 0) or 0
            )
            state["reading"]["last_seen_archive_seq"] = max(last_seen, int(article.get("archive_seq", 0) or 0))
            if current_mode:
                next_bucket_anchor(state, current_mode, article_id, articles, day)
        elif action == "reset" and article:
            mode_after = bucket_for_article(article, state, day)
            if mode_after:
                update_resume_anchor(state, mode_after, article)

        save_state(user_id, state)
    return get_overview(user_id)


def toggle_saved_image(user_id: str | None, article_id: str, figure_index: int, image_url: str) -> dict[str, Any]:
    with LOCK:
        state = load_state(user_id, touch=True)
        key = f"{article_id}:{figure_index}"
        saved_images = state.setdefault("saved_images", {})
        if key in saved_images:
            saved_images.pop(key, None)
            saved = False
        else:
            saved_images[key] = {
                "article_id": article_id,
                "figure_index": figure_index,
                "saved_at": utc_now_iso(),
            }
            saved = True
        save_state(user_id, state)
    overview = get_overview(user_id)
    overview["saved"] = saved
    overview["key"] = key
    return overview


def get_recent_image_tiles(
    user_id: str | None,
    offset: int = 0,
    limit: int = DEFAULT_IMAGE_BATCH,
    journal: str | None = None,
    saved_only: bool = False,
) -> dict[str, Any]:
    initialize_if_empty()
    state = load_state(user_id)
    tiles: list[dict[str, Any]] = []

    for article in sorted(load_articles(), key=article_sort_key, reverse=True):
        if journal and journal != "all" and article.get("journal_title") != journal:
            continue
        detail = hydrate_article_details(article["id"], state, hydrate_missing=False)
        if not detail or not detail.get("detail_hydrated_at"):
            continue
        for figure in detail.get("figures", []):
            key = f"{article['id']}:{figure['index']}"
            saved = key in state.get("saved_images", {})
            if saved_only and not saved:
                continue
            tiles.append(
                {
                    "key": key,
                    "article_id": article["id"],
                    "figure_index": figure["index"],
                    "image_url": figure["image_url"],
                    "thumbnail_url": figure.get("thumbnail_url") or thumbnail_public_url(article["id"], figure["index"]),
                    "title": figure["title"],
                    "article_title": article.get("title"),
                    "journal_title": article.get("journal_title"),
                    "published_at": article.get("published_at"),
                    "article_url": article.get("article_url"),
                    "saved": saved,
                }
            )

    page = tiles[offset : offset + limit]
    return {
        "items": page,
        "offset": offset,
        "limit": limit,
        "total": len(tiles),
        "has_more": offset + limit < len(tiles),
    }


def get_saved_papers(user_id: str | None, query: str = "") -> list[dict[str, Any]]:
    state = load_state(user_id)
    query = query.strip().lower()
    saved: list[dict[str, Any]] = []
    for article in load_articles():
        article_state = get_article_state(state, article["id"])
        if article_state.get("status") != "saved":
            continue
        merged = merge_article_with_state(article, state)
        if query:
            haystack = " ".join(
                [article.get("title", ""), article.get("journal_title", ""), article_state.get("note", "")]
            ).lower()
            if query not in haystack:
                continue
        saved.append(merged)
    return sorted(saved, key=lambda item: item["state"].get("saved_at") or "", reverse=True)


def resolve_saved_figure(article_id: str, figure_index: int) -> dict[str, Any] | None:
    detail = read_detail_cache(article_id)
    for figure in detail.get("figures", []):
        if int(figure.get("index", -1)) == int(figure_index):
            return figure
    return None


def get_saved_images(user_id: str | None) -> list[dict[str, Any]]:
    state = load_state(user_id)
    article_map = {item["id"]: item for item in load_articles()}
    images: list[dict[str, Any]] = []
    for key, item in state.get("saved_images", {}).items():
        article = article_map.get(item["article_id"])
        if not article:
            continue
        figure = resolve_saved_figure(item["article_id"], item["figure_index"])
        image_url = figure.get("image_url") if figure else None
        if not image_url:
            continue
        images.append(
            {
                "key": key,
                "image_url": image_url,
                "thumbnail_url": figure.get("thumbnail_url") if figure else thumbnail_public_url(item["article_id"], item["figure_index"]),
                "title": figure.get("title") if figure else None,
                "saved_at": item.get("saved_at"),
                "article_id": item["article_id"],
                "figure_index": item["figure_index"],
                "article_title": article.get("title"),
                "journal_title": article.get("journal_title"),
                "published_at": article.get("published_at"),
                "article_url": article.get("article_url"),
            }
        )
    return sorted(images, key=lambda item: item.get("saved_at") or "", reverse=True)


def add_subscription(user_id: str | None, name: str, url: str) -> dict[str, Any]:
    with LOCK:
        subscriptions = [item for item in load_subscriptions() if item["url"] != url]
        subscriptions.append(
            {
                "id": slugify(name or url),
                "name": name.strip() or url.strip(),
                "url": url.strip(),
                "priority": len(subscriptions) + 1,
                "last_synced_at": None,
            }
        )
        write_json(SUBSCRIPTIONS_PATH, subscriptions)
    sync_subscriptions(single_url=url)
    return get_overview(user_id)


def reorder_subscription(user_id: str | None, subscription_id: str, direction: str) -> dict[str, Any]:
    with LOCK:
        subscriptions = load_subscriptions()
        index = next((idx for idx, item in enumerate(subscriptions) if item["id"] == subscription_id), None)
        if index is None:
            return get_overview(user_id)
        if direction == "up" and index > 0:
            subscriptions[index - 1], subscriptions[index] = subscriptions[index], subscriptions[index - 1]
        elif direction == "down" and index < len(subscriptions) - 1:
            subscriptions[index + 1], subscriptions[index] = subscriptions[index], subscriptions[index + 1]
        for priority, item in enumerate(subscriptions, start=1):
            item["priority"] = priority
        write_json(SUBSCRIPTIONS_PATH, subscriptions)

        priority_map = {item["id"]: item["priority"] for item in subscriptions}
        articles = load_articles()
        for article in articles:
            article["priority"] = priority_map.get(article.get("subscription_id"), article.get("priority", 999))
        save_articles(sorted(articles, key=article_sort_key, reverse=True))
    return get_overview(user_id)


def delete_subscription(user_id: str | None, subscription_id: str) -> dict[str, Any]:
    with LOCK:
        subscriptions = [item for item in load_subscriptions() if item["id"] != subscription_id]
        for priority, item in enumerate(subscriptions, start=1):
            item["priority"] = priority
        write_json(SUBSCRIPTIONS_PATH, subscriptions)
    return get_overview(user_id)


def get_overview(user_id: str | None) -> dict[str, Any]:
    initialize_if_empty()
    state = load_state(user_id, touch=True)
    articles = load_articles()
    day = today_local()
    today_total = len(
        [
            article
            for article in articles
            if article.get("first_seen_local_date") == day and not article.get("initial_backfill")
        ]
    )
    today_pending = len([article for article in articles if bucket_for_article(article, state, day) == "today"])
    queue_pending = len([article for article in articles if bucket_for_article(article, state, day) == "queue"])
    saved_papers = len(get_saved_papers(user_id))
    saved_images = len(get_saved_images(user_id))
    viewed_count = len(
        [item for item in state.get("article_states", {}).values() if item.get("status") == "viewed"]
    )
    journals = sorted({article.get("journal_title") for article in articles if article.get("journal_title")})
    image_journals = sorted(
        {
            article.get("journal_title")
            for article in articles
            if article.get("journal_title") and int(article.get("figure_count", 0) or 0) > 0
        }
    )
    subscriptions = sorted(load_subscriptions(), key=lambda item: item.get("priority", 999))
    last_synced_at = max([item.get("last_synced_at") for item in subscriptions if item.get("last_synced_at")] or [None])
    reading = state.get("reading", {})
    return {
        "counts": {
            "today": today_pending,
            "queue": queue_pending,
            "savedPapers": saved_papers,
            "savedImages": saved_images,
        },
        "progress": {"todayHandled": max(today_total - today_pending, 0), "todayTotal": today_total},
        "stats": {
            "browsedArticles": viewed_count,
            "savedPapers": saved_papers,
            "savedImages": saved_images,
            "deepReadCount": 0,
        },
        "subscriptions": subscriptions,
        "journals": journals,
        "imageJournals": image_journals,
        "lastSyncedAt": last_synced_at,
        "archive": {
            "articleCount": len(articles),
            "latestArchiveSeq": max_archive_seq(articles),
        },
        "columns": state.get("columns", []),
        "reading": {
            "today": reading.get("today", empty_resume_state()),
            "queue": reading.get("queue", empty_resume_state()),
            "lastSeenArchiveSeq": reading.get("last_seen_archive_seq", 0),
        },
        "user": state.get("meta", {}),
    }


def summarize_user_state(state: dict[str, Any]) -> dict[str, Any]:
    meta = state.get("meta", {})
    article_states = state.get("article_states", {})
    reading = state.get("reading", {})
    return {
        "userId": meta.get("user_id"),
        "displayName": meta.get("display_name") or meta.get("user_id"),
        "createdAt": meta.get("created_at"),
        "lastSeenAt": meta.get("last_seen_at"),
        "savedPaperCount": len([item for item in article_states.values() if item.get("status") == "saved"]),
        "savedImageCount": len(state.get("saved_images", {})),
        "viewedCount": len([item for item in article_states.values() if item.get("status") == "viewed"]),
        "todayResume": reading.get("today", empty_resume_state()),
        "queueResume": reading.get("queue", empty_resume_state()),
    }


def get_admin_dashboard() -> dict[str, Any]:
    initialize_if_empty()
    articles = load_articles()
    subscriptions = sorted(load_subscriptions(), key=lambda item: item.get("priority", 999))
    user_states = list_user_states()
    caches = {article["id"]: read_detail_cache(article["id"]) for article in articles}
    detail_ready = [
        article
        for article in articles
        if article.get("detail_hydrated_at") and caches.get(article["id"], {}).get("detail_hydrated_at")
    ]
    missing_detail = [
        {
            "id": article["id"],
            "archiveSeq": article.get("archive_seq"),
            "title": article.get("title"),
            "journalTitle": article.get("journal_title"),
            "publishedAt": article.get("published_at"),
            "articleUrl": article.get("article_url"),
        }
        for article in articles
        if not article.get("detail_hydrated_at") or not caches.get(article["id"], {}).get("detail_hydrated_at")
    ]
    total_figures = sum(len(caches.get(article["id"], {}).get("figures", [])) for article in articles)
    latest_synced_at = max([item.get("last_synced_at") for item in subscriptions if item.get("last_synced_at")] or [None])
    return {
        "archive": {
            "articleCount": len(articles),
            "detailReadyCount": len(detail_ready),
            "missingDetailCount": len(missing_detail),
            "detailProgress": round((len(detail_ready) / len(articles)) * 100, 2) if articles else 100.0,
            "latestArchiveSeq": max_archive_seq(articles),
            "figureCount": total_figures,
            "lastSyncedAt": latest_synced_at,
        },
        "subscriptions": subscriptions,
        "users": {
            "count": len(user_states),
            "items": [summarize_user_state(state) for state in user_states],
        },
        "missingDetails": missing_detail[:50],
    }
