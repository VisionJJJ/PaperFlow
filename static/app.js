const state = {
  screen: "home",
  mode: "today",
  overview: null,
  feeds: {
    today: createFeedState(),
    queue: createFeedState(),
  },
  images: createImageState(),
  collection: {
    tab: "papers",
    query: "",
    journal: "all",
    savedImages: [],
  },
  savedImageKeys: new Set(),
  savedImageIndexLoaded: false,
  imageMeta: {},
  imageAssets: {},
  imageAssetPending: {},
  readerPreview: {
    open: false,
    detail: null,
    figureIndex: 0,
    message: "",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  },
};

const SUGGESTED_SUBSCRIPTIONS = [
  { name: "Nature", url: "https://www.nature.com/nature.rss" },
  { name: "Nature Communications", url: "https://www.nature.com/ncomms.rss" },
  { name: "Nature Geoscience", url: "https://www.nature.com/ngeo.rss" },
  { name: "Nature Medicine", url: "https://www.nature.com/nm.rss" },
];

const refs = {
  homeScreen: document.getElementById("homeScreen"),
  collectionScreen: document.getElementById("collectionScreen"),
  subscriptionScreen: document.getElementById("subscriptionScreen"),
  myScreen: document.getElementById("myScreen"),
  readerPanel: document.getElementById("readerPanel"),
  imagePanel: document.getElementById("imagePanel"),
  collectionPanel: document.getElementById("collectionPanel"),
  subscriptionPanel: document.getElementById("subscriptionPanel"),
  myPanel: document.getElementById("myPanel"),
  todayCount: document.getElementById("todayCount"),
  queueCount: document.getElementById("queueCount"),
  imageModal: document.getElementById("imageModal"),
  modalBody: document.getElementById("modalBody"),
  readerPreviewModal: document.getElementById("readerPreviewModal"),
  readerPreviewCard: document.getElementById("readerPreviewCard"),
  readerPreviewBody: document.getElementById("readerPreviewBody"),
};

function createFeedState() {
  return {
    ids: [],
    details: {},
    detailLoading: {},
    offset: 0,
    total: 0,
    currentIndex: 0,
    activeFigure: 0,
    expanded: false,
    loading: false,
    hasMore: true,
    history: [],
  };
}

function createImageState() {
  return {
    items: [],
    offset: 0,
    total: 0,
    hasMore: true,
    loading: false,
    journal: "all",
    savedOnly: false,
  };
}

function attachTouchGuards() {
  let lastTouchStart = 0;
  let lastTouchEnd = 0;
  const preventDefault = (event) => {
    event.preventDefault();
  };

  document.addEventListener("dblclick", preventDefault, { passive: false });
  document.addEventListener(
    "touchstart",
    (event) => {
      const inReaderPreview = event.target.closest?.("#readerPreviewStage");
      if (event.touches.length > 1) {
        if (!inReaderPreview) {
          event.preventDefault();
        }
        return;
      }
      const now = Date.now();
      if (now - lastTouchStart < 320) {
        event.preventDefault();
      }
      lastTouchStart = now;
    },
    { passive: false, capture: true },
  );
  document.addEventListener(
    "touchend",
    (event) => {
      const now = Date.now();
      if (now - lastTouchEnd < 320) {
        event.preventDefault();
      }
      lastTouchEnd = now;
    },
    { passive: false },
  );

  ["gesturestart", "gesturechange", "gestureend"].forEach((name) => {
    document.addEventListener(name, preventDefault, { passive: false });
  });
}

let viewportSyncFrame = 0;

function syncViewportMetrics() {
  const viewport = window.visualViewport;
  const width = Math.max(
    1,
    Math.round(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 0),
  );
  const height = Math.max(
    1,
    Math.round(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 0),
  );
  document.documentElement.style.setProperty("--app-width", `${width}px`);
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

function scheduleViewportSync() {
  if (viewportSyncFrame) return;
  viewportSyncFrame = window.requestAnimationFrame(() => {
    viewportSyncFrame = 0;
    syncViewportMetrics();
    rerenderCurrentScreen();
  });
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value) {
  if (!value) return "暂无";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function currentFeed() {
  return state.feeds[state.mode];
}

function uniqueJournals(items = [], selector) {
  return [...new Set(items.map((item) => selector(item)).filter(Boolean))].sort((left, right) =>
    String(left).localeCompare(String(right), "zh-CN"),
  );
}

function figureKey(articleId, figureIndex) {
  return `${articleId}:${figureIndex}`;
}

function normalizeFigureIndex(value, fallback = 0) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }
  return fallback;
}

function parseFigureKey(value) {
  if (!value) return null;
  const text = String(value);
  const separator = text.lastIndexOf(":");
  if (separator < 1) return null;
  const articleId = text.slice(0, separator);
  const figureIndex = normalizeFigureIndex(text.slice(separator + 1), -1);
  if (!articleId || figureIndex < 0) return null;
  return { articleId, figureIndex, key: `${articleId}:${figureIndex}` };
}

function normalizeImageItem(rawItem) {
  if (!rawItem) return null;
  const fromKey = parseFigureKey(rawItem.key);
  const articleId = String(rawItem.article_id ?? rawItem.articleId ?? fromKey?.articleId ?? "").trim();
  const figureIndex = normalizeFigureIndex(
    rawItem.figure_index ?? rawItem.figureIndex ?? fromKey?.figureIndex ?? 0,
    fromKey?.figureIndex ?? 0,
  );
  const imageUrl = String(rawItem.image_url ?? rawItem.imageUrl ?? "").trim();
  if (!articleId || !imageUrl) return null;
  return {
    ...rawItem,
    article_id: articleId,
    figure_index: figureIndex,
    image_url: imageUrl,
    key: rawItem.key || figureKey(articleId, figureIndex),
  };
}

function isFigureSaved(articleId, figureIndex) {
  return state.savedImageKeys.has(figureKey(articleId, figureIndex));
}

function getAspectRatio(meta) {
  if (!meta?.width || !meta?.height) return "1 / 1";
  return `${meta.width} / ${meta.height}`;
}

function domSafeId(value) {
  return String(value || "")
    .replaceAll(":", "-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function correspondingAuthor(detail) {
  return detail?.corresponding_author || "暂无";
}

function articleStatusLabel(detail) {
  const status = detail?.state?.status || "unread";
  if (status === "saved") return "已收藏";
  if (status === "dismissed") return "不感兴趣";
  if (status === "viewed") return "已浏览";
  return "未处理";
}

function primeImageMeta(url) {
  if (!url || state.imageMeta[url]) return;
  const image = new Image();
  image.onload = () => {
    state.imageMeta[url] = {
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
    rerenderCurrentScreen();
  };
  image.src = url;
}

function loadImageAsset(url) {
  if (!url) return Promise.resolve(null);
  if (state.imageAssets[url]) return Promise.resolve(state.imageAssets[url]);
  if (state.imageAssetPending[url]) return state.imageAssetPending[url];

  state.imageAssetPending[url] = new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      state.imageAssets[url] = image;
      if (!state.imageMeta[url]) {
        state.imageMeta[url] = {
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
      }
      delete state.imageAssetPending[url];
      resolve(image);
    };
    image.onerror = () => {
      delete state.imageAssetPending[url];
      resolve(null);
    };
    image.src = url;
  });

  return state.imageAssetPending[url];
}

async function paintContainCanvas(canvasId, frameId, url) {
  const canvas = document.getElementById(canvasId);
  const frame = document.getElementById(frameId);
  if (!canvas || !frame || !url) return;

  const asset = await loadImageAsset(url);
  if (!asset) return;
  if (!document.body.contains(canvas) || canvas.dataset.imageUrl !== url) return;

  const width = Math.max(1, Math.round(frame.clientWidth));
  const height = Math.max(1, Math.round(frame.clientHeight));
  if (!width || !height) return;

  const devicePixelRatio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(height * devicePixelRatio));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const padding = Math.max(8, Math.round(Math.min(width, height) * 0.04));
  const drawableWidth = Math.max(1, width - padding * 2);
  const drawableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(drawableWidth / asset.naturalWidth, drawableHeight / asset.naturalHeight);
  const drawWidth = Math.max(1, Math.round(asset.naturalWidth * scale));
  const drawHeight = Math.max(1, Math.round(asset.naturalHeight * scale));
  const offsetX = Math.round((width - drawWidth) / 2);
  const offsetY = Math.round((height - drawHeight) / 2);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(asset, offsetX, offsetY, drawWidth, drawHeight);
}

function primeFigureSet(figures = []) {
  figures.forEach((figure) => {
    if (figure?.image_url) {
      primeImageMeta(figure.image_url);
    }
  });
}

function renderBottomNav() {
  document.querySelectorAll(".bottom-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.screen === state.screen);
  });
  refs.homeScreen.classList.toggle("hidden", state.screen !== "home");
  refs.collectionScreen.classList.toggle("hidden", state.screen !== "collection");
  refs.subscriptionScreen.classList.toggle("hidden", state.screen !== "subscriptions");
  refs.myScreen.classList.toggle("hidden", state.screen !== "my");
  if (state.screen !== "home") {
    closeReaderPreview();
  }
}

function renderModeTabs() {
  const counts = state.overview?.counts || { today: 0, queue: 0 };
  refs.todayCount.textContent = String(counts.today || 0);
  refs.queueCount.textContent = String(counts.queue || 0);
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === state.mode);
  });
}

async function loadBootstrap() {
  state.overview = await api("/api/bootstrap");
  renderModeTabs();
  await ensureSavedImageIndexLoaded();
}

async function ensureSavedImageIndexLoaded(force = false) {
  if (state.savedImageIndexLoaded && !force) return;
  const response = await api("/api/my/images");
  state.savedImageKeys = new Set(response.items.map((item) => item.key));
  state.savedImageIndexLoaded = true;
  if (state.screen === "collection" && state.collection.tab === "images") {
    state.collection.savedImages = response.items;
  }
}

async function ensureFeedPage(mode) {
  const feed = state.feeds[mode];
  if (feed.loading || !feed.hasMore) return;
  feed.loading = true;
  if (state.screen === "home" && state.mode === mode) {
    renderReader();
  }
  try {
    const page = await api(`/api/feed?mode=${mode}&offset=${feed.offset}&limit=12`);
    feed.ids.push(...page.ids);
    feed.offset += page.ids.length;
    feed.total = page.total;
    feed.hasMore = page.has_more;
    if (page.ids.length) {
      const details = await api(`/api/article-details?ids=${page.ids.join(",")}`);
      details.items.forEach((item) => {
        feed.details[item.id] = { ...(feed.details[item.id] || {}), ...item };
        primeFigureSet(item.figures || []);
      });
      void ensureArticleDetail(mode, page.ids[0]);
    }
  } finally {
    feed.loading = false;
    if (state.screen === "home" && state.mode === mode) {
      renderReader();
    }
  }
}

async function ensureArticleDetail(mode, articleId) {
  if (!articleId) return;
  const feed = state.feeds[mode];
  if (feed.detailLoading[articleId]) return;
  if (feed.details[articleId]?.detail_hydrated_at) return;
  feed.detailLoading[articleId] = true;
  if (state.screen === "home" && state.mode === mode) {
    renderReader();
  }
  try {
    const details = await api(`/api/article-details?ids=${articleId}`);
    details.items.forEach((item) => {
      feed.details[item.id] = { ...(feed.details[item.id] || {}), ...item };
      primeFigureSet(item.figures || []);
    });
  } finally {
    delete feed.detailLoading[articleId];
    if (state.screen === "home" && state.mode === mode) {
      renderReader();
    }
  }
}

async function switchMode(mode) {
  state.mode = mode;
  closeReaderPreview();
  renderModeTabs();
  refs.readerPanel.classList.toggle("hidden", mode === "images");
  refs.imagePanel.classList.toggle("hidden", mode !== "images");

  if (mode === "images") {
    if (!state.images.items.length) {
      await loadImagePage(true);
    } else {
      renderImages();
    }
    return;
  }

  const feed = currentFeed();
  if (!feed.ids.length && feed.hasMore) {
    await ensureFeedPage(mode);
  } else {
    renderReader();
  }
}

function todayEmptyHtml() {
  const progress = state.overview?.progress || { todayHandled: 0, todayTotal: 0 };
  const finished = progress.todayTotal > 0 && (state.overview?.counts?.today || 0) === 0;
  return `
    <article class="empty-card">
      <h2>${finished ? "今日新增已处理完" : "今天暂无今日新增"}</h2>
      <p>${finished ? "可以继续处理待阅读，或切到图片速览浏览近期科研图件。" : "当前没有新的入库论文。"}</p>
      <div class="empty-actions">
        <button class="secondary-button" data-empty-nav="queue" type="button">去待阅读</button>
        <button class="secondary-button" data-empty-nav="images" type="button">去图片速览</button>
      </div>
    </article>
  `;
}

function queueEmptyHtml() {
  return `
    <article class="empty-card">
      <h2>暂无待阅读论文</h2>
      <p>历史未处理论文已经清空，可切到图片速览继续浏览图件。</p>
    </article>
  `;
}

function readerFlowProgress(feed) {
  const total = Math.max(feed.total || 0, feed.ids.length || 0, 1);
  const position = Math.max(1, total - feed.ids.length + 1);
  return {
    total,
    position,
    percent: Math.max(6, Math.min(100, (position / total) * 100)),
  };
}

function renderReader() {
  const feed = currentFeed();
  const detail = feed.ids[feed.currentIndex] ? feed.details[feed.ids[feed.currentIndex]] : null;

  if (feed.loading && !feed.ids.length) {
    refs.readerPanel.innerHTML = '<div class="placeholder-card">正在加载论文卡片...</div>';
    return;
  }

  if (!feed.ids.length) {
    refs.readerPanel.innerHTML = state.mode === "today" ? todayEmptyHtml() : queueEmptyHtml();
    refs.readerPanel.querySelectorAll("[data-empty-nav]").forEach((button) => {
      button.addEventListener("click", async () => {
        await switchMode(button.dataset.emptyNav);
      });
    });
    return;
  }

  if (!detail) {
    refs.readerPanel.innerHTML = '<div class="placeholder-card">正在批量加载卡片详情...</div>';
    return;
  }

  const figures = detail.figures || [];
  const isDetailHydrating = !!feed.detailLoading[detail.id];
  if (!detail.detail_hydrated_at && !isDetailHydrating) {
    void ensureArticleDetail(state.mode, detail.id);
  }
  const activeFigure = figures[feed.activeFigure] || null;
  const keywords = (detail.keywords || [])
    .map((keyword) => `<span class="keyword-pill">${escapeHtml(keyword)}</span>`)
    .join("");
  const figureCount = figures.length ? `${feed.activeFigure + 1} / ${figures.length}` : "";
  const flow = readerFlowProgress(feed);
  const activeFigureSaved = activeFigure ? isFigureSaved(detail.id, activeFigure.index) : false;

  refs.readerPanel.innerHTML = `
    <article class="reader-card ${feed.expanded ? "detail-open" : ""}" id="readerCard">
      <div class="reader-flow">
        <span class="reader-flow-label">${state.mode === "today" ? "今日新增" : "待阅读"}</span>
        <div class="reader-progressbar flow-progressbar"><span style="width:${flow.percent}%"></span></div>
        <span class="reader-flow-state">${escapeHtml(articleStatusLabel(detail))}</span>
      </div>

      <header class="reader-head">
        <div class="issue-line">
          <span class="meta-item">${escapeHtml(formatDate(detail.published_at))}</span>
          <span class="journal-chip">${escapeHtml(detail.journal_title || detail.subscription_name || "Nature")}</span>
          <span class="meta-item">${escapeHtml(detail.article_type || "Article")}</span>
        </div>
        <h1 class="reader-title">${escapeHtml(detail.title || detail.rss_title || "Untitled")}</h1>
        <div class="keyword-row">${keywords || '<span class="keyword-pill muted">暂无关键词</span>'}</div>
      </header>

      <section class="reader-stage ${feed.expanded ? "detail-open" : ""}">
        <section class="reader-media" data-media-stage="true">
          ${
            activeFigure
              ? `
            <div class="figure-stage" data-reader-figure="true">
              ${activeFigureSaved ? '<span class="saved-star">★</span>' : ""}
              <span class="figure-stage-count">${escapeHtml(figureCount)}</span>
              <div class="figure-frame" id="readerFigureFrame">
                <canvas id="readerFigureCanvas" class="figure-canvas" data-image-url="${escapeHtml(activeFigure.image_url)}" aria-label="${escapeHtml(activeFigure.title || "论文插图")}"></canvas>
              </div>
            </div>
          `
              : `
            <div class="figure-empty">
              <p>暂未获取插图</p>
              <a class="primary-link" href="${escapeHtml(detail.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
            </div>
          `
          }
        </section>

        <section class="detail-section ${feed.expanded ? "open" : ""}">
          ${
            feed.expanded
              ? `
            <div class="detail-list">
              <div class="detail-item">
                <strong>摘要</strong>
                <p>${escapeHtml(detail.abstract || "暂无")}</p>
              </div>
              <div class="detail-item">
                <strong>第一单位</strong>
                <p>${escapeHtml(detail.first_author_affiliation || "暂无")}</p>
              </div>
              <div class="detail-item">
                <strong>通讯作者</strong>
                <p>${escapeHtml(correspondingAuthor(detail))}</p>
              </div>
              <a class="primary-link" href="${escapeHtml(detail.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
            </div>
          `
              : ""
          }
        </section>
      </section>

      ${
        detail.state?.status === "saved"
          ? `
        <section class="note-strip">
          <textarea id="noteInput" rows="1" placeholder="补一句备注，默认进入未分类。">${escapeHtml(detail.state?.note || "")}</textarea>
          <div class="note-actions">
            <button class="secondary-button" type="button" disabled>专栏归类</button>
            <button class="secondary-button" data-action="save-note" type="button">保存备注</button>
          </div>
        </section>
      `
          : ""
      }

      <footer class="reader-footer-shell">
        <div class="action-bar">
          <button class="action-button icon-button ${feed.expanded ? "open" : ""}" data-action="toggle-detail" type="button" aria-label="${feed.expanded ? "收起详情" : "展开详情"}" title="${feed.expanded ? "收起详情" : "展开详情"}">
            <span class="detail-chevron">⌄</span>
          </button>
          <button class="action-button warn" data-action="dismissed" type="button" aria-label="不感兴趣" title="不感兴趣">×</button>
          <button class="action-button" data-action="previous" type="button" ${feed.history.length ? "" : "disabled"} aria-label="上一条" title="上一条">‹</button>
          <button class="action-button ${detail.state?.status === "saved" ? "saved" : ""}" data-action="saved" type="button" ${detail.state?.status === "saved" ? "disabled" : ""} aria-label="${detail.state?.status === "saved" ? "已收藏" : "收藏论文"}" title="${detail.state?.status === "saved" ? "已收藏" : "收藏论文"}">${detail.state?.status === "saved" ? "★" : "☆"}</button>
          <button class="action-button primary" data-action="next" type="button" aria-label="下一条" title="下一条">›</button>
        </div>
      </footer>
    </article>
  `;

  if (!activeFigure && (isDetailHydrating || !detail.detail_hydrated_at)) {
    const mediaEmpty = refs.readerPanel.querySelector(".figure-empty");
    if (mediaEmpty) {
      mediaEmpty.innerHTML = "<p>正在加载插图...</p>";
    }
  }

  bindReaderEvents(figures);
  if (activeFigure?.image_url) {
    requestAnimationFrame(() => {
      void paintContainCanvas("readerFigureCanvas", "readerFigureFrame", activeFigure.image_url);
    });
  }
  maybePrefetchNext();
}

function detailSnapshotFromFeed(feed) {
  const id = feed.ids[feed.currentIndex];
  const detail = id ? feed.details[id] : null;
  if (!detail) return null;
  return {
    id: detail.id,
    title: detail.title || detail.rss_title || "Untitled",
    journal_title: detail.journal_title || detail.subscription_name || "Nature",
    published_at: detail.published_at,
    article_url: detail.article_url,
    figures: (detail.figures || []).map((figure) => ({ ...figure })),
  };
}

function figureItemFromPreview(detail, figureIndex) {
  const figure = detail?.figures?.[figureIndex];
  if (!detail || !figure) return null;
  return {
    key: `${detail.id}:${figure.index}`,
    article_id: detail.id,
    figure_index: figure.index,
    image_url: figure.image_url,
    title: figure.title,
    article_title: detail.title,
    journal_title: detail.journal_title,
    published_at: detail.published_at,
    article_url: detail.article_url,
  };
}

function openReaderPreview(detail, figureIndex) {
  if (!detail?.figures?.length) return;
  state.readerPreview = {
    open: true,
    detail,
    figureIndex: Math.max(0, Math.min(figureIndex, detail.figures.length - 1)),
    message: "",
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  };
  renderReaderPreview();
}

function closeReaderPreview() {
  state.readerPreview.open = false;
  state.readerPreview.detail = null;
  state.readerPreview.figureIndex = 0;
  state.readerPreview.message = "";
  state.readerPreview.scale = 1;
  state.readerPreview.offsetX = 0;
  state.readerPreview.offsetY = 0;
  refs.readerPreviewModal.classList.add("hidden");
}

function renderReaderPreview() {
  const preview = state.readerPreview;
  const detail = preview.detail;
  const figure = detail?.figures?.[preview.figureIndex];
  if (!preview.open || !detail || !figure) {
    refs.readerPreviewModal.classList.add("hidden");
    refs.readerPreviewBody.innerHTML = "";
    return;
  }

  refs.readerPreviewBody.innerHTML = `
    <section class="reader-preview-shell">
      <div class="reader-preview-meta">
        <span>${escapeHtml(detail.journal_title || "Nature")} · ${escapeHtml(formatDate(detail.published_at))}</span>
        <strong>${escapeHtml(String(preview.figureIndex + 1))} / ${escapeHtml(String(detail.figures.length))}</strong>
      </div>
      <h3 class="reader-preview-title">${escapeHtml(detail.title || "")}</h3>
      <p class="reader-preview-caption">${escapeHtml(figure.title || `Figure ${preview.figureIndex + 1}`)}</p>
      <div class="reader-preview-stage" id="readerPreviewStage">
        <div class="reader-preview-frame" id="readerPreviewFrame">
          ${isFigureSaved(detail.id, figure.index) ? '<span class="saved-star preview-star">★</span>' : ""}
          <img id="readerPreviewImage" class="reader-preview-image" src="${escapeHtml(figure.image_url)}" alt="${escapeHtml(figure.title || detail.title || "科研图片")}" />
        </div>
      </div>
      <div class="reader-preview-hint">
        <span>左右滑动切换图片</span>
        <span>双击收藏</span>
        ${preview.message ? `<strong>${escapeHtml(preview.message)}</strong>` : ""}
      </div>
    </section>
  `;

  positionReaderPreviewCard();
  refs.readerPreviewModal.classList.remove("hidden");
  applyReaderPreviewTransform();
  bindReaderPreviewEvents();
}

function positionReaderPreviewCard() {
  const rect = refs.readerPanel.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  refs.readerPreviewCard.style.left = `${rect.left}px`;
  refs.readerPreviewCard.style.top = `${rect.top}px`;
  refs.readerPreviewCard.style.width = `${rect.width}px`;
  refs.readerPreviewCard.style.height = `${rect.height}px`;
}

function applyReaderPreviewTransform() {
  const image = document.getElementById("readerPreviewImage");
  if (!image) return;
  const preview = state.readerPreview;
  image.style.transform = `translate(${preview.offsetX}px, ${preview.offsetY}px) scale(${preview.scale})`;
}

function bindReaderPreviewEvents() {
  const stage = document.getElementById("readerPreviewStage");
  const image = document.getElementById("readerPreviewImage");
  if (!stage || !image) return;

  const preview = state.readerPreview;
  const pointers = new Map();
  let dragState = null;
  let pinchState = null;
  let lastTapAt = 0;

  const clampScale = (value) => Math.max(1, Math.min(value, 4));
  const distanceBetween = (left, right) => Math.hypot(right.x - left.x, right.y - left.y);

  stage.addEventListener("pointerdown", (event) => {
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      dragState = {
        startX: event.clientX,
        startY: event.clientY,
        baseX: preview.offsetX,
        baseY: preview.offsetY,
      };
    } else if (pointers.size === 2) {
      const [first, second] = [...pointers.values()];
      pinchState = {
        distance: distanceBetween(first, second),
        scale: preview.scale,
      };
      dragState = null;
    }
  });

  stage.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 2 && pinchState) {
      const [first, second] = [...pointers.values()];
      const nextDistance = distanceBetween(first, second);
      preview.scale = clampScale(pinchState.scale * (nextDistance / Math.max(pinchState.distance, 1)));
      applyReaderPreviewTransform();
      return;
    }

    if (pointers.size === 1 && dragState && preview.scale > 1.01) {
      preview.offsetX = dragState.baseX + (event.clientX - dragState.startX);
      preview.offsetY = dragState.baseY + (event.clientY - dragState.startY);
      applyReaderPreviewTransform();
    }
  });

  const handlePointerEnd = (event) => {
    const currentPoint = pointers.get(event.pointerId) || { x: event.clientX, y: event.clientY };
    pointers.delete(event.pointerId);
    stage.releasePointerCapture?.(event.pointerId);

    if (pinchState && pointers.size < 2) {
      pinchState = null;
    }

    if (pointers.size === 1) {
      const remaining = [...pointers.values()][0];
      dragState = {
        startX: remaining.x,
        startY: remaining.y,
        baseX: preview.offsetX,
        baseY: preview.offsetY,
      };
      return;
    }

    if (!dragState) return;
    const deltaX = currentPoint.x - dragState.startX;
    const deltaY = currentPoint.y - dragState.startY;
    dragState = null;

    if (preview.scale <= 1.01 && Math.abs(deltaX) < 12 && Math.abs(deltaY) < 12) {
      const now = event.timeStamp;
      if (now - lastTapAt < 280) {
        lastTapAt = 0;
        const item = figureItemFromPreview(preview.detail, preview.figureIndex);
        if (item) {
          void toggleImageSave(item).then(() => {
            preview.message = "图片收藏已切换";
            renderReaderPreview();
          });
        }
      } else {
        lastTapAt = now;
      }
      return;
    }

    if (preview.scale > 1.01) return;
    if (Math.abs(deltaX) < 42 || Math.abs(deltaX) < Math.abs(deltaY)) return;
    const figures = preview.detail?.figures || [];
    const nextIndex = deltaX < 0 ? Math.min(preview.figureIndex + 1, figures.length - 1) : Math.max(preview.figureIndex - 1, 0);
    if (nextIndex !== preview.figureIndex) {
      preview.figureIndex = nextIndex;
      preview.message = "";
      preview.scale = 1;
      preview.offsetX = 0;
      preview.offsetY = 0;
      renderReaderPreview();
    }
  };

  stage.addEventListener("pointerup", handlePointerEnd);
  stage.addEventListener("pointercancel", handlePointerEnd);
  stage.addEventListener("pointerleave", (event) => {
    if (pointers.has(event.pointerId)) {
      handlePointerEnd(event);
    }
  });
}

function bindReaderEvents(figures) {
  const feed = currentFeed();

  refs.readerPanel.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await handleReaderAction(button.dataset.action);
    });
  });

  const mediaStage = refs.readerPanel.querySelector("[data-media-stage]");
  const figureStage = refs.readerPanel.querySelector("[data-reader-figure]");
  if (mediaStage && figureStage) {
    let startX = 0;
    let startY = 0;
    let previewTapTimer = null;
    let lastTapAt = 0;
    let lastTouchHandledAt = 0;

    const handleMediaGesture = async (clientX, clientY, timeStamp) => {
      const delta = clientX - startX;
      const deltaY = clientY - startY;
      startX = 0;
      startY = 0;

      if (Math.abs(delta) < 12 && Math.abs(deltaY) < 12) {
        const detail = detailSnapshotFromFeed(feed);
        const item = figureItemFromPreview(detail, feed.activeFigure);
        if (item && timeStamp - lastTapAt < 280) {
          lastTapAt = 0;
          if (previewTapTimer) {
            clearTimeout(previewTapTimer);
            previewTapTimer = null;
          }
          await toggleImageSave(item);
          renderReader();
          return;
        }
        lastTapAt = timeStamp;
        if (previewTapTimer) {
          clearTimeout(previewTapTimer);
        }
        previewTapTimer = window.setTimeout(() => {
          openReaderPreview(detailSnapshotFromFeed(feed), feed.activeFigure);
          previewTapTimer = null;
        }, 220);
        return;
      }

      if (Math.abs(delta) < 36 || Math.abs(delta) < Math.abs(deltaY) || figures.length <= 1) return;
      const nextIndex = delta < 0 ? Math.min(feed.activeFigure + 1, figures.length - 1) : Math.max(feed.activeFigure - 1, 0);
      if (nextIndex !== feed.activeFigure) {
        feed.activeFigure = nextIndex;
        renderReader();
      }
    };

    mediaStage.addEventListener("pointerdown", (event) => {
      startX = event.clientX;
      startY = event.clientY;
    });
    mediaStage.addEventListener("pointerup", async (event) => {
      if (event.pointerType === "touch" && event.timeStamp - lastTouchHandledAt < 420) {
        return;
      }
      await handleMediaGesture(event.clientX, event.clientY, event.timeStamp);
    });

    mediaStage.addEventListener(
      "touchstart",
      (event) => {
        const touch = event.changedTouches?.[0];
        if (!touch) return;
        startX = touch.clientX;
        startY = touch.clientY;
      },
      { passive: true },
    );

    mediaStage.addEventListener("touchend", async (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      lastTouchHandledAt = event.timeStamp || performance.now();
      await handleMediaGesture(touch.clientX, touch.clientY, lastTouchHandledAt);
    });
  }

  const readerCard = document.getElementById("readerCard");
  let cardStartX = 0;
  readerCard.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, a, textarea, input, .reader-media")) {
      cardStartX = 0;
      return;
    }
    cardStartX = event.clientX;
  });
  readerCard.addEventListener("pointerup", async (event) => {
    if (!cardStartX) return;
    const delta = event.clientX - cardStartX;
    cardStartX = 0;
    if (Math.abs(delta) < 56) return;
    if (delta < 0) {
      await handleReaderAction("next");
    } else if (feed.history.length) {
      await handleReaderAction("previous");
    }
  });
}

async function handleReaderAction(action) {
  const feed = currentFeed();
  const currentId = feed.ids[feed.currentIndex];
  const detail = currentId ? feed.details[currentId] : null;
  if (!detail) return;

  if (action === "toggle-detail") {
    feed.expanded = !feed.expanded;
    renderReader();
    return;
  }

  if (action === "save-note") {
    const note = document.getElementById("noteInput")?.value || "";
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "note", note }),
    });
    detail.state.note = note;
    renderReader();
    return;
  }

  if (action === "saved") {
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "saved" }),
    });
    detail.state.status = "saved";
    detail.state.saved_at = new Date().toISOString();
    await loadBootstrap();
    renderReader();
    return;
  }

  if (action === "previous") {
    const previous = feed.history.pop();
    if (!previous) return;
    const insertIndex = Math.min(previous.index, feed.ids.length);
    feed.ids.splice(insertIndex, 0, previous.id);
    feed.details[previous.id] = previous.detail;
    feed.currentIndex = insertIndex;
    feed.activeFigure = 0;
    feed.expanded = false;
    renderReader();
    return;
  }

  if (action === "dismissed") {
    closeReaderPreview();
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "dismissed" }),
    });
    detail.state.status = "dismissed";
  }

  if (action === "next") {
    closeReaderPreview();
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "viewed" }),
    });
    detail.state.status = "viewed";
  }

  feed.history.push({
    id: detail.id,
    detail: { ...detail, state: { ...(detail.state || {}) } },
    index: feed.currentIndex,
  });
  if (feed.history.length > 5) {
    feed.history.shift();
  }

  feed.ids.splice(feed.currentIndex, 1);
  delete feed.details[detail.id];
  if (feed.currentIndex >= feed.ids.length) {
    feed.currentIndex = Math.max(feed.ids.length - 1, 0);
  }
  feed.activeFigure = 0;
  feed.expanded = false;

  if (feed.ids.length <= 4 && feed.hasMore) {
    await ensureFeedPage(state.mode);
  }
  await loadBootstrap();
  renderReader();
}

async function maybePrefetchNext() {
  const feed = currentFeed();
  if (state.mode === "images") return;
  if (!feed.loading && feed.hasMore && feed.ids.length - feed.currentIndex <= 4) {
    await ensureFeedPage(state.mode);
  }
  const nextId = feed.ids[feed.currentIndex + 1];
  if (nextId) {
    void ensureArticleDetail(state.mode, nextId);
  }
}

async function loadImagePage(reset = false) {
  if (reset) {
    state.images = {
      ...createImageState(),
      journal: state.images.journal,
      savedOnly: state.images.savedOnly,
    };
  }

  if (state.images.loading) return;
  state.images.loading = true;
  renderImages();
  try {
    const page = await api(
      `/api/images?offset=${state.images.offset}&limit=24&journal=${encodeURIComponent(state.images.journal)}&savedOnly=${state.images.savedOnly}`,
    );
    state.images.items.push(...page.items);
    state.images.offset += page.items.length;
    state.images.total = page.total;
    state.images.hasMore = page.has_more;
    page.items.forEach((item) => primeImageMeta(item.image_url));
  } finally {
    state.images.loading = false;
    renderImages();
  }
}

function renderImages() {
  const journals = state.overview?.journals || [];
  const filters = [
    `<button class="filter-pill ${state.images.journal === "all" ? "active" : ""}" data-journal="all" type="button">全部期刊</button>`,
    ...journals.map(
      (journal) =>
        `<button class="filter-pill ${state.images.journal === journal ? "active" : ""}" data-journal="${escapeHtml(journal)}" type="button">${escapeHtml(journal)}</button>`,
    ),
  ].join("");

  refs.imagePanel.innerHTML = `
    <section class="image-toolbar">
      <div class="filter-row">${filters}</div>
      <button class="filter-pill ${state.images.savedOnly ? "active" : ""}" data-toggle-saved="true" type="button">只看已收藏</button>
    </section>

    <section class="image-masonry">
      ${
        state.images.items.length
          ? state.images.items
              .map((item) => {
                const ratio = getAspectRatio(state.imageMeta[item.image_url]);
                const safeId = domSafeId(item.key);
                return `
                  <article class="image-tile" data-image-key="${escapeHtml(item.key)}">
                    <div class="image-tile-media image-tile-stage" style="aspect-ratio:${ratio}">
                      <div class="image-tile-frame" id="imageTileFrame-${safeId}">
                        <canvas
                          id="imageTileCanvas-${safeId}"
                          class="figure-canvas"
                          data-image-url="${escapeHtml(item.image_url)}"
                          aria-label="${escapeHtml(item.title || "科研图片")}"
                        ></canvas>
                      </div>
                      ${item.saved ? '<span class="saved-star image-tile-star">★</span>' : ""}
                    </div>
                  </article>
                `;
              })
              .join("")
          : '<div class="empty-card"><h2>暂无图片</h2><p>近 7 天内暂未抓取到可展示的科研图片。</p></div>'
      }
    </section>
    ${state.images.hasMore ? '<button id="loadMoreImages" class="secondary-button image-more" type="button">继续加载</button>' : ""}
  `;

  refs.imagePanel.querySelectorAll("[data-journal]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.images.journal = button.dataset.journal;
      await loadImagePage(true);
    });
  });

  refs.imagePanel.querySelector("[data-toggle-saved]")?.addEventListener("click", async () => {
    state.images.savedOnly = !state.images.savedOnly;
    await loadImagePage(true);
  });

  refs.imagePanel.querySelectorAll("[data-image-key]").forEach((tile) => {
    let startX = 0;
    let startY = 0;
    let openTimer = null;
    let lastTapAt = 0;

    tile.addEventListener("pointerdown", (event) => {
      startX = event.clientX;
      startY = event.clientY;
    });

    tile.addEventListener("pointerup", async (event) => {
      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      if (Math.abs(deltaX) > 12 || Math.abs(deltaY) > 12) return;

      const item = state.images.items.find((entry) => entry.key === tile.dataset.imageKey);
      if (!item) return;
      const now = event.timeStamp;
      if (now - lastTapAt < 280) {
        lastTapAt = 0;
        if (openTimer) {
          clearTimeout(openTimer);
          openTimer = null;
        }
        await toggleImageSave(item);
        renderImages();
        return;
      }

      lastTapAt = now;
      if (openTimer) {
        clearTimeout(openTimer);
      }
      openTimer = window.setTimeout(() => {
        openImageModal(tile.dataset.imageKey, state.images.items);
        openTimer = null;
      }, 220);
    });
  });

  requestAnimationFrame(() => {
    state.images.items.forEach((item) => {
      const safeId = domSafeId(item.key);
      const canvasId = `imageTileCanvas-${safeId}`;
      const frameId = `imageTileFrame-${safeId}`;
      if (document.getElementById(canvasId) && document.getElementById(frameId)) {
        void paintContainCanvas(canvasId, frameId, item.image_url);
      }
    });
  });

  document.getElementById("loadMoreImages")?.addEventListener("click", async () => {
    await loadImagePage(false);
  });
}

async function toggleImageSave(item) {
  const normalized = normalizeImageItem(item);
  if (!normalized) {
    return;
  }
  await api("/api/images/toggle", {
    method: "POST",
    body: JSON.stringify({
      articleId: normalized.article_id,
      figureIndex: normalized.figure_index,
      imageUrl: normalized.image_url,
      imageKey: normalized.key,
    }),
  });
  const key = normalized.key;
  const nextSaved = !state.savedImageKeys.has(key);
  if (nextSaved) {
    state.savedImageKeys.add(key);
  } else {
    state.savedImageKeys.delete(key);
  }
  item.saved = nextSaved;
  item.article_id = normalized.article_id;
  item.figure_index = normalized.figure_index;
  item.image_url = normalized.image_url;
  item.key = normalized.key;
  state.images.items.forEach((entry) => {
    if (entry.key === key) {
      entry.saved = nextSaved;
    }
  });
  state.collection.savedImages = nextSaved
    ? state.collection.savedImages
    : state.collection.savedImages.filter((entry) => entry.key !== key);
  state.savedImageIndexLoaded = true;
  await loadBootstrap();
  rerenderCurrentScreen();
}

function openImageModal(key, items) {
  const item = items.find((entry) => entry.key === key);
  if (!item) return;
  const figureLabel = `Figure ${Number(item.figure_index ?? 0) + 1}`;
  refs.modalBody.innerHTML = `
    <div class="modal-meta">${escapeHtml(item.journal_title || "Nature")} · ${escapeHtml(formatDate(item.published_at))}</div>
    <p class="modal-caption">${escapeHtml(item.title || figureLabel)}</p>
    <h3>${escapeHtml(item.article_title || "")}</h3>
    <div class="modal-image">
      <img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title || item.article_title || "科研图片")}" />
    </div>
    <a class="primary-link" href="${escapeHtml(item.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
  `;
  refs.imageModal.classList.remove("hidden");
}

function closeModal() {
  refs.imageModal.classList.add("hidden");
}

async function renderCollectionScreen() {
  const allPapers = await api("/api/my/papers?query=");
  if (state.collection.tab === "images") {
    const images = await api("/api/my/images");
    state.collection.savedImages = images.items;
    images.items.forEach((item) => primeImageMeta(item.image_url));
  }

  const papers = allPapers.items.filter((item) => {
    const matchesQuery =
      !state.collection.query ||
      [item.title, item.rss_title, item.journal_title, item.state?.note]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(state.collection.query.toLowerCase());
    const matchesJournal =
      state.collection.journal === "all" || item.journal_title === state.collection.journal;
    return matchesQuery && matchesJournal;
  });

  const savedImages = state.collection.savedImages.filter((item) => {
    return state.collection.journal === "all" || item.journal_title === state.collection.journal;
  });

  const journalOptions = uniqueJournals(
    state.collection.tab === "papers" ? allPapers.items : state.collection.savedImages,
    (item) => item.journal_title,
  );
  const journalFilters = [
    `<button class="filter-pill ${state.collection.journal === "all" ? "active" : ""}" data-collection-journal="all" type="button">全部期刊</button>`,
    ...journalOptions.map(
      (journal) =>
        `<button class="filter-pill ${state.collection.journal === journal ? "active" : ""}" data-collection-journal="${escapeHtml(journal)}" type="button">${escapeHtml(journal)}</button>`,
    ),
  ].join("");

  refs.collectionPanel.innerHTML = `
    <section class="collection-page">
      <header class="page-head">
        <h1>收藏</h1>
        <p>论文收藏与图片收藏分开管理，承接后续精读与灵感留存。</p>
      </header>

      <div class="sub-tabs">
        <button class="sub-tab ${state.collection.tab === "papers" ? "active" : ""}" data-collection-tab="papers" type="button">论文收藏夹</button>
        <button class="sub-tab ${state.collection.tab === "images" ? "active" : ""}" data-collection-tab="images" type="button">图片收藏夹</button>
      </div>

      <section class="filter-toolbar">
        <div class="filter-row">${journalFilters}</div>
        ${
          state.collection.tab === "papers"
            ? `
          <div class="inline-actions">
            <button id="copyPaperUrls" class="secondary-button" type="button" ${papers.length ? "" : "disabled"}>复制原文 URL</button>
          </div>
        `
            : ""
        }
      </section>

      ${
        state.collection.tab === "papers"
          ? `
        <div class="search-row">
          <input id="collectionSearch" type="search" value="${escapeHtml(state.collection.query)}" placeholder="搜索标题 / 期刊名 / 备注" />
        </div>
        <div class="list-stack">
          ${
            papers.length
              ? papers
                  .map(
                    (item) => `
                    <article class="saved-paper-card">
                      <div class="saved-paper-meta">${escapeHtml(item.journal_title || "")} · ${escapeHtml(formatDate(item.state?.saved_at || item.published_at))}</div>
                      <h3>${escapeHtml(item.title || item.rss_title || "")}</h3>
                      <p>${escapeHtml(item.state?.note || "暂无备注")}</p>
                      <div class="saved-paper-actions">
                        <a class="secondary-link" href="${escapeHtml(item.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
                        <button class="secondary-button" data-unsave-paper="${escapeHtml(item.id)}" type="button">移出收藏</button>
                      </div>
                    </article>
                  `,
                  )
                  .join("")
              : '<div class="empty-card"><h2>还没有收藏论文</h2><p>点击论文卡片底部“收藏论文”后，会进入这里。</p></div>'
          }
        </div>
      `
          : `
        <div class="saved-image-grid">
          ${
            savedImages.length
              ? savedImages
                  .map((item) => {
                    const ratio = getAspectRatio(state.imageMeta[item.image_url]);
                    return `
                      <article class="saved-image-tile" data-saved-image="${escapeHtml(item.key)}">
                        <div class="image-tile-media" style="aspect-ratio:${ratio}">
                          <img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.article_title || "科研图片")}" loading="lazy" />
                        </div>
                      </article>
                    `;
                  })
                  .join("")
              : '<div class="empty-card"><h2>还没有收藏图片</h2><p>在图片速览模式中双击图片后，会进入这里。</p></div>'
          }
        </div>
      `
      }
    </section>
  `;

  refs.collectionPanel.querySelectorAll("[data-collection-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.collection.tab = button.dataset.collectionTab;
      state.collection.journal = "all";
      await renderCollectionScreen();
    });
  });

  refs.collectionPanel.querySelectorAll("[data-collection-journal]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.collection.journal = button.dataset.collectionJournal;
      await renderCollectionScreen();
    });
  });

  document.getElementById("collectionSearch")?.addEventListener("input", async (event) => {
    state.collection.query = event.target.value;
    await renderCollectionScreen();
  });

  document.getElementById("copyPaperUrls")?.addEventListener("click", async () => {
    const urls = papers.map((item) => item.article_url).filter(Boolean).join("\n");
    if (!urls) return;
    try {
      await navigator.clipboard.writeText(urls);
    } catch {
      window.prompt("复制以下原文 URL", urls);
    }
  });

  refs.collectionPanel.querySelectorAll("[data-unsave-paper]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/articles/${button.dataset.unsavePaper}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "unsave" }),
      });
      await loadBootstrap();
      await renderCollectionScreen();
    });
  });

  refs.collectionPanel.querySelectorAll("[data-saved-image]").forEach((card) => {
    card.addEventListener("click", () => {
      openImageModal(card.dataset.savedImage, state.collection.savedImages);
    });
  });
}

function renderSubscriptionScreen() {
  const items = state.overview?.subscriptions || [];
  const suggestions = SUGGESTED_SUBSCRIPTIONS.map(
    (item) => `
      <button class="secondary-button" data-prefill-subscription="${escapeHtml(item.url)}" data-prefill-name="${escapeHtml(item.name)}" type="button">${escapeHtml(item.name)}</button>
    `,
  ).join("");
  refs.subscriptionPanel.innerHTML = `
    <section class="subscription-page">
      <header class="page-head">
        <h1>订阅管理</h1>
        <p>决定看什么、先看什么。V1 先保留 RSS 添加、删除与优先级调整。</p>
      </header>

      <section class="saved-paper-card">
        <div class="saved-paper-meta">内置期刊</div>
        <h3>快速添加常见 Nature 系期刊</h3>
        <div class="inline-actions">${suggestions}</div>
      </section>

      <form id="subscriptionForm" class="subscription-form">
        <input id="subscriptionName" type="text" placeholder="期刊名称" />
        <input id="subscriptionUrl" type="url" placeholder="RSS URL" />
        <button class="primary-button" type="submit">添加订阅</button>
      </form>

      <div class="list-stack">
        ${
          items.length
            ? items
                .map(
                  (item) => `
                  <article class="saved-paper-card">
                    <div class="saved-paper-meta">优先级 ${item.priority}</div>
                    <h3>${escapeHtml(item.name)}</h3>
                    <p>${escapeHtml(item.url)}</p>
                    <div class="saved-paper-actions">
                      <button class="secondary-button" data-sub-action="up" data-sub-id="${escapeHtml(item.id)}" type="button">上移</button>
                      <button class="secondary-button" data-sub-action="down" data-sub-id="${escapeHtml(item.id)}" type="button">下移</button>
                      <button class="secondary-button warn" data-sub-action="delete" data-sub-id="${escapeHtml(item.id)}" type="button">删除</button>
                    </div>
                  </article>
                `,
                )
                .join("")
            : '<div class="empty-card"><h2>暂无订阅</h2><p>添加 RSS 后，新的论文会进入今日新增或待阅读。</p></div>'
        }
      </div>
    </section>
  `;

  document.getElementById("subscriptionForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("subscriptionName").value.trim();
    const url = document.getElementById("subscriptionUrl").value.trim();
    if (!name || !url) return;
    await api("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name, url }),
    });
    await loadBootstrap();
    renderSubscriptionScreen();
  });

  refs.subscriptionPanel.querySelectorAll("[data-prefill-subscription]").forEach((button) => {
    button.addEventListener("click", async () => {
      const name = button.dataset.prefillName;
      const url = button.dataset.prefillSubscription;
      await api("/api/subscriptions", {
        method: "POST",
        body: JSON.stringify({ name, url }),
      });
      await loadBootstrap();
      renderSubscriptionScreen();
    });
  });

  refs.subscriptionPanel.querySelectorAll("[data-sub-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = button.dataset.subId;
      const action = button.dataset.subAction;
      if (action === "delete") {
        await api(`/api/subscriptions/${id}`, { method: "DELETE" });
      } else {
        await api(`/api/subscriptions/${id}/reorder`, {
          method: "POST",
          body: JSON.stringify({ direction: action }),
        });
      }
      await loadBootstrap();
      renderSubscriptionScreen();
    });
  });
}

function renderMyScreen() {
  const counts = state.overview?.counts || {};
  const stats = state.overview?.stats || {};
  refs.myPanel.innerHTML = `
    <section class="my-page">
      <header class="page-head">
        <h1>我的</h1>
        <p>承接低频管理功能，避免干扰首页高频阅读流。</p>
      </header>

      <section class="hub-list">
        <button class="hub-card hub-link" data-go-screen="collection" data-go-collection="papers" type="button">
          <h3>论文收藏夹</h3>
          <p>查看已收藏论文、备注与原文链接。</p>
        </button>
        <button class="hub-card hub-link" data-go-screen="collection" data-go-collection="images" type="button">
          <h3>图片收藏夹</h3>
          <p>仅保留图片缩略图，方便灵感回看。</p>
        </button>
        <button class="hub-card hub-link" data-go-screen="subscriptions" type="button">
          <h3>订阅管理</h3>
          <p>管理 RSS 来源和优先级顺序。</p>
        </button>
      </section>

      <section class="stats-grid">
        <article class="stats-card">
          <span>累计浏览论文数</span>
          <strong>${escapeHtml(String(stats.browsedArticles || 0))}</strong>
        </article>
        <article class="stats-card">
          <span>累计收藏论文数</span>
          <strong>${escapeHtml(String(counts.savedPapers || 0))}</strong>
        </article>
        <article class="stats-card">
          <span>累计收藏图片数</span>
          <strong>${escapeHtml(String(counts.savedImages || 0))}</strong>
        </article>
        <article class="stats-card">
          <span>累计已精读论文数</span>
          <strong>${escapeHtml(String(stats.deepReadCount || 0))}</strong>
        </article>
      </section>

      <section class="hub-list">
        <article class="hub-card">
          <h3>阅读统计</h3>
          <p>累计浏览、收藏与已精读数据统一沉淀在这里。</p>
        </article>
        <article class="hub-card">
          <h3>设置</h3>
          <p>V1 先保留账号安全与清除浏览记录入口。</p>
        </article>
        <article class="hub-card">
          <h3>意见反馈</h3>
          <p>站内简单文本提交与联系邮箱入口后续接入。</p>
        </article>
        <article class="hub-card">
          <h3>账号</h3>
          <p>后续接入邮箱注册、邮箱密码登录与退出登录。</p>
        </article>
        <article class="hub-card muted">
          <h3>回收站</h3>
          <p>V1 结构已预留，等待后端恢复 / 彻底删除能力接入。</p>
        </article>
      </section>
    </section>
  `;
}

function rerenderCurrentScreen() {
  if (!state.overview) return;
  if (state.screen === "home") {
    if (state.mode === "images") {
      renderImages();
    } else {
      renderReader();
    }
    return;
  }
  if (state.screen === "collection") {
    renderCollectionScreen();
  } else if (state.screen === "subscriptions") {
    renderSubscriptionScreen();
  } else {
    renderMyScreen();
  }
  if (state.readerPreview.open) {
    renderReaderPreview();
  }
}

function attachGlobalEvents() {
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", async () => {
      await switchMode(button.dataset.mode);
    });
  });

  document.querySelectorAll(".bottom-tab").forEach((button) => {
    button.addEventListener("click", async () => {
      state.screen = button.dataset.screen;
      renderBottomNav();
      rerenderCurrentScreen();
    });
  });

  document.getElementById("closeModal").addEventListener("click", closeModal);
  refs.imageModal.addEventListener("click", (event) => {
    if (event.target.dataset.closeModal) {
      closeModal();
    }
  });
  refs.readerPreviewModal.addEventListener("click", (event) => {
    if (event.target.dataset.closeReaderPreview) {
      closeReaderPreview();
    }
  });
  refs.readerPreviewBody.addEventListener("click", (event) => {
    if (!event.target.closest("#readerPreviewStage")) {
      closeReaderPreview();
    }
  });

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("[data-go-screen]");
    if (!target) return;
    state.screen = target.dataset.goScreen;
    if (target.dataset.goCollection) {
      state.collection.tab = target.dataset.goCollection;
      state.collection.journal = "all";
    }
    renderBottomNav();
    rerenderCurrentScreen();
  });
}

async function init() {
  syncViewportMetrics();
  attachTouchGuards();
  attachGlobalEvents();
  renderBottomNav();
  await loadBootstrap();
  await switchMode("today");
}

window.addEventListener("resize", scheduleViewportSync);
window.addEventListener("orientationchange", scheduleViewportSync);
window.visualViewport?.addEventListener("resize", scheduleViewportSync);
window.visualViewport?.addEventListener("scroll", scheduleViewportSync);

init();
