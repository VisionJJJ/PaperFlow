const state = {
  screen: "home",
  mode: "today",
  my: {
    collectionTab: "papers",
    manageTab: "subscriptions",
  },
  imageMeta: {},
  imageMetaPending: {},
  imageAssets: {},
  imageAssetPending: {},
  overview: null,
  feeds: {
    today: createFeedState(),
    queue: createFeedState(),
  },
  images: createImageState(),
};

let readerImageResizeObserver = null;

const refs = {
  syncButtons: Array.from(document.querySelectorAll("[data-sync-trigger]")),
  syncButton: document.getElementById("syncButton"),
  modeTabs: document.getElementById("modeTabs"),
  bottomNav: document.getElementById("bottomNav"),
  homeSection: document.getElementById("homeSection"),
  collectionSection: document.getElementById("collectionSection"),
  subscriptionSection: document.getElementById("subscriptionSection"),
  readerPanel: document.getElementById("readerPanel"),
  imagePanel: document.getElementById("imagePanel"),
  savedPapers: document.getElementById("savedPapers"),
  savedImages: document.getElementById("savedImages"),
  subscriptionList: document.getElementById("subscriptionList"),
  statsPanel: document.getElementById("statsPanel"),
  paperSearch: document.getElementById("paperSearch"),
  collectionTitle: document.getElementById("collectionTitle"),
  manageTitle: document.getElementById("manageTitle"),
  manageSubscriptions: document.getElementById("manageSubscriptions"),
  manageStats: document.getElementById("manageStats"),
  imageModal: document.getElementById("imageModal"),
  modalBody: document.getElementById("modalBody"),
};

function setSyncButtonsState(isLoading) {
  refs.syncButtons.forEach((button) => {
    if (!button.dataset.idleLabel) {
      button.dataset.idleLabel = button.textContent.trim();
    }
    button.disabled = isLoading;
    button.textContent = isLoading ? "同步中..." : button.dataset.idleLabel;
  });
}

function createFeedState() {
  return {
    ids: [],
    details: {},
    offset: 0,
    total: 0,
    currentIndex: 0,
    history: [],
    expanded: false,
    activeFigure: 0,
    loading: false,
    hasMore: true,
  };
}

function createImageState() {
  return {
    items: [],
    offset: 0,
    total: 0,
    hasMore: true,
    journal: "all",
    savedOnly: false,
    loading: false,
  };
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
  if (!value) return "日期待补充";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function currentFeed() {
  return state.feeds[state.mode];
}

function resetFeeds() {
  state.feeds.today = createFeedState();
  state.feeds.queue = createFeedState();
  state.images = createImageState();
}

function getAspectRatio(meta) {
  if (!meta?.width || !meta?.height) return "1 / 1";
  return `${meta.width} / ${meta.height}`;
}

function getStagePaddingPercent(meta) {
  if (!meta?.width || !meta?.height) return "68%";
  const ratio = (meta.height / meta.width) * 100;
  return `${Math.max(48, Math.min(ratio, 120))}%`;
}

function refreshVisibleView() {
  if (state.screen !== "home") return;
  if (state.mode === "images") {
    renderImages();
  } else {
    renderReader();
  }
}

function updateReaderStageHeight() {
  const activePanel =
    state.screen === "my" ? refs.myStack : state.mode === "images" ? refs.imagePanel : refs.readerPanel;
  const availableHeight = Math.max(320, activePanel?.clientHeight || 320);
  const availableWidth = Math.max(
    320,
    activePanel?.clientWidth || 0,
    refs.homeSection?.clientWidth || 0,
    document.documentElement.clientWidth || 0,
  );
  const isPhone = availableWidth <= 480;
  const isCompact = availableWidth <= 720;
  let mediaRatio = 0.5;
  let mediaMax = 520;
  let titleFactor = 0.065;
  let titleMin = 30;
  let titleMax = 54;

  if (isPhone) {
    mediaRatio = 0.4;
    mediaMax = 220;
    titleFactor = 0.034;
    titleMin = 18;
    titleMax = 22;
  } else if (isCompact) {
    mediaRatio = 0.43;
    mediaMax = 280;
    titleFactor = 0.038;
    titleMin = 19;
    titleMax = 24;
  } else if (availableWidth <= 1024) {
    mediaRatio = 0.48;
    mediaMax = 400;
    titleFactor = 0.053;
    titleMin = 24;
    titleMax = 38;
  }

  const mediaHeight = Math.max(160, Math.min(Math.round(availableHeight * mediaRatio), mediaMax));
  const titleSize = Math.max(titleMin, Math.min(Math.round(availableHeight * titleFactor), titleMax));
  const headlineMaxHeight = Math.max(84, Math.round(availableHeight * (isPhone ? 0.2 : isCompact ? 0.23 : 0.28)));
  const thumbHeight = Math.max(42, Math.round(availableHeight * (isPhone ? 0.075 : isCompact ? 0.085 : 0.1)));
  const footerMaxHeight = Math.max(108, Math.round(availableHeight * (isPhone ? 0.23 : isCompact ? 0.26 : 0.3)));
  const detailMaxHeight = Math.max(108, Math.round(availableHeight * (isPhone ? 0.16 : isCompact ? 0.18 : 0.24)));

  document.documentElement.style.setProperty("--reader-media-height", `${mediaHeight}px`);
  document.documentElement.style.setProperty("--reader-title-size", `${titleSize}px`);
  document.documentElement.style.setProperty("--reader-headline-max-height", `${headlineMaxHeight}px`);
  document.documentElement.style.setProperty("--reader-thumb-height", `${thumbHeight}px`);
  document.documentElement.style.setProperty("--reader-footer-max-height", `${footerMaxHeight}px`);
  document.documentElement.style.setProperty("--reader-detail-max-height", `${detailMaxHeight}px`);
}

function primeImageMeta(url) {
  if (!url || state.imageMeta[url] || state.imageMetaPending[url]) {
    return state.imageMetaPending[url] || Promise.resolve(state.imageMeta[url] || null);
  }

  state.imageMetaPending[url] = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      state.imageMeta[url] = {
        width: img.naturalWidth,
        height: img.naturalHeight,
      };
      delete state.imageMetaPending[url];
      refreshVisibleView();
      resolve(state.imageMeta[url]);
    };
    img.onerror = () => {
      delete state.imageMetaPending[url];
      resolve(null);
    };
    img.src = url;
  });

  return state.imageMetaPending[url];
}

function loadImageAsset(url) {
  if (!url) return Promise.resolve(null);
  if (state.imageAssets[url]) return Promise.resolve(state.imageAssets[url]);
  if (state.imageAssetPending[url]) return state.imageAssetPending[url];

  state.imageAssetPending[url] = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      state.imageAssets[url] = img;
      if (!state.imageMeta[url]) {
        state.imageMeta[url] = {
          width: img.naturalWidth,
          height: img.naturalHeight,
        };
      }
      delete state.imageAssetPending[url];
      resolve(img);
    };
    img.onerror = () => {
      delete state.imageAssetPending[url];
      resolve(null);
    };
    img.src = url;
  });

  return state.imageAssetPending[url];
}

function primeFigureSet(figures = []) {
  figures.forEach((figure) => {
    if (figure?.image_url) {
      primeImageMeta(figure.image_url);
    }
  });
}

function primeImageItems(items = []) {
  items.forEach((item) => {
    if (item?.image_url) {
      primeImageMeta(item.image_url);
    }
  });
}

async function loadBootstrap() {
  state.overview = await api("/api/bootstrap");
  renderOverview();
  updateReaderStageHeight();
  await renderMyPage();
}

function renderOverview() {
  if (!state.overview) return;
  const { counts } = state.overview;
  const labels = {
    today: `今日阅读 ${counts.today}`,
    queue: `待处理 ${counts.queue}`,
    images: "图片速览",
  };
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.textContent = labels[button.dataset.mode] || button.textContent;
  });
}

async function syncFeeds() {
  setSyncButtonsState(true);
  refs.syncButton.textContent = "同步中...";
  try {
    await api("/api/sync", {
      method: "POST",
      body: JSON.stringify({ rssUrl: "https://www.nature.com/ncomms.rss" }),
    });
    resetFeeds();
    await loadBootstrap();
    await switchMode(state.mode);
  } finally {
    setSyncButtonsState(false);
    refs.syncButton.textContent = "同步 RSS";
  }
}

async function ensureFeedPage(mode) {
  const feed = state.feeds[mode];
  if (feed.loading || !feed.hasMore) return;
  feed.loading = true;
  renderReader();
  try {
    const page = await api(`/api/feed?mode=${mode}&offset=${feed.offset}&limit=12`);
    feed.ids.push(...page.ids);
    feed.offset += page.ids.length;
    feed.total = page.total;
    feed.hasMore = page.has_more;
    if (page.ids.length) {
      const details = await api(`/api/article-details?ids=${page.ids.join(",")}`);
      details.items.forEach((item) => {
        feed.details[item.id] = item;
        primeFigureSet(item.figures || []);
      });
    }
  } finally {
    feed.loading = false;
    renderReader();
  }
}

async function switchMode(mode) {
  state.mode = mode;
  renderOverview();
  updateReaderStageHeight();
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });

  if (mode === "images") {
    refs.readerPanel.classList.add("hidden");
    refs.imagePanel.classList.remove("hidden");
    if (!state.images.items.length) {
      await loadImagePage(true);
    } else {
      renderImages();
    }
    return;
  }

  refs.readerPanel.classList.remove("hidden");
  refs.imagePanel.classList.add("hidden");
  if (!state.feeds[mode].ids.length) {
    await ensureFeedPage(mode);
  } else {
    renderReader();
  }
}

function articleStatusLabel(detail) {
  const status = detail?.state?.status || "unread";
  if (status === "saved") return "已收藏";
  if (status === "dismissed") return "不感兴趣";
  if (status === "viewed") return "已浏览";
  return "未处理";
}

function activeDetail() {
  const feed = currentFeed();
  const id = feed.ids[feed.currentIndex];
  return id ? feed.details[id] : null;
}

function buildReaderEmptyState(mode) {
  const title = mode === "today" ? "今天的阅读流已经处理完" : "当前没有待处理论文";
  const body =
    mode === "today"
      ? "可以切换到待处理继续处理，或者进入图片速览找图。"
      : "同步新 RSS 后，这里会显示尚未处理的历史内容。";
  return `
    <div class="panel empty-state">
      <h3>${title}</h3>
      <p>${body}</p>
    </div>
  `;
}

function drawImageToCanvas(frame, canvas, image, meta) {
  if (!frame || !canvas || !image || !meta?.width || !meta?.height) return;
  const frameWidth = frame.clientWidth;
  const frameHeight = frame.clientHeight;
  if (!frameWidth || !frameHeight) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const deviceScale = window.devicePixelRatio || 1;
  const padding = Math.max(10, Math.round(Math.min(frameWidth, frameHeight) * 0.035));
  const availableWidth = Math.max(1, frameWidth - padding * 2);
  const availableHeight = Math.max(1, frameHeight - padding * 2);
  const scale = Math.min(availableWidth / meta.width, availableHeight / meta.height);
  const drawWidth = Math.max(1, Math.round(meta.width * scale));
  const drawHeight = Math.max(1, Math.round(meta.height * scale));
  const offsetX = Math.round((frameWidth - drawWidth) / 2);
  const offsetY = Math.round((frameHeight - drawHeight) / 2);

  canvas.width = Math.max(1, Math.round(frameWidth * deviceScale));
  canvas.height = Math.max(1, Math.round(frameHeight * deviceScale));
  canvas.style.width = `${frameWidth}px`;
  canvas.style.height = `${frameHeight}px`;

  context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
  context.clearRect(0, 0, frameWidth, frameHeight);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, frameWidth, frameHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

function disconnectReaderImageObserver() {
  if (readerImageResizeObserver) {
    readerImageResizeObserver.disconnect();
    readerImageResizeObserver = null;
  }
}

function resolveReaderImageMeta(image, figure) {
  if (figure?.image_url && state.imageMeta[figure.image_url]) {
    return state.imageMeta[figure.image_url];
  }
  if (image?.naturalWidth && image?.naturalHeight) {
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  }
  return null;
}

function applyReaderImageFitting() {
  disconnectReaderImageObserver();

  const frame = refs.readerPanel.querySelector(".image-frame");
  const canvas = frame?.querySelector("canvas");
  const active = activeDetail();
  const feed = currentFeed();
  const figure = active?.figures?.[feed.activeFigure];
  if (!frame || !canvas || !figure?.image_url) return;

  const runFit = async () => {
    const asset = await loadImageAsset(figure.image_url);
    const meta = resolveReaderImageMeta(asset, figure);
    if (!asset || !meta) return;
    drawImageToCanvas(frame, canvas, asset, meta);
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(runFit);
  });

  if (typeof ResizeObserver !== "undefined") {
    readerImageResizeObserver = new ResizeObserver(() => {
      runFit();
    });
    readerImageResizeObserver.observe(frame);
  }
}

function renderReader() {
  const feed = currentFeed();
  const detail = activeDetail();
  const progress = state.overview?.progress || { todayHandled: 0, todayTotal: 0 };

  if (!feed.ids.length && !feed.loading) {
    refs.readerPanel.innerHTML = buildReaderEmptyState(state.mode);
    return;
  }

  if (!detail) {
    refs.readerPanel.innerHTML = `
      <div class="panel placeholder-card">
        <p>正在批量加载卡片详情...</p>
      </div>
    `;
    return;
  }

  const figures = detail.figures || [];
  primeFigureSet(figures);
  const activeFigure = figures[feed.activeFigure] || null;
  const abstractText = detail.abstract || "暂无摘要";
  const keywords = (detail.keywords?.length ? detail.keywords : ["待补充字段"])
    .map((item) => `<span class="keyword">${escapeHtml(item)}</span>`)
    .join("");
  const thumbs = figures
    .map(
      (figure, index) => `
        <button class="thumbnail-button contain-thumb ${index === feed.activeFigure ? "active" : ""}" data-figure-index="${index}">
          <img src="${escapeHtml(figure.image_url)}" alt="${escapeHtml(figure.title)}" loading="lazy" />
        </button>
      `,
    )
    .join("");

  refs.readerPanel.innerHTML = `
    <article class="panel reader-card featured ${detail.state?.status === "saved" ? "has-note-strip" : ""}" id="swipeSurface">
      <div class="status-line">
        <span>${state.mode === "today" ? "今日阅读" : "待处理"} · ${feed.currentIndex + 1} / ${Math.max(feed.total, feed.ids.length)}</span>
        <span>${escapeHtml(articleStatusLabel(detail))}</span>
      </div>
      ${state.mode === "today" ? `<div class="progress-bar"><span style="width:${progress.todayTotal ? (progress.todayHandled / progress.todayTotal) * 100 : 0}%"></span></div>` : ""}

      <div class="headline-block">
        <div class="issue-line">
          <span class="meta-line">${escapeHtml(formatDate(detail.published_at))}</span>
          <span class="journal-pill">${escapeHtml(detail.journal_title || detail.subscription_name || "Nature")}</span>
          <span class="meta-line">${escapeHtml(detail.article_type || "Article")}</span>
        </div>
        <h2 class="card-title">${escapeHtml(detail.title || detail.rss_title || "Untitled")}</h2>
        <div class="keyword-row">${keywords}</div>
      </div>

      <div class="media-stage">
        <div class="image-stage-shell image-stage-fixed">
          <div class="hero-image ${activeFigure ? "" : "placeholder"}">
            ${activeFigure ? `<div class="image-frame"><canvas class="reader-image-canvas" aria-label="${escapeHtml(activeFigure.title || "article figure")}" role="img"></canvas></div>` : ""}
          </div>
        </div>
        ${figures.length ? `<div class="thumb-strip">${thumbs}</div>` : ""}
      </div>

      <div class="reader-footer">
        <div class="action-row">
          <div class="action-pack">
            <button class="action-button warn" data-action="dismissed">不感兴趣</button>
            <button class="action-button" data-action="previous" ${feed.history.length ? "" : "disabled"}>上一条</button>
            <button class="action-button" data-action="toggle-details">${feed.expanded ? "收起详情" : "展开详情"}</button>
          </div>
          <div class="action-pack">
            <button class="action-button ${detail.state?.status === "saved" ? "saved" : ""}" data-action="saved">${detail.state?.status === "saved" ? "已收藏" : "收藏论文"}</button>
            <button class="action-button primary" data-action="next">下一条</button>
          </div>
        </div>

        ${
          detail.state?.status === "saved"
            ? `
          <section class="saved-note-strip">
            <h3>备注</h3>
            <div class="saved-note-controls">
              <textarea id="noteInput" rows="2" placeholder="补一句备注，默认进入未分类。">${escapeHtml(detail.state?.note || "")}</textarea>
              <button class="action-button saved" data-action="save-note">保存备注</button>
            </div>
          </section>
        `
            : ""
        }

        <section class="detail-panel ${feed.expanded ? "open" : ""}">
          <div class="detail-list">
            <div class="detail-item">
              <strong>摘要</strong>
              <div class="detail-copy">${escapeHtml(abstractText)}</div>
            </div>
            <div class="detail-item">
              <strong>第一单位</strong>
              <div class="detail-copy">${escapeHtml(detail.first_author_affiliation || "暂无")}</div>
            </div>
            <div class="detail-item">
              <strong>作者</strong>
              <div class="detail-copy">${escapeHtml((detail.authors || []).join(", ") || "暂无")}</div>
            </div>
            <div class="detail-item">
              <strong>原文入口</strong>
              <div class="detail-copy"><a href="${escapeHtml(detail.article_url)}" target="_blank" rel="noreferrer">查看原文</a></div>
            </div>
          </div>
          <div class="action-group">
            <button class="action-button" data-action="copy-link">复制原文链接</button>
          </div>
        </section>
      </div>
    </article>
  `;

  applyReaderImageFitting();
  attachReaderEvents();
  maybePrefetchNext();
}

function attachReaderEvents() {
  const feed = currentFeed();
  refs.readerPanel.querySelectorAll("[data-figure-index]").forEach((button) => {
    button.addEventListener("click", () => {
      feed.activeFigure = Number(button.dataset.figureIndex);
      renderReader();
    });
  });

  refs.readerPanel.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      await handleReaderAction(button.dataset.action);
    });
  });

  const swipeSurface = document.getElementById("swipeSurface");
  let startX = 0;
  swipeSurface.addEventListener("pointerdown", (event) => {
    startX = event.clientX;
  });
  swipeSurface.addEventListener("pointerup", async (event) => {
    const delta = event.clientX - startX;
    if (Math.abs(delta) < 56) return;
    if (delta < 0) await handleReaderAction("next");
    else if (feed.history.length) await handleReaderAction("previous");
  });
}

async function maybePrefetchNext() {
  const feed = currentFeed();
  if (state.mode === "images") return;
  if (feed.currentIndex >= feed.ids.length - 4 && feed.hasMore && !feed.loading) {
    await ensureFeedPage(state.mode);
  }
}

async function handleReaderAction(action) {
  const feed = currentFeed();
  const detail = activeDetail();
  if (!detail) return;

  if (action === "toggle-details") {
    feed.expanded = !feed.expanded;
    renderReader();
    return;
  }

  if (action === "previous") {
    const previousIndex = feed.history.pop();
    if (previousIndex !== undefined) {
      feed.currentIndex = previousIndex;
      feed.activeFigure = 0;
      renderReader();
    }
    return;
  }

  if (action === "save-note") {
    const note = document.getElementById("noteInput")?.value || "";
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "note", note }),
    });
    detail.state.note = note;
    await loadBootstrap();
    renderReader();
    return;
  }

  if (action === "copy-link") {
    await navigator.clipboard.writeText(detail.article_url);
    return;
  }

  if (action === "saved") {
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({
        action: detail.state?.status === "saved" ? "unsave" : "saved",
      }),
    });
    detail.state.status = detail.state?.status === "saved" ? "viewed" : "saved";
    await loadBootstrap();
    renderReader();
    return;
  }

  if (action === "dismissed") {
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "dismissed" }),
    });
  }

  if (action === "next" && detail.state?.status !== "saved") {
    await api(`/api/articles/${detail.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action: "viewed" }),
    });
  }

  feed.history.push(Math.max(feed.currentIndex - 1, 0));
  if (feed.history.length > 5) feed.history.shift();
  feed.ids.splice(feed.currentIndex, 1);
  delete feed.details[detail.id];
  feed.activeFigure = 0;

  if (feed.currentIndex >= feed.ids.length && feed.hasMore) {
    await ensureFeedPage(state.mode);
  }
  if (feed.currentIndex >= feed.ids.length) {
    feed.currentIndex = Math.max(feed.ids.length - 1, 0);
  }

  await loadBootstrap();
  renderReader();
}

async function loadImagePage(reset = false) {
  if (reset) {
    state.images = {
      ...createImageState(),
      journal: state.images.journal,
      savedOnly: state.images.savedOnly,
    };
  }

  const imageState = state.images;
  if (imageState.loading) return;
  imageState.loading = true;
  renderImages();

  try {
    const page = await api(
      `/api/images?offset=${imageState.offset}&limit=24&journal=${encodeURIComponent(imageState.journal)}&savedOnly=${imageState.savedOnly}`,
    );
    imageState.items.push(...page.items);
    primeImageItems(imageState.items);
    imageState.offset += page.items.length;
    imageState.total = page.total;
    imageState.hasMore = page.has_more;
  } finally {
    imageState.loading = false;
    renderImages();
  }
}

function renderImages() {
  const journals = state.overview?.journals || [];
  const filters = [
    `<button class="filter-pill ${state.images.journal === "all" ? "active" : ""}" data-journal="all">全部期刊</button>`,
    ...journals.map(
      (journal) =>
        `<button class="filter-pill ${state.images.journal === journal ? "active" : ""}" data-journal="${escapeHtml(journal)}">${escapeHtml(journal)}</button>`,
    ),
  ].join("");

  refs.imagePanel.innerHTML = `
    <div class="panel image-toolbar">
      <div class="filter-row">${filters}</div>
      <button class="filter-pill ${state.images.savedOnly ? "active" : ""}" data-toggle-saved="true">只看已收藏</button>
    </div>
    <div class="panel image-gallery-panel">
      <div class="image-masonry">
        ${
          state.images.items
            .map((item) => {
              const meta = state.imageMeta[item.image_url];
              return `
                <article class="image-tile" data-image-key="${escapeHtml(item.key)}">
                  <div class="image-tile-media" style="aspect-ratio:${getAspectRatio(meta)}">
                    <img class="contained-image" src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}" loading="lazy" />
                  </div>
                  <div class="image-tile-copy">
                    <div class="meta-line">${escapeHtml(item.journal_title || "Nature")} · ${escapeHtml(formatDate(item.published_at))}</div>
                    <div>${item.saved ? '<span class="saved-dot">已收藏</span>' : ""}</div>
                  </div>
                </article>
              `;
            })
            .join("") || "<p>暂无图像卡片。</p>"
        }
      </div>
      ${state.images.hasMore ? '<button id="loadMoreImages" class="ghost-button" style="margin-top:12px">继续加载</button>' : ""}
    </div>
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
    tile.addEventListener("click", () => openImageModal(tile.dataset.imageKey));
    tile.addEventListener("dblclick", async () => {
      const image = state.images.items.find((item) => item.key === tile.dataset.imageKey);
      if (image) await toggleImageSave(image);
    });
  });

  document.getElementById("loadMoreImages")?.addEventListener("click", async () => {
    await loadImagePage(false);
  });
}

async function toggleImageSave(item) {
  await api("/api/images/toggle", {
    method: "POST",
    body: JSON.stringify({
      articleId: item.article_id,
      figureIndex: item.figure_index,
      imageUrl: item.image_url,
    }),
  });
  item.saved = !item.saved;
  await loadBootstrap();
  renderImages();
  await renderMyPage();
}

function openImageModal(key) {
  const item = state.images.items.find((entry) => entry.key === key);
  if (!item) return;

  refs.modalBody.innerHTML = `
    <div class="meta-line">${escapeHtml(item.journal_title || "Nature")} · ${escapeHtml(formatDate(item.published_at))}</div>
    <p class="section-label">${escapeHtml(item.title || `Figure ${item.figure_index}`)}</p>
    <h3>${escapeHtml(item.article_title || "")}</h3>
    <div class="modal-image"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.title)}" /></div>
    <div class="action-group">
      <button class="action-button" id="modalSaveImage">${item.saved ? "取消收藏图片" : "收藏图片"}</button>
      <a class="action-button" href="${escapeHtml(item.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
    </div>
  `;
  refs.imageModal.classList.remove("hidden");

  document.getElementById("modalSaveImage").addEventListener("click", async () => {
    await toggleImageSave(item);
    openImageModal(key);
  });
}

function closeModal() {
  refs.imageModal.classList.add("hidden");
}

async function renderMyPage() {
  if (!state.overview) return;
  const { counts, progress, stats, lastSyncedAt } = state.overview;
  const papers = await api(`/api/my/papers?query=${encodeURIComponent(refs.paperSearch.value || "")}`);
  const images = await api("/api/my/images");
  primeImageItems(images.items);

  refs.collectionTitle.textContent = state.my.collectionTab === "papers" ? "收藏论文" : "收藏图片";
  refs.manageTitle.textContent = state.my.manageTab === "subscriptions" ? "订阅管理" : "阅读统计";

  refs.savedPapers.innerHTML = papers.items.length
    ? papers.items
        .map(
          (item) => `
          <article class="saved-paper">
            <div class="meta-line">${escapeHtml(item.journal_title || "")} · ${escapeHtml(formatDate(item.state?.saved_at || item.published_at))}</div>
            <h3>${escapeHtml(item.title || item.rss_title || "")}</h3>
            <p>${escapeHtml(item.state?.note || "暂无备注")}</p>
            <div class="saved-paper-actions">
              <a class="action-button" href="${escapeHtml(item.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
              <button class="action-button" data-reset-paper="${escapeHtml(item.id)}">移出收藏</button>
            </div>
          </article>
        `,
        )
        .join("")
    : `<div class="saved-paper"><p>还没有收藏论文。</p></div>`;

  refs.savedImages.innerHTML = images.items.length
    ? images.items
        .map((item) => {
          const meta = state.imageMeta[item.image_url];
          return `
            <article class="saved-image-card" data-saved-image="${escapeHtml(item.key)}">
              <div class="image-tile-media" style="aspect-ratio:${getAspectRatio(meta)}">
                <img class="contained-image" src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.article_title || "")}" loading="lazy" />
              </div>
            </article>
          `;
        })
        .join("")
    : `<div class="saved-paper"><p>还没有收藏图片。</p></div>`;

  refs.savedPapers.classList.toggle("hidden", state.my.collectionTab !== "papers");
  refs.savedImages.classList.toggle("hidden", state.my.collectionTab !== "images");
  refs.paperSearch.parentElement.classList.toggle("hidden", state.my.collectionTab !== "papers");

  refs.subscriptionList.innerHTML = state.overview.subscriptions
    .map(
      (item) => `
        <article class="subscription-item">
          <div class="meta-line">优先级 ${item.priority}</div>
          <h3>${escapeHtml(item.name)}</h3>
          <div class="subscription-meta">${escapeHtml(item.url)}</div>
          <div class="subscription-actions">
            <button class="action-button" data-reorder="${item.id}" data-direction="up">上移</button>
            <button class="action-button" data-reorder="${item.id}" data-direction="down">下移</button>
            <button class="action-button warn" data-delete-subscription="${item.id}">删除</button>
          </div>
        </article>
      `,
    )
    .join("");

  const statCards = [
    { label: "今日阅读剩余", value: counts.today, desc: `${progress.todayHandled} / ${progress.todayTotal} 已处理` },
    { label: "待处理", value: counts.queue, desc: "历史回补和昨日未处理内容" },
    { label: "收藏论文", value: counts.savedPapers, desc: "进入收藏夹的论文数量" },
    { label: "收藏图片", value: counts.savedImages, desc: "图像速览中双击收藏的图片" },
    { label: "累计浏览论文", value: stats.browsedArticles, desc: "已执行浏览操作的论文数" },
    { label: "最近同步", value: lastSyncedAt ? formatDate(lastSyncedAt) : "未同步", desc: "RSS 最近一次同步时间" },
  ];

  refs.statsPanel.innerHTML = statCards
    .map(
      (item) => `
        <article class="stats-card">
          <div class="section-label">${escapeHtml(item.label)}</div>
          <strong>${escapeHtml(String(item.value))}</strong>
          <p>${escapeHtml(item.desc)}</p>
        </article>
      `,
    )
    .join("");

  refs.manageSubscriptions.classList.toggle("hidden", state.my.manageTab !== "subscriptions");
  refs.manageStats.classList.toggle("hidden", state.my.manageTab !== "stats");

  document.querySelectorAll("[data-collection-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.collectionTab === state.my.collectionTab);
  });
  document.querySelectorAll("[data-manage-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.manageTab === state.my.manageTab);
  });

  refs.savedPapers.querySelectorAll("[data-reset-paper]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/articles/${button.dataset.resetPaper}/action`, {
        method: "POST",
        body: JSON.stringify({ action: "unsave" }),
      });
      await loadBootstrap();
      await renderMyPage();
    });
  });

  refs.savedImages.querySelectorAll("[data-saved-image]").forEach((card) => {
    card.addEventListener("click", () => {
      const item = images.items.find((entry) => entry.key === card.dataset.savedImage);
      if (!item) return;
      refs.modalBody.innerHTML = `
        <div class="meta-line">${escapeHtml(item.journal_title || "")}</div>
        <p class="section-label">${escapeHtml(`Figure ${item.figure_index}`)}</p>
        <h3>${escapeHtml(item.article_title || "")}</h3>
        <div class="modal-image"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.article_title || "")}" /></div>
        <a class="action-button" href="${escapeHtml(item.article_url)}" target="_blank" rel="noreferrer">查看原文</a>
      `;
      refs.imageModal.classList.remove("hidden");
    });
  });

  refs.subscriptionList.querySelectorAll("[data-reorder]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/subscriptions/${button.dataset.reorder}/reorder`, {
        method: "POST",
        body: JSON.stringify({ direction: button.dataset.direction }),
      });
      await loadBootstrap();
      await switchMode(state.mode);
    });
  });

  refs.subscriptionList.querySelectorAll("[data-delete-subscription]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/subscriptions/${button.dataset.deleteSubscription}`, {
        method: "DELETE",
      });
      await loadBootstrap();
      await switchMode(state.mode);
    });
  });
}

buildReaderEmptyState = function buildReaderEmptyStateUpdated(mode) {
  const title = mode === "today" ? "今天没有新的论文卡片" : "当前没有待阅读论文";
  const body =
    mode === "today"
      ? "可以切到待阅读继续处理，或者进入图片预览快速浏览配图。"
      : "同步 RSS 后，这里会展示尚未处理的历史论文。";
  return `
    <div class="panel empty-state">
      <h3>${title}</h3>
      <p>${body}</p>
    </div>
  `;
};

renderOverview = function renderOverviewUpdated() {
  if (!state.overview) return;
  const labels = {
    today: "今日更新",
    queue: "待阅读",
    images: "图片预览",
  };
  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.textContent = labels[button.dataset.mode] || button.textContent;
  });
};

syncFeeds = async function syncFeedsUpdated() {
  setSyncButtonsState(true);
  try {
    await api("/api/sync", {
      method: "POST",
      body: JSON.stringify({ rssUrl: "https://www.nature.com/ncomms.rss" }),
    });
    resetFeeds();
    await loadBootstrap();
    await switchMode(state.mode);
  } finally {
    setSyncButtonsState(false);
  }
};

renderReader = function renderReaderUpdated() {
  const feed = currentFeed();
  const detail = activeDetail();
  const progress = state.overview?.progress || { todayHandled: 0, todayTotal: 0 };

  if (!feed.ids.length && !feed.loading) {
    refs.readerPanel.innerHTML = buildReaderEmptyState(state.mode);
    return;
  }

  if (!detail) {
    refs.readerPanel.innerHTML = `
      <div class="panel placeholder-card">
        <p>正在批量加载卡片详情...</p>
      </div>
    `;
    return;
  }

  const figures = detail.figures || [];
  primeFigureSet(figures);
  const activeFigure = figures[feed.activeFigure] || null;
  const abstractText = detail.abstract || "暂无摘要";
  const keywords = (detail.keywords?.length ? detail.keywords : ["待补充字段"])
    .map((item) => `<span class="keyword">${escapeHtml(item)}</span>`)
    .join("");
  const thumbs = figures
    .map(
      (figure, index) => `
        <button class="thumbnail-button contain-thumb ${index === feed.activeFigure ? "active" : ""}" data-figure-index="${index}">
          <img src="${escapeHtml(figure.image_url)}" alt="${escapeHtml(figure.title)}" loading="lazy" />
        </button>
      `,
    )
    .join("");

  refs.readerPanel.innerHTML = `
    <article class="panel reader-card featured ${detail.state?.status === "saved" ? "has-note-strip" : ""}" id="swipeSurface">
      <div class="status-line">
        <span>${state.mode === "today" ? "今日更新" : "待阅读"} · ${feed.currentIndex + 1} / ${Math.max(feed.total, feed.ids.length)}</span>
        <span>${escapeHtml(articleStatusLabel(detail))}</span>
      </div>
      ${state.mode === "today" ? `<div class="progress-bar"><span style="width:${progress.todayTotal ? (progress.todayHandled / progress.todayTotal) * 100 : 0}%"></span></div>` : ""}

      <div class="headline-block">
        <div class="issue-line">
          <span class="meta-line">${escapeHtml(formatDate(detail.published_at))}</span>
          <span class="journal-pill">${escapeHtml(detail.journal_title || detail.subscription_name || "Nature")}</span>
          <span class="meta-line">${escapeHtml(detail.article_type || "Article")}</span>
        </div>
        <h2 class="card-title">${escapeHtml(detail.title || detail.rss_title || "Untitled")}</h2>
        <div class="keyword-row">${keywords}</div>
      </div>

      <div class="media-stage">
        <div class="image-stage-shell image-stage-fixed">
          <div class="hero-image ${activeFigure ? "" : "placeholder"}">
            ${activeFigure ? `<div class="image-frame"><canvas class="reader-image-canvas" aria-label="${escapeHtml(activeFigure.title || "article figure")}" role="img"></canvas></div>` : ""}
          </div>
        </div>
        ${figures.length ? `<div class="thumb-strip">${thumbs}</div>` : ""}
      </div>

      <div class="reader-footer">
        ${
          detail.state?.status === "saved"
            ? `
          <section class="saved-note-strip">
            <h3>备注</h3>
            <div class="saved-note-controls">
              <textarea id="noteInput" rows="2" placeholder="补一句备注，默认进入未分类。">${escapeHtml(detail.state?.note || "")}</textarea>
              <button class="action-button saved" data-action="save-note">保存备注</button>
            </div>
          </section>
        `
            : ""
        }

        <section class="detail-panel ${feed.expanded ? "open" : ""}">
          <div class="detail-list">
            <div class="detail-item">
              <strong>摘要</strong>
              <div class="detail-copy">${escapeHtml(abstractText)}</div>
            </div>
            <div class="detail-item">
              <strong>第一单位</strong>
              <div class="detail-copy">${escapeHtml(detail.first_author_affiliation || "暂无")}</div>
            </div>
            <div class="detail-item">
              <strong>作者</strong>
              <div class="detail-copy">${escapeHtml((detail.authors || []).join(", ") || "暂无")}</div>
            </div>
            <div class="detail-item">
              <strong>原文入口</strong>
              <div class="detail-copy"><a href="${escapeHtml(detail.article_url)}" target="_blank" rel="noreferrer">查看原文</a></div>
            </div>
          </div>
          <div class="action-group">
            <button class="action-button" data-action="copy-link">复制原文链接</button>
          </div>
        </section>

        <div class="action-row">
          <div class="action-pack">
            <button class="action-button warn" data-action="dismissed">不感兴趣</button>
            <button class="action-button" data-action="previous" ${feed.history.length ? "" : "disabled"}>上一条</button>
            <button class="action-button" data-action="toggle-details">${feed.expanded ? "收起详情" : "展开详情"}</button>
            <button class="action-button ${detail.state?.status === "saved" ? "saved" : ""}" data-action="saved">${detail.state?.status === "saved" ? "已收藏" : "收藏论文"}</button>
            <button class="action-button primary" data-action="next">下一条</button>
          </div>
        </div>
      </div>
    </article>
  `;

  applyReaderImageFitting();
  attachReaderEvents();
  maybePrefetchNext();
};

attachReaderEvents = function attachReaderEventsUpdated() {
  const feed = currentFeed();
  const figures = activeDetail()?.figures || [];

  refs.readerPanel.querySelectorAll("[data-figure-index]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      feed.activeFigure = Number(button.dataset.figureIndex);
      renderReader();
    });
  });

  refs.readerPanel.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await handleReaderAction(button.dataset.action);
    });
  });

  const mediaStage = refs.readerPanel.querySelector(".media-stage");
  if (mediaStage && figures.length > 1) {
    let figureSwipeStartX = 0;
    mediaStage.addEventListener("pointerdown", (event) => {
      figureSwipeStartX = event.clientX;
    });
    mediaStage.addEventListener("pointerup", (event) => {
      const delta = event.clientX - figureSwipeStartX;
      if (Math.abs(delta) < 36) return;
      event.stopPropagation();
      const nextIndex =
        delta < 0
          ? Math.min(feed.activeFigure + 1, figures.length - 1)
          : Math.max(feed.activeFigure - 1, 0);
      if (nextIndex !== feed.activeFigure) {
        feed.activeFigure = nextIndex;
        renderReader();
      }
    });
  }

  const swipeSurface = document.getElementById("swipeSurface");
  let startX = 0;
  swipeSurface.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".media-stage, .action-button, .detail-panel, .saved-note-strip, a, textarea, input, button")) {
      startX = 0;
      return;
    }
    startX = event.clientX;
  });
  swipeSurface.addEventListener("pointerup", async (event) => {
    if (!startX) return;
    if (event.target.closest(".media-stage, .action-button, .detail-panel, .saved-note-strip, a, textarea, input, button")) {
      startX = 0;
      return;
    }
    const delta = event.clientX - startX;
    startX = 0;
    if (Math.abs(delta) < 56) return;
    if (delta < 0) await handleReaderAction("next");
    else if (feed.history.length) await handleReaderAction("previous");
  });
};

updateReaderStageHeight = function updateReaderStageHeightUpdated() {
  const activePanel =
    state.screen === "collection"
      ? refs.collectionSection
      : state.screen === "subscriptions"
        ? refs.subscriptionSection
        : state.mode === "images"
          ? refs.imagePanel
          : refs.readerPanel;
  const availableHeight = Math.max(320, activePanel?.clientHeight || 320);
  const availableWidth = Math.max(
    320,
    activePanel?.clientWidth || 0,
    refs.homeSection?.clientWidth || 0,
    document.documentElement.clientWidth || 0,
  );
  const isPhone = availableWidth <= 480;
  const isCompact = availableWidth <= 720;
  let mediaRatio = 0.5;
  let mediaMax = 520;
  let titleFactor = 0.065;
  let titleMin = 30;
  let titleMax = 54;
  let headlineRatio = 0.26;
  let thumbHeight = 68;
  let footerRatio = 0.25;
  let footerMin = 148;
  let detailRatio = 0.28;

  if (isCompact) {
    mediaRatio = 0.3;
    mediaMax = 230;
    titleFactor = 0.05;
    titleMin = 22;
    titleMax = 34;
    headlineRatio = 0.3;
    thumbHeight = 54;
    footerRatio = 0.16;
    footerMin = 84;
    detailRatio = 0.22;
  }

  if (isPhone) {
    mediaRatio = 0.26;
    mediaMax = 200;
    titleFactor = 0.044;
    titleMin = 18;
    titleMax = 24;
    headlineRatio = 0.32;
    thumbHeight = 46;
    footerRatio = 0.14;
    footerMin = 72;
    detailRatio = 0.18;
  }

  const mediaHeight = Math.max(isPhone ? 148 : 176, Math.min(mediaMax, availableHeight * mediaRatio));
  const titleSize = Math.max(titleMin, Math.min(titleMax, availableHeight * titleFactor));
  const headlineMaxHeight = Math.max(isPhone ? 150 : 136, availableHeight * headlineRatio);
  const footerMaxHeight = Math.max(footerMin, availableHeight * footerRatio);
  const detailMaxHeight = Math.max(88, availableHeight * detailRatio);

  document.documentElement.style.setProperty("--reader-stage-height", `${availableHeight}px`);
  document.documentElement.style.setProperty("--reader-media-height", `${mediaHeight}px`);
  document.documentElement.style.setProperty("--reader-title-size", `${titleSize}px`);
  document.documentElement.style.setProperty("--reader-headline-max-height", `${headlineMaxHeight}px`);
  document.documentElement.style.setProperty("--reader-thumb-height", `${thumbHeight}px`);
  document.documentElement.style.setProperty("--reader-footer-max-height", `${footerMaxHeight}px`);
  document.documentElement.style.setProperty("--reader-detail-max-height", `${detailMaxHeight}px`);
};

attachGlobalEvents = function attachGlobalEventsUpdated() {
  refs.syncButtons.forEach((button) => {
    button.addEventListener("click", syncFeeds);
  });

  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", async () => {
      await switchMode(button.dataset.mode);
    });
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", async () => {
      state.screen = button.dataset.screen;
      document.querySelectorAll(".nav-item").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      refs.homeSection.classList.toggle("hidden", state.screen !== "home");
      refs.collectionSection.classList.toggle("hidden", state.screen !== "collection");
      refs.subscriptionSection.classList.toggle("hidden", state.screen !== "subscriptions");
      updateReaderStageHeight();
      if (state.screen !== "home") await renderMyPage();
    });
  });

  document.getElementById("subscriptionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("subscriptionName").value.trim();
    const url = document.getElementById("subscriptionUrl").value.trim();
    if (!name || !url) return;
    await api("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name, url }),
    });
    event.target.reset();
    await loadBootstrap();
    await switchMode(state.mode);
  });

  refs.paperSearch.addEventListener("input", () => {
    renderMyPage();
  });

  document.querySelectorAll("[data-collection-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.my.collectionTab = button.dataset.collectionTab;
      await renderMyPage();
    });
  });

  document.querySelectorAll("[data-manage-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.my.manageTab = button.dataset.manageTab;
      await renderMyPage();
    });
  });

  document.getElementById("closeModal").addEventListener("click", closeModal);
  refs.imageModal.addEventListener("click", (event) => {
    if (event.target.dataset.closeModal) {
      closeModal();
    }
  });
};

function attachGlobalEvents() {
  refs.syncButtons.forEach((button) => {
    button.addEventListener("click", syncFeeds);
  });

  document.querySelectorAll(".mode-tab").forEach((button) => {
    button.addEventListener("click", async () => {
      await switchMode(button.dataset.mode);
    });
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", async () => {
      state.screen = button.dataset.screen;
      document.querySelectorAll(".nav-item").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      refs.homeSection.classList.toggle("hidden", state.screen !== "home");
      refs.mySection.classList.toggle("hidden", state.screen !== "my");
      updateReaderStageHeight();
      if (state.screen === "my") await renderMyPage();
    });
  });

  document.getElementById("subscriptionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.getElementById("subscriptionName").value.trim();
    const url = document.getElementById("subscriptionUrl").value.trim();
    if (!url) return;
    await api("/api/subscriptions", {
      method: "POST",
      body: JSON.stringify({ name, url }),
    });
    document.getElementById("subscriptionName").value = "";
    document.getElementById("subscriptionUrl").value = "";
    await loadBootstrap();
    await switchMode(state.mode);
  });

  refs.paperSearch.addEventListener("input", () => {
    renderMyPage();
  });

  document.querySelectorAll("[data-collection-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.my.collectionTab = button.dataset.collectionTab;
      await renderMyPage();
    });
  });

  document.querySelectorAll("[data-manage-tab]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.my.manageTab = button.dataset.manageTab;
      await renderMyPage();
    });
  });

  document.getElementById("closeModal").addEventListener("click", closeModal);
  refs.imageModal.addEventListener("click", (event) => {
    if (event.target.dataset.closeModal) {
      closeModal();
    }
  });
}

async function init() {
  attachGlobalEvents();
  updateReaderStageHeight();
  await loadBootstrap();
  await switchMode("today");
}

window.addEventListener("resize", () => {
  updateReaderStageHeight();
  refreshVisibleView();
});

init();
