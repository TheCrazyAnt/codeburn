// Public leaderboard page served at GET /.
// Self-contained: inline CSS + JS, no external assets except GitHub avatar images.

export const LEADERBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>CodeBurn 排行榜</title>
<style>
  :root {
    --bg: #f7f7f8; --fg: #151517; --muted: #6b6b73; --card: #ffffff; --border: #e4e4e8;
    --row: #f1f1f4; --accent: #e8590c; --accent-fg: #ffffff; --gold: #d4a017; --silver: #8e9096; --bronze: #b0713b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0e0e10; --fg: #ececf0; --muted: #9a9aa6; --card: #17171b; --border: #2a2a31;
      --row: #1f1f25; --accent: #ff8a3d; --accent-fg: #14140f; --gold: #f2c14e; --silver: #c0c3cc; --bronze: #d08a55;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", "Noto Sans CJK SC", sans-serif; -webkit-font-smoothing: antialiased; }
  main { max-width: 780px; margin: 0 auto; padding: 28px 16px 48px; }
  header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  h1 { font-size: 26px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .sub { color: var(--muted); font-size: 14px; margin: 4px 0 18px; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .tabs { display: inline-flex; background: var(--row); border-radius: 10px; padding: 3px; }
  .tabs button { appearance: none; border: 0; background: transparent; color: var(--muted); font: inherit; font-weight: 600; padding: 6px 16px; border-radius: 8px; cursor: pointer; }
  .tabs button[aria-selected="true"] { background: var(--accent); color: var(--accent-fg); }
  .meta { color: var(--muted); font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { font-size: 12px; font-weight: 600; color: var(--muted); letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: var(--row); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.usd { font-weight: 600; }
  .rank { width: 56px; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 600; }
  .rank.r1 { color: var(--gold); } .rank.r2 { color: var(--silver); } .rank.r3 { color: var(--bronze); }
  .user { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .user img { width: 28px; height: 28px; border-radius: 50%; background: var(--row); flex: none; }
  .user a { color: inherit; text-decoration: none; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .user a:hover { text-decoration: underline; }
  .tag { display: inline-block; font-size: 11px; color: var(--muted); background: var(--row); padding: 1px 7px; border-radius: 999px; }
  .empty { padding: 40px 16px; text-align: center; color: var(--muted); }
  .error { color: #c0392b; }
  footer { margin-top: 22px; color: var(--muted); font-size: 13px; line-height: 1.7; }
  footer a { color: var(--accent); text-decoration: none; }
  footer a:hover { text-decoration: underline; }
  @media (max-width: 600px) {
    main { padding: 18px 10px 40px; }
    th, td { padding: 8px 8px; }
    .hide-sm { display: none; }
    h1 { font-size: 22px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1><span>CodeBurn</span> 排行榜</h1>
    <div class="sub" id="subtitle">AI 编程花费排行（自愿加入，仅汇总金额）</div>
  </header>
  <div class="toolbar">
    <div class="tabs" role="tablist" aria-label="榜单">
      <button role="tab" id="tab-week" aria-selected="false" data-board="week">本周</button>
      <button role="tab" id="tab-month" aria-selected="true" data-board="month">本月</button>
      <button role="tab" id="tab-lifetime" aria-selected="false" data-board="lifetime">累计</button>
    </div>
    <div class="meta" id="meta">加载中…</div>
  </div>
  <div class="toolbar">
    <div class="tabs" role="tablist" aria-label="排名依据">
      <button role="tab" id="metric-output" aria-selected="true" data-metric="output">产出</button>
      <button role="tab" id="metric-usd" aria-selected="false" data-metric="usd">花费</button>
      <button role="tab" id="metric-streak" aria-selected="false" data-metric="streak">活跃</button>
    </div>
    <div class="meta">排名依据：<span id="metric-name">产出 (tokens)</span></div>
  </div>
  <div class="card">
    <table aria-live="polite">
      <thead>
        <tr id="head"></tr>
      </thead>
      <tbody id="rows"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
    </table>
  </div>
  <footer>
    数据来自用户<strong>自愿开启</strong>的 <a href="https://github.com/TheCrazyAnt/codeburn" rel="noopener">CodeBurn</a> 客户端上报，仅包含汇总的花费金额、Token 数、调用次数与活跃天数，不含任何项目名称、会话内容或文件路径。金额以美元计，按各工具官方定价估算。每 60 秒自动刷新。
  </footer>
</main>
<script>
(function () {
  var board = "month";
  var metric = "output";
  var METRICS = {
    output: { label: "产出", head: "产出 (tokens)", format: function (v) { return compact.format(v || 0); } },
    usd: { label: "花费", head: "花费 (USD)", format: function (v) { return "$" + usdFmt.format(v || 0); } },
    streak: { label: "活跃", head: "连续活跃", format: function (v) { return intFmt.format(v || 0) + " 天"; } }
  };
  function metricValue(e, m) {
    if (m === "usd") return e.usd;
    if (m === "streak") return e.streakDays;
    return e.outputTokens;
  }
  var headEl = document.getElementById("head");
  var metricNameEl = document.getElementById("metric-name");
  var rowsEl = document.getElementById("rows");
  var metaEl = document.getElementById("meta");
  var subEl = document.getElementById("subtitle");
  var timer = null;

  var usdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
  var intFmt = new Intl.NumberFormat("en-US");

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function monthLabel(m) {
    if (!m) return "";
    var p = m.split("-");
    return p[0] + " 年 " + parseInt(p[1], 10) + " 月";
  }

  function weekLabel(w) {
    if (!w) return "";
    var p = w.split("-W");
    return p[0] + " 年第 " + parseInt(p[1], 10) + " 周";
  }

  function otherMetrics(m) {
    return ["output", "usd", "streak"].filter(function (k) { return k !== m; });
  }

  function renderHead(m) {
    headEl.textContent = "";
    var rank = el("th", "rank", "#"); headEl.appendChild(rank);
    headEl.appendChild(el("th", null, "用户"));
    headEl.appendChild(el("th", "num", METRICS[m].head));
    otherMetrics(m).forEach(function (k) { headEl.appendChild(el("th", "num hide-sm", METRICS[k].head)); });
    headEl.appendChild(el("th", "num hide-sm", "调用次数"));
    headEl.appendChild(el("th", "hide-sm", "主要工具"));
    metricNameEl.textContent = METRICS[m].head;
  }

  function render(data) {
    var m = data.metric || metric;
    renderHead(m);
    rowsEl.textContent = "";
    if (!data.entries || data.entries.length === 0) {
      var tr = el("tr");
      var td = el("td", "empty", "暂无数据 —— 成为第一个上榜的人吧。");
      td.colSpan = 7;
      tr.appendChild(td);
      rowsEl.appendChild(tr);
    } else {
      data.entries.forEach(function (e) {
        var tr = el("tr");
        var rank = el("td", "rank" + (e.rank <= 3 ? " r" + e.rank : ""), String(e.rank));
        tr.appendChild(rank);

        var userTd = el("td");
        var user = el("div", "user");
        var img = document.createElement("img");
        img.alt = "";
        img.loading = "lazy";
        img.width = 28; img.height = 28;
        img.referrerPolicy = "no-referrer";
        if (e.avatarUrl) img.src = e.avatarUrl;
        user.appendChild(img);
        var a = document.createElement("a");
        a.href = "https://github.com/" + encodeURIComponent(e.login);
        a.rel = "noopener";
        a.target = "_blank";
        a.textContent = e.login;
        user.appendChild(a);
        userTd.appendChild(user);
        tr.appendChild(userTd);

        var value = e.value !== undefined && e.value !== null ? e.value : metricValue(e, m);
        var valueTd = el("td", "num usd", METRICS[m].format(value));
        if (m === "output") valueTd.title = intFmt.format(value || 0) + " tokens";
        tr.appendChild(valueTd);
        otherMetrics(m).forEach(function (k) {
          var v = metricValue(e, k);
          var td = el("td", "num hide-sm", METRICS[k].format(v));
          if (k === "output") td.title = intFmt.format(v || 0) + " tokens";
          tr.appendChild(td);
        });
        tr.appendChild(el("td", "num hide-sm", intFmt.format(e.calls || 0)));
        var prov = el("td", "hide-sm");
        if (e.topProvider) prov.appendChild(el("span", "tag", e.topProvider));
        tr.appendChild(prov);
        rowsEl.appendChild(tr);
      });
    }
    var when = data.updatedAt ? new Date(data.updatedAt) : null;
    var whenText = when && !isNaN(when.getTime()) ? when.toLocaleString("zh-CN", { hour12: false }) : "—";
    metaEl.textContent = "共 " + intFmt.format(data.totalUsers || 0) + " 人 · 更新于 " + whenText;
    var scope = data.board === "week" ? weekLabel(data.week)
      : data.board === "month" ? monthLabel(data.month)
      : "累计";
    subEl.textContent = scope + " · AI 编程花费排行（自愿加入，仅汇总金额）";
  }

  function load() {
    fetch("/v1/leaderboard?board=" + board + "&metric=" + metric + "&limit=100", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (data) { if (data.board === board && (data.metric || metric) === metric) render(data); })
      .catch(function (err) {
        metaEl.textContent = "加载失败：" + err.message;
        metaEl.classList.add("error");
      });
  }

  function schedule() {
    if (timer) clearInterval(timer);
    timer = setInterval(load, 60000);
  }

  function wireTabs(attr, onSelect) {
    var buttons = document.querySelectorAll('.tabs button[' + attr + ']');
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", function () {
        onSelect(btn.getAttribute(attr));
        Array.prototype.forEach.call(buttons, function (b) {
          b.setAttribute("aria-selected", b === btn ? "true" : "false");
        });
        metaEl.classList.remove("error");
        metaEl.textContent = "加载中…";
        load();
        schedule();
      });
    });
  }
  wireTabs("data-board", function (v) { board = v; });
  wireTabs("data-metric", function (v) { metric = v; });
  renderHead(metric);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") load();
  });

  load();
  schedule();
})();
</script>
</body>
</html>
`;
