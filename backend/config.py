import os
import shutil
import tempfile
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
BUNDLED_DATA_DIR = ROOT_DIR / "data"


def runtime_data_dir() -> Path:
    if os.environ.get("VERCEL"):
        return Path(tempfile.gettempdir()) / "paperflow-data"
    return BUNDLED_DATA_DIR


DATA_DIR = runtime_data_dir()
ARTICLE_CACHE_DIR = DATA_DIR / "article_cache"
THUMBNAIL_CACHE_DIR = DATA_DIR / "thumbnails"
SUBSCRIPTIONS_PATH = DATA_DIR / "subscriptions.json"
ARTICLES_PATH = DATA_DIR / "articles.json"
STATE_PATH = DATA_DIR / "state.json"
USERS_DIR = DATA_DIR / "users"
RSS_SEED_PATH = ROOT_DIR / "rss_list.json"

USER_TIMEZONE = "Asia/Shanghai"
DEFAULT_BATCH_SIZE = 12
MAX_BATCH_SIZE = 20
DEFAULT_IMAGE_BATCH = 24
IMAGE_LOOKBACK_DAYS = 7


def ensure_runtime_data_seeded() -> None:
    if DATA_DIR == BUNDLED_DATA_DIR:
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not BUNDLED_DATA_DIR.exists():
        return
    for source in BUNDLED_DATA_DIR.rglob("*"):
        relative = source.relative_to(BUNDLED_DATA_DIR)
        target = DATA_DIR / relative
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


ensure_runtime_data_seeded()
