from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Any
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


def article_sort_key(article: dict[str, Any]) -> tuple[Any, ...]:
    stamp = article.get("published_at") or article.get("first_seen_local_date") or ""
    return (int(article.get("priority", 999)), stamp, article.get("title", ""))


def default_state() -> dict[str, Any]:
    return {"articles": {}, "saved_images": {}, "ui": {"today_index": 0, "queue_index": 0}}


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
    return read_json(ARTICLES_PATH, [])


def save_articles(articles: list[dict[str, Any]]) -> None:
    write_json(ARTICLES_PATH, articles)


def load_state() -> dict[str, Any]:
    state = read_json(STATE_PATH, default_state())
    state.setdefault("articles", {})
    state.setdefault("saved_images", {})
    state.setdefault("ui", {"today_index": 0, "queue_index": 0})
    return state


def save_state(state: dict[str, Any]) -> None:
    write_json(STATE_PATH, state)


def initialize_if_empty() -> None:
    subscriptions = load_subscriptions()
    if not load_articles() and subscriptions:
        sync_subscriptions()


def get_article_state(state: dict[str, Any], article_id: str) -> dict[str, Any]:
    base = {"status": "unread", "note": "", "saved_at": None, "handled_at": None}
    base.update(state.get("articles", {}).get(article_id, {}))
    return base


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
    merged["saved_image_count"] = len(
        [key for key in state.get("saved_images", {}) if key.startswith(f"{article['id']}:")]
    )
    return merged


def sync_subscriptions(single_url: str | None = None) -> dict[str, Any]:
    with LOCK:
        subscriptions = load_subscriptions()
        articles = load_articles()
        article_map = {article["id"]: article for article in articles}
        now_iso = utc_now_iso()
        local_today = today_local()
        created = 0
        updated = 0

        targets = subscriptions
        if single_url:
            targets = [item for item in subscriptions if item.get("url") == single_url]
            if not targets:
                targets = [
                    {
                        "id": slugify(single_url),
                        "name": single_url,
                        "url": single_url,
                        "priority": len(subscriptions) + 1,
                        "last_synced_at": None,
                    }
                ]

        for subscription in targets:
            initial_sync = not subscription.get("last_synced_at")
            root = fetch_xml(subscription["url"])
            for item in parse_rss_items(root):
                article_id = article_id_from_doi(item["doi"])
                article = article_map.get(article_id)
                is_new = article is None
                if is_new:
                    created += 1
                    article = {
                        "id": article_id,
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
                        "summary_hydrated_at": None,
                        "detail_hydrated_at": None,
                        "published_at": None,
                        "article_type": "",
                        "keywords": [],
                        "figure_count": 0,
                        "thumbnail_url": None,
                        "initial_backfill": False,
                    }
                else:
                    updated += 1

                if not article.get("summary_hydrated_at"):
                    summary = fetch_article_summary(item["article_url"], rss_title=item["title"], doi=item["doi"])
                    if not should_include_article(summary.get("title", ""), summary.get("article_type", "")):
                        article_map.pop(article_id, None)
                        continue
                    article.update(summary)
                    article["summary_hydrated_at"] = now_iso
                    publish_date = article.get("published_at")
                    article["initial_backfill"] = bool(initial_sync and publish_date and publish_date != local_today)

                article["priority"] = subscription.get("priority", article.get("priority", 999))
                article["subscription_name"] = subscription["name"]
                article["subscription_id"] = subscription["id"]
                article["rss_url"] = subscription["url"]
                article["journal_title"] = article.get("journal_title") or item["journal_title"] or subscription["name"]
                article_map[article_id] = article

            if any(existing.get("id") == subscription["id"] for existing in subscriptions):
                subscription["last_synced_at"] = now_iso

        ordered = sorted(article_map.values(), key=article_sort_key, reverse=True)
        save_articles(ordered)
        write_json(SUBSCRIPTIONS_PATH, subscriptions)
        return {"created": created, "updated": updated, "count": len(ordered), "synced_at": now_iso}


def hydrate_article_details(article_id: str, state: dict[str, Any]) -> dict[str, Any] | None:
    articles = load_articles()
    article_map = {item["id"]: item for item in articles}
    article = article_map.get(article_id)
    if not article:
        return None

    cache_path = article_cache_path(article_id)
    detail = read_json(cache_path, {})
    if not detail or not detail.get("detail_hydrated_at"):
        figures = discover_figure_urls(article["doi"])
        detail = {"id": article_id, "figures": figures, "detail_hydrated_at": utc_now_iso()}
        write_json(cache_path, detail)
        article["detail_hydrated_at"] = detail["detail_hydrated_at"]
        article["figure_count"] = len(figures)
        article["thumbnail_url"] = figures[0]["image_url"] if figures else None
        save_articles(sorted(article_map.values(), key=article_sort_key, reverse=True))

    merged = merge_article_with_state(article, state)
    merged["figures"] = detail.get("figures", [])
    merged["detail_hydrated_at"] = detail.get("detail_hydrated_at")
    return merged


def get_feed(mode: str, offset: int = 0, limit: int = DEFAULT_BATCH_SIZE) -> dict[str, Any]:
    initialize_if_empty()
    limit = max(1, min(limit, MAX_BATCH_SIZE))
    state = load_state()
    day = today_local()
    articles = [
        article
        for article in sorted(load_articles(), key=article_sort_key, reverse=True)
        if bucket_for_article(article, state, day) == mode
    ]
    page = articles[offset : offset + limit]
    return {
        "mode": mode,
        "offset": offset,
        "limit": limit,
        "total": len(articles),
        "ids": [article["id"] for article in page],
        "has_more": offset + limit < len(articles),
    }


def get_article_details(article_ids: list[str]) -> list[dict[str, Any]]:
    state = load_state()
    details = []
    for article_id in article_ids[:MAX_BATCH_SIZE]:
        detail = hydrate_article_details(article_id, state)
        if detail:
            details.append(detail)
    return details


def set_article_action(article_id: str, action: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = payload or {}
    with LOCK:
        state = load_state()
        article_state = state["articles"].setdefault(article_id, {})
        now_iso = utc_now_iso()
        if action == "viewed":
            article_state["status"] = "viewed"
            article_state["handled_at"] = now_iso
        elif action == "dismissed":
            article_state["status"] = "dismissed"
            article_state["handled_at"] = now_iso
        elif action == "saved":
            article_state["status"] = "saved"
            article_state["saved_at"] = now_iso
            article_state["handled_at"] = now_iso
        elif action == "unsave":
            article_state["status"] = "viewed"
            article_state["saved_at"] = None
            article_state["handled_at"] = now_iso
        elif action == "note":
            article_state["note"] = str(payload.get("note", "")).strip()
        elif action == "reset":
            article_state["status"] = "unread"
            article_state["saved_at"] = None
            article_state["handled_at"] = None
        else:
            raise ValueError(f"Unsupported action: {action}")
        save_state(state)
    return get_overview()


def toggle_saved_image(article_id: str, figure_index: int, image_url: str) -> dict[str, Any]:
    with LOCK:
        state = load_state()
        key = f"{article_id}:{figure_index}"
        saved_images = state.setdefault("saved_images", {})
        if key in saved_images:
            saved_images.pop(key, None)
            saved = False
        else:
            saved_images[key] = {
                "article_id": article_id,
                "figure_index": figure_index,
                "image_url": image_url,
                "saved_at": utc_now_iso(),
            }
            saved = True
        save_state(state)
    overview = get_overview()
    overview["saved"] = saved
    overview["key"] = key
    return overview


def get_recent_image_tiles(offset: int = 0, limit: int = DEFAULT_IMAGE_BATCH, journal: str | None = None, saved_only: bool = False) -> dict[str, Any]:
    initialize_if_empty()
    state = load_state()
    cutoff = datetime.now(TZ).date() - timedelta(days=IMAGE_LOOKBACK_DAYS)
    tiles: list[dict[str, Any]] = []

    for article in sorted(load_articles(), key=article_sort_key, reverse=True):
        published_at = article.get("published_at")
        if published_at:
            try:
                if datetime.fromisoformat(published_at).date() < cutoff:
                    continue
            except ValueError:
                pass
        if journal and journal != "all" and article.get("journal_title") != journal:
            continue
        detail = hydrate_article_details(article["id"], state)
        if not detail:
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
                    "title": figure["title"],
                    "article_title": article.get("title"),
                    "journal_title": article.get("journal_title"),
                    "published_at": article.get("published_at"),
                    "article_url": article.get("article_url"),
                    "saved": saved,
                }
            )
            if len(tiles) >= offset + limit:
                break
        if len(tiles) >= offset + limit:
            break

    page = tiles[offset : offset + limit]
    return {"items": page, "offset": offset, "limit": limit, "total": len(tiles), "has_more": offset + limit < len(tiles)}


def get_saved_papers(query: str = "") -> list[dict[str, Any]]:
    state = load_state()
    query = query.strip().lower()
    saved: list[dict[str, Any]] = []
    for article in load_articles():
        article_state = get_article_state(state, article["id"])
        if article_state.get("status") != "saved":
            continue
        merged = merge_article_with_state(article, state)
        if query:
            haystack = " ".join([article.get("title", ""), article.get("journal_title", ""), article_state.get("note", "")]).lower()
            if query not in haystack:
                continue
        saved.append(merged)
    return sorted(saved, key=lambda item: item["state"].get("saved_at") or "", reverse=True)


def get_saved_images() -> list[dict[str, Any]]:
    state = load_state()
    article_map = {item["id"]: item for item in load_articles()}
    images: list[dict[str, Any]] = []
    for key, item in state.get("saved_images", {}).items():
        article = article_map.get(item["article_id"])
        if not article:
            continue
        images.append(
            {
                "key": key,
                "image_url": item["image_url"],
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


def add_subscription(name: str, url: str) -> dict[str, Any]:
    with LOCK:
        subscriptions = [item for item in load_subscriptions() if item["url"] != url]
        subscriptions.append({"id": slugify(name or url), "name": name.strip() or url.strip(), "url": url.strip(), "priority": len(subscriptions) + 1, "last_synced_at": None})
        write_json(SUBSCRIPTIONS_PATH, subscriptions)
    sync_subscriptions(single_url=url)
    return get_overview()


def reorder_subscription(subscription_id: str, direction: str) -> dict[str, Any]:
    with LOCK:
        subscriptions = load_subscriptions()
        index = next((idx for idx, item in enumerate(subscriptions) if item["id"] == subscription_id), None)
        if index is None:
            return get_overview()
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
    return get_overview()


def delete_subscription(subscription_id: str) -> dict[str, Any]:
    with LOCK:
        subscriptions = [item for item in load_subscriptions() if item["id"] != subscription_id]
        for priority, item in enumerate(subscriptions, start=1):
            item["priority"] = priority
        write_json(SUBSCRIPTIONS_PATH, subscriptions)
    return get_overview()


def get_overview() -> dict[str, Any]:
    initialize_if_empty()
    state = load_state()
    articles = load_articles()
    day = today_local()
    today_total = len([article for article in articles if article.get("first_seen_local_date") == day and not article.get("initial_backfill")])
    today_pending = len([article for article in articles if bucket_for_article(article, state, day) == "today"])
    queue_pending = len([article for article in articles if bucket_for_article(article, state, day) == "queue"])
    saved_papers = len(get_saved_papers())
    saved_images = len(get_saved_images())
    viewed_count = len([item for item in state.get("articles", {}).values() if item.get("status") == "viewed"])
    journals = sorted({article.get("journal_title") for article in articles if article.get("journal_title")})
    subscriptions = sorted(load_subscriptions(), key=lambda item: item.get("priority", 999))
    last_synced_at = max([item.get("last_synced_at") for item in subscriptions if item.get("last_synced_at")] or [None])
    return {
        "counts": {"today": today_pending, "queue": queue_pending, "savedPapers": saved_papers, "savedImages": saved_images},
        "progress": {"todayHandled": max(today_total - today_pending, 0), "todayTotal": today_total},
        "stats": {"browsedArticles": viewed_count, "savedPapers": saved_papers, "savedImages": saved_images, "deepReadCount": 0},
        "subscriptions": subscriptions,
        "journals": journals,
        "lastSyncedAt": last_synced_at,
    }
