from __future__ import annotations

import argparse
import json

from backend.service import sync_subscriptions


def main() -> None:
    parser = argparse.ArgumentParser(description="Sync PaperFlow RSS archive and prefetch article details.")
    parser.add_argument("--rss-url", default=None, help="Sync only a single RSS URL.")
    parser.add_argument(
        "--backfill-missing",
        action="store_true",
        help="Backfill missing article detail caches while syncing.",
    )
    parser.add_argument(
        "--backfill-limit",
        type=int,
        default=6,
        help="How many legacy articles without detail cache to backfill in this run.",
    )
    args = parser.parse_args()

    result = sync_subscriptions(
        single_url=args.rss_url or None,
        backfill_missing_limit=args.backfill_limit if args.backfill_missing else 0,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
