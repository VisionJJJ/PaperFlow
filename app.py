from __future__ import annotations

import hmac
import os
from functools import wraps

from flask import Flask, abort, jsonify, redirect, request, send_file, session, url_for

from backend.service import (
    add_subscription,
    delete_subscription,
    ensure_thumbnail_cached,
    get_admin_dashboard,
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
app.config["SECRET_KEY"] = os.environ.get("PAPERFLOW_SECRET_KEY", "paperflow-dev-secret")
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

ADMIN_USERNAME = os.environ.get("PAPERFLOW_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("PAPERFLOW_ADMIN_PASSWORD", "paperflow-admin")


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


def current_user_id() -> str | None:
    header_user = request.headers.get("X-PaperFlow-User")
    query_user = request.args.get("userId")
    if request.is_json:
        payload = request.get_json(silent=True) or {}
        body_user = payload.get("userId")
    else:
        body_user = None
    return str(header_user or query_user or body_user or "").strip() or None


def is_admin_authenticated() -> bool:
    return bool(session.get("admin_authenticated"))


def require_admin_api(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not is_admin_authenticated():
            return jsonify({"error": "unauthorized"}), 401
        return view(*args, **kwargs)

    return wrapped


@app.after_request
def disable_cache(response):
    if request.path in {"/", "/admin", "/admin/login"} or request.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response


@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.get("/media/thumbs/<article_id>/<int:figure_index>.webp")
def media_thumbnail(article_id: str, figure_index: int):
    try:
        target = ensure_thumbnail_cached(article_id, figure_index)
    except Exception:
        return abort(404)
    if not target or not target.exists():
        return abort(404)
    return send_file(target, mimetype="image/webp", max_age=86400)


@app.route("/admin")
def admin():
    if not is_admin_authenticated():
        return redirect(url_for("admin_login"))
    return app.send_static_file("admin.html")


@app.route("/admin/login")
def admin_login():
    if is_admin_authenticated():
        return redirect(url_for("admin"))
    return app.send_static_file("admin-login.html")


@app.get("/api/bootstrap")
def bootstrap():
    return jsonify(get_overview(current_user_id()))


@app.post("/api/sync")
def sync():
    payload = request.get_json(silent=True) or {}
    rss_url = str(payload.get("rssUrl", "")).strip() or None
    result = sync_subscriptions(single_url=rss_url)
    result["overview"] = get_overview(current_user_id())
    return jsonify(result)


@app.post("/api/admin/login")
def admin_login_api():
    payload = request.get_json(silent=True) or {}
    username = str(payload.get("username", "")).strip()
    password = str(payload.get("password", ""))
    if not (
        hmac.compare_digest(username, ADMIN_USERNAME)
        and hmac.compare_digest(password, ADMIN_PASSWORD)
    ):
        return jsonify({"ok": False, "error": "invalid_credentials"}), 401
    session["admin_authenticated"] = True
    session["admin_username"] = ADMIN_USERNAME
    return jsonify({"ok": True, "username": ADMIN_USERNAME})


@app.post("/api/admin/logout")
@require_admin_api
def admin_logout_api():
    session.pop("admin_authenticated", None)
    session.pop("admin_username", None)
    return jsonify({"ok": True})


@app.get("/api/admin/session")
def admin_session_api():
    if not is_admin_authenticated():
        return jsonify({"authenticated": False}), 401
    return jsonify({"authenticated": True, "username": session.get("admin_username", ADMIN_USERNAME)})


@app.get("/api/feed")
def feed():
    mode = request.args.get("mode", "today").strip()
    offset = int(request.args.get("offset", 0))
    limit = int(request.args.get("limit", 12))
    return jsonify(get_feed(current_user_id(), mode=mode, offset=offset, limit=limit))


@app.get("/api/article-details")
def article_details():
    raw_ids = request.args.get("ids", "")
    ids = [item.strip() for item in raw_ids.split(",") if item.strip()]
    return jsonify({"items": get_article_details(current_user_id(), ids)})


@app.post("/api/articles/<article_id>/action")
def article_action(article_id: str):
    payload = request.get_json(silent=True) or {}
    action = str(payload.get("action", "")).strip()
    return jsonify(set_article_action(current_user_id(), article_id, action, payload))


@app.get("/api/images")
def image_feed():
    offset = int(request.args.get("offset", 0))
    limit = int(request.args.get("limit", 24))
    journal = request.args.get("journal")
    saved_only = request.args.get("savedOnly", "false").lower() == "true"
    return jsonify(
        get_recent_image_tiles(
            current_user_id(),
            offset=offset,
            limit=limit,
            journal=journal,
            saved_only=saved_only,
        )
    )


@app.post("/api/images/toggle")
def image_toggle():
    payload = request.get_json(silent=True) or {}
    article_id = str(payload.get("articleId", "")).strip()
    figure_index = safe_int(payload.get("figureIndex", 0), 0)
    image_url = str(payload.get("imageUrl", "")).strip()
    return jsonify(toggle_saved_image(current_user_id(), article_id, figure_index, image_url))


@app.get("/api/my/papers")
def my_papers():
    query = request.args.get("query", "")
    return jsonify({"items": get_saved_papers(current_user_id(), query=query)})


@app.get("/api/my/images")
def my_images():
    return jsonify({"items": get_saved_images(current_user_id())})


@app.post("/api/subscriptions")
def subscriptions_add():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "")).strip()
    url = str(payload.get("url", "")).strip()
    return jsonify(add_subscription(current_user_id(), name, url))


@app.post("/api/subscriptions/<subscription_id>/reorder")
def subscriptions_reorder(subscription_id: str):
    payload = request.get_json(silent=True) or {}
    direction = str(payload.get("direction", "up")).strip()
    return jsonify(reorder_subscription(current_user_id(), subscription_id, direction))


@app.delete("/api/subscriptions/<subscription_id>")
def subscriptions_delete(subscription_id: str):
    return jsonify(delete_subscription(current_user_id(), subscription_id))


@app.get("/api/admin/archive-status")
@require_admin_api
def admin_archive_status():
    return jsonify(get_admin_dashboard())


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000, debug=True)
