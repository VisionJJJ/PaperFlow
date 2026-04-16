const refs = {
  summary: document.getElementById("adminSummary"),
  metricGrid: document.getElementById("adminMetricGrid"),
  subscriptionStatus: document.getElementById("subscriptionStatus"),
  userStatus: document.getElementById("userStatus"),
  missingDetailList: document.getElementById("missingDetailList"),
  missingCountBadge: document.getElementById("missingCountBadge"),
  refreshButton: document.getElementById("refreshAdmin"),
  logoutButton: document.getElementById("logoutAdmin"),
};

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value) {
  if (!value) return "暂无";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

async function api(url) {
  const response = await fetch(url, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (response.status === 401) {
    window.location.href = "/admin/login";
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function post(url) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
  });
  if (response.status === 401) {
    window.location.href = "/admin/login";
    throw new Error("Unauthorized");
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

function renderMetrics(data) {
  const archive = data.archive || {};
  const users = data.users || {};
  const metrics = [
    ["归档论文数", archive.articleCount ?? 0, `最新序号 ${archive.latestArchiveSeq ?? 0}`],
    ["详情完备率", `${archive.detailProgress ?? 0}%`, `已完成 ${archive.detailReadyCount ?? 0}`],
    ["缺失详情数", archive.missingDetailCount ?? 0, "等待后台补抓"],
    ["图片总数", archive.figureCount ?? 0, "基于已缓存 figures"],
    ["最近同步时间", formatDateTime(archive.lastSyncedAt), "按订阅最大值统计"],
    ["用户数", users.count ?? 0, "按 users/*.json 统计"],
  ];

  refs.metricGrid.innerHTML = metrics
    .map(
      ([label, value, note]) => `
        <article class="admin-metric">
          <span class="admin-metric-label">${escapeHtml(label)}</span>
          <strong class="admin-metric-value">${escapeHtml(String(value))}</strong>
          <span class="admin-inline-note">${escapeHtml(note)}</span>
        </article>
      `,
    )
    .join("");
}

function renderSubscriptions(data) {
  const items = data.subscriptions || [];
  refs.subscriptionStatus.innerHTML = items.length
    ? items
        .map(
          (item) => `
            <article class="admin-item">
              <div class="admin-item-meta">优先级 ${escapeHtml(String(item.priority ?? ""))}</div>
              <h3>${escapeHtml(item.name || item.id || "未命名订阅")}</h3>
              <div class="admin-item-row">
                <span>最后同步</span>
                <strong>${escapeHtml(formatDateTime(item.last_synced_at))}</strong>
              </div>
              <div class="admin-item-row">
                <span>RSS</span>
                <a class="admin-item-link" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(item.url || "")}</a>
              </div>
            </article>
          `,
        )
        .join("")
    : '<div class="admin-empty">暂无订阅源。</div>';
}

function renderUsers(data) {
  const items = data.users?.items || [];
  refs.userStatus.innerHTML = items.length
    ? items
        .map(
          (item) => `
            <article class="admin-item">
              <div class="admin-item-meta">${escapeHtml(item.displayName || item.userId || "匿名用户")}</div>
              <h3>${escapeHtml(item.userId || "unknown")}</h3>
              <div class="admin-item-row">
                <span>最后访问</span>
                <strong>${escapeHtml(formatDateTime(item.lastSeenAt))}</strong>
                <span>创建于</span>
                <strong>${escapeHtml(formatDateTime(item.createdAt))}</strong>
              </div>
              <div class="admin-item-row">
                <span>浏览</span>
                <strong>${escapeHtml(String(item.viewedCount ?? 0))}</strong>
                <span>收藏论文</span>
                <strong>${escapeHtml(String(item.savedPaperCount ?? 0))}</strong>
                <span>收藏图片</span>
                <strong>${escapeHtml(String(item.savedImageCount ?? 0))}</strong>
              </div>
              <div class="admin-item-row">
                <span>今日断点</span>
                <strong>${escapeHtml(item.todayResume?.article_id || "无")}</strong>
                <span>待阅读断点</span>
                <strong>${escapeHtml(item.queueResume?.article_id || "无")}</strong>
              </div>
            </article>
          `,
        )
        .join("")
    : '<div class="admin-empty">暂无已落盘用户状态。</div>';
}

function renderMissingDetails(data) {
  const items = data.missingDetails || [];
  refs.missingCountBadge.textContent = String(items.length);
  refs.missingDetailList.innerHTML = items.length
    ? items
        .map(
          (item) => `
            <article class="admin-item">
              <div class="admin-item-meta">Archive #${escapeHtml(String(item.archiveSeq ?? ""))}</div>
              <h3>${escapeHtml(item.title || item.id || "未命名论文")}</h3>
              <div class="admin-item-row">
                <span>期刊</span>
                <strong>${escapeHtml(item.journalTitle || "未知")}</strong>
                <span>发布日期</span>
                <strong>${escapeHtml(item.publishedAt || "暂无")}</strong>
              </div>
              <a class="admin-item-link" href="${escapeHtml(item.articleUrl || "#")}" target="_blank" rel="noreferrer">打开原文</a>
            </article>
          `,
        )
        .join("")
    : '<div class="admin-empty">当前归档没有缺失详情的论文。</div>';
}

async function loadDashboard() {
  refs.summary.textContent = "正在刷新归档与用户索引状态...";
  const data = await api("/api/admin/archive-status");
  const archive = data.archive || {};
  refs.summary.textContent = `当前共归档 ${archive.articleCount ?? 0} 篇论文，详情完备率 ${archive.detailProgress ?? 0}%，最近同步 ${formatDateTime(archive.lastSyncedAt)}。`;
  renderMetrics(data);
  renderSubscriptions(data);
  renderUsers(data);
  renderMissingDetails(data);
}

refs.refreshButton.addEventListener("click", async () => {
  refs.refreshButton.disabled = true;
  try {
    await loadDashboard();
  } finally {
    refs.refreshButton.disabled = false;
  }
});

refs.logoutButton?.addEventListener("click", async () => {
  refs.logoutButton.disabled = true;
  try {
    await post("/api/admin/logout");
  } finally {
    window.location.href = "/admin/login";
  }
});

loadDashboard().catch((error) => {
  refs.summary.textContent = `加载失败：${error.message}`;
  refs.metricGrid.innerHTML = '<div class="admin-empty">后台状态加载失败，请稍后重试。</div>';
});
