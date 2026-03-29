from __future__ import annotations

from flask import Flask, jsonify, request

from backend.service import (
    add_subscription,
    delete_subscription,
    get_article_details,
    get_feed,
    get_overview,
    get_recent_image_tiles,
    get_saved_images,
    get_saved_papers,
    reorder_subscription,
    set_article_action,
    sync_subscriptions,
    toggle_saved_image,
)


app = Flask(__name__, static_folder="static", static_url_path="/static")


def safe_int(value, default: int = 0) -> int:
    try:
        if value is None:
            return default
        text = str(value).strip()
        if not text or text.lower() in {"undefined", "null", "nan"}:
            return default
        return int(float(text))
    except (TypeError, ValueError):
        return default


@app.after_request
def disable_cache(response):
    if request.path == "/" or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.get("/api/bootstrap")
def bootstrap():
    return jsonify(get_overview())


@app.post("/api/sync")
def sync():
    payload = request.get_json(silent=True) or {}
    rss_url = str(payload.get("rssUrl", "")).strip() or None
    result = sync_subscriptions(single_url=rss_url)
    result["overview"] = get_overview()
    return jsonify(result)


@app.get("/api/feed")
def feed():
    mode = request.args.get("mode", "today").strip()
    offset = int(request.args.get("offset", 0))
    limit = int(request.args.get("limit", 12))
    return jsonify(get_feed(mode=mode, offset=offset, limit=limit))


@app.get("/api/article-details")
def article_details():
    raw_ids = request.args.get("ids", "")
    ids = [item.strip() for item in raw_ids.split(",") if item.strip()]
    return jsonify({"items": get_article_details(ids)})


@app.post("/api/articles/<article_id>/action")
def article_action(article_id: str):
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action", "")).strip()
    return jsonify(set_article_action(article_id, action, payload))


@app.get("/api/images")
def image_feed():
    offset = int(request.args.get("offset", 0))
    limit = int(request.args.get("limit", 24))
    journal = request.args.get("journal")
    saved_only = request.args.get("savedOnly", "false").lower() == "true"
    return jsonify(get_recent_image_tiles(offset=offset, limit=limit, journal=journal, saved_only=saved_only))


@app.post("/api/images/toggle")
def image_toggle():
    payload = request.get_json(silent=True) or {}
    article_id = str(payload.get("articleId", "")).strip()
    figure_index = safe_int(payload.get("figureIndex", 0), 0)
    image_url = str(payload.get("imageUrl", "")).strip()
    return jsonify(toggle_saved_image(article_id, figure_index, image_url))


@app.get("/api/my/papers")
def my_papers():
    query = request.args.get("query", "")
    return jsonify({"items": get_saved_papers(query=query)})


@app.get("/api/my/images")
def my_images():
    return jsonify({"items": get_saved_images()})


@app.post("/api/subscriptions")
def subscriptions_add():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    url = str(payload.get("url", "")).strip()
    return jsonify(add_subscription(name, url))


@app.post("/api/subscriptions/<subscription_id>/reorder")
def subscriptions_reorder(subscription_id: str):
    payload = request.get_json(silent=True) or {}
    direction = str(payload.get("direction", "up")).strip()
    return jsonify(reorder_subscription(subscription_id, direction))


@app.delete("/api/subscriptions/<subscription_id>")
def subscriptions_delete(subscription_id: str):
    return jsonify(delete_subscription(subscription_id))


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
