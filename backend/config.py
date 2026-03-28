from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
ARTICLE_CACHE_DIR = DATA_DIR / "article_cache"
SUBSCRIPTIONS_PATH = DATA_DIR / "subscriptions.json"
ARTICLES_PATH = DATA_DIR / "articles.json"
STATE_PATH = DATA_DIR / "state.json"
RSS_SEED_PATH = ROOT_DIR / "rss_list.json"

USER_TIMEZONE = "Asia/Shanghai"
DEFAULT_BATCH_SIZE = 12
MAX_BATCH_SIZE = 20
DEFAULT_IMAGE_BATCH = 24
IMAGE_LOOKBACK_DAYS = 7
