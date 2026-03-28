# Nature Flow Reader Prototype

## Run

```bash
python app.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000).

## Notes

- Backend stores only JSON under `data/`.
- RSS sync currently defaults to `https://www.nature.com/ncomms.rss`.
- Article details are loaded in batches and figure URLs are resolved on demand.
