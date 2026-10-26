/* Virtual Food Expo front end: plain JavaScript, no build step. */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = {
  lang: localStorage.getItem("lang") || "en",
  session: localStorage.getItem("session") || ("s" + Math.random().toString(36).slice(2, 10)),
  buyerName: localStorage.getItem("buyerName") || "",
  languages: [], T: {}, vendors: [], matches: null, category: "All", shown: new Set(), timer: null, vendorTimer: null,
};
localStorage.setItem("session", state.session);
state.token = localStorage.getItem("token") || "";
state.account = JSON.parse(localStorage.getItem("account") || "null");
state.adminKey = sessionStorage.getItem("adminKey") || "";
const CATEGORIES = ["Oils & Vinegars", "Sauces", "Snacks", "Rice & Grains", "Tea & Coffee"];

/* Every call to /api gets the login token. A rejected token logs the user out. */
const _fetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  if (typeof url === "string" && url.startsWith("/api/") && state.token && !url.startsWith("/api/admin"))
    opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: "Bearer " + state.token } };
  const res = await _fetch(url, opts);
  if (res.status === 401 && state.token && typeof url === "string" && !url.startsWith("/api/admin")) logOut();
  return res;
};
function logOut() {
  ["token", "account", "buyerName"].forEach(k => localStorage.removeItem(k));
  state.token = ""; state.account = null; state.buyerName = ""; state.vendors = []; state.matches = null; state.vendorLangSet = null;
  stopTimers(); closeModal(); location.hash = "#/"; render();
}

function t(key, vars = {}) {
  let s = state.T[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll("{" + k + "}", v);
  return s;
}
const langName = code => (state.languages.find(l => l.code === code) || {}).name || code;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let msg = t("error");
    try { msg = (await res.json()).detail || msg; } catch (e) { /* keep default */ }
    toast(typeof msg === "string" ? msg : t("error"));
    throw new Error(msg);
  }
  return res.json();
}

function toast(msg) {
  const el = $("#toast"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 5000);
}
let modalOpen = false;
function showModal(html) { $("#modal").innerHTML = html; $("#overlay").classList.add("show"); modalOpen = true; const f = $("#modal input, #modal .btn"); if (f) f.focus(); }
function closeModal() { $("#overlay").classList.remove("show"); modalOpen = false; }

async function updateTokens() {
  try {
    const u = await fetch("/api/usage?session=" + state.session).then(r => r.json());
    const tot = u.total.prompt + u.total.completion;
    $("#tokenCount").textContent = tot.toLocaleString();
  } catch (e) { /* ignore */ }
}

async function showUsage() {
  const [u, ev] = await Promise.all([
    fetch("/api/usage?session=" + state.session).then(r => r.json()),
    fetch("/api/safety-events").then(r => r.json()),
  ]);
  const rows = u.by_agent.map(r => `<tr><td>${esc(r.agent)}</td><td>${r.calls}</td><td>${r.prompt}</td><td>${r.cached}</td><td>${r.completion}</td><td>$${r.cost_usd.toFixed(4)}</td></tr>`).join("");
  const evs = ev.map(e => `<tr><td>${esc(e.kind)}</td><td>${esc(e.detail)}</td></tr>`).join("") || "<tr><td colspan=2>-</td></tr>";
  showModal(`<h3>${esc(t("tokens_used"))}</h3>
    <table><tr><th>Agent</th><th>Calls</th><th>In</th><th>Cached</th><th>Out</th><th>Cost</th></tr>${rows}
    <tr><th>Total</th><th>${u.total.calls}</th><th>${u.total.prompt}</th><th>${u.total.cached}</th><th>${u.total.completion}</th><th>$${u.total.cost_usd.toFixed(4)}</th></tr></table>
    <p style="font-size:15px">Model: ${esc(u.model)}. Session cap: ${u.session_cap.toLocaleString()} tokens. Prices are assumptions per 1M tokens (in $${u.assumed_prices_per_m.input}, cached $${u.assumed_prices_per_m.cached}, out $${u.assumed_prices_per_m.output}).</p>
    <h3>${esc(t("safety_log"))}</h3><table>${evs}</table>
    <div class="actions"><button class="btn" onclick="closeModal()">${esc(t("close"))}</button></div>`);
}

/* ---------- language ---------- */
async function loadUi() {
  state.T = await api("/api/ui?lang=" + state.lang + "&session=" + state.session);
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
  $("#brand").textContent = "🌿 " + t("brand");
  $("#usageBtn").title = t("usage");
}
async function setLang(code) {
  state.lang = code; localStorage.setItem("lang", code);
  $("#langSel").disabled = true;
  try { await loadUi(); } finally { $("#langSel").disabled = false; }
  render(); updateTokens();
}

/* ---------- routing ---------- */
function stopTimers() { clearInterval(state.timer); clearInterval(state.vendorTimer); state.timer = state.vendorTimer = null; }
function render() {
  stopTimers();
  const [, page, id, sub] = location.hash.split("/");
  const view = $("#view");
  $("#logoutBtn").style.display = state.token ? "" : "none";
  $("#logoutBtn").textContent = t("log_out");
  if (page === "admin") return renderAdmin(view);
  if (page === "reset" && id) return renderReset(view, id);
  if (!state.token) return renderLogin(view);
  state.buyerName = state.account.company;
  const home = state.account.role === "vendor" ? "#/vendor/" + state.account.vendor_id : "#/buyer";
  if (state.account.role === "vendor") {
    if (page !== "vendor" || id !== state.account.vendor_id) { location.hash = home; return; }
    return renderVendorDash(view, id);
  }
  if (page === "buyer" && id === "booth") return renderBooth(view, sub);
  if (page === "buyer" && id === "browse") return renderBuyer(view);
  if (page !== "buyer") { location.hash = home; return; }
  renderDashboard(view);
}

/* ---------- buyer home: dashboard of outreach, pending items and meetings ---------- */
const buyerNav = active => `<div class="tabs"><button class="btn ${active === "home" ? "" : "alt"}" onclick="location.hash='#/buyer'">🏠 ${esc(t("nav_home"))}</button>
  <button class="btn ${active === "browse" ? "" : "alt"}" onclick="location.hash='#/buyer/browse'">🔎 ${esc(t("nav_browse"))}</button></div>`;

async function renderDashboard(view) {
  const paint = async () => {
    const items = await fetch(`/api/buyer/dashboard?lang=${state.lang}&session=${state.session}`).then(r => r.json());
    if (!$("#dash")) return;
    const now = Date.now(), todo = [], waiting = [], upcoming = [];
    for (const c of items) {
      const go = `onclick="state.shown.clear();location.hash='#/buyer/booth/${c.vendor_id}'"`;
      for (const m of c.meetings) {
        const what = m.app ? m.app + " " + t("call_word") : t("meeting_word"), time = fmtLocal(new Date(m.start_utc));
        if (m.status === "pending" && m.proposed_by === "vendor") todo.push({ c, go, icon: "📅", text: t("todo_meeting_request", { vendor: c.vendor_name, what, time }) });
        if (m.status === "pending" && m.proposed_by === "buyer") waiting.push({ c, go, icon: "⏳", text: t("wait_meeting", { vendor: c.vendor_name, what, time }) });
        if (m.status === "accepted" && new Date(m.start_utc).getTime() > now - 30 * 60000) upcoming.push({ c, m, what, go });
      }
      for (const s of c.samples) {
        if (s.status === "confirmed") todo.push({ c, go, icon: "📦", text: t("todo_address", { vendor: c.vendor_name }) });
        if (s.status === "pending") waiting.push({ c, go, icon: "⏳", text: t("wait_sample", { vendor: c.vendor_name }) });
      }
    }
    upcoming.sort((a, b) => new Date(a.m.start_utc) - new Date(b.m.start_utc));
    const stat = (n, label, hot) => `<div class="stat ${hot ? "hot" : ""}"><b>${n}</b><span>${esc(label)}</span></div>`;
    const todoRow = x => `<div class="lead" tabindex="0" ${x.go}><div>${x.icon} ${esc(x.text)}</div><button class="btn">${esc(t("open_chat"))}</button></div>`;
    const meetRow = x => `<div class="lead" tabindex="0" ${x.go}><div><b>${esc(fmtLocal(new Date(x.m.start_utc)))}</b> · ${esc(x.what)}<br>${esc(x.c.emoji)} ${esc(x.c.vendor_name)}${x.m.link ? `<br><a href="${esc(x.m.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(x.m.link)}</a>` : ""}</div></div>`;
    const outRow = c => {
      const tags = [];
      if (c.meetings.some(m => m.status === "accepted")) tags.push(t("status_meeting_set"));
      if (c.samples.some(s => s.status === "shipped")) tags.push(t("status_sample_sent"));
      return `<div class="lead" tabindex="0" onclick="state.shown.clear();location.hash='#/buyer/booth/${c.vendor_id}'"><div><b>${esc(c.emoji)} ${esc(c.vendor_name)}</b> ${c.verified ? `<span class="tag" style="background:var(--green);color:#fff">✔ ${esc(t("verified"))}</span>` : ""}
        ${tags.map(x => `<span class="tag">${esc(x)}</span>`).join("")}<br><span class="sub" style="margin:0">${esc(c.last_text)}</span></div><span class="sub" style="margin:0;white-space:nowrap">${esc(fmtLocal(new Date(c.last_time.replace(" ", "T") + "Z")))}</span></div>`;
    };
    $("#dash").innerHTML = `<div class="stats">${stat(items.length, t("stat_outreach"))}${stat(todo.length, t("stat_pending"), todo.length)}${stat(waiting.length, t("stat_waiting"))}${stat(upcoming.length, t("stat_meetings"))}</div>
      <h2>${esc(t("pending_for_you"))}</h2>${todo.length ? todo.map(todoRow).join("") : `<p class="sub">${esc(t("nothing_pending"))}</p>`}
      ${waiting.length ? waiting.map(todoRow).join("") : ""}
      <h2 style="margin-top:26px">${esc(t("upcoming_meetings"))}</h2>${upcoming.length ? upcoming.map(meetRow).join("") : `<p class="sub">${esc(t("no_meetings"))}</p>`}
      <h2 style="margin-top:26px">${esc(t("my_outreach"))}</h2>${items.length ? items.map(outRow).join("") : `<p class="sub">${esc(t("no_outreach"))}</p>`}`;
  };
  view.innerHTML = `<h1>${esc(t("dash_title", { company: state.account.company }))}</h1>${buyerNav("home")}<div id="dash"></div>`;
  await paint();
  state.timer = setInterval(paint, 5000);
}
window.addEventListener("hashchange", render);

/* ---------- login ---------- */
function renderLogin(view, mode = "login") {
  const signup = mode === "signup";
  view.innerHTML = `<h1>${esc(t("brand"))}</h1><p class="sub">${esc(t("tagline"))}</p>
    <div class="tabs"><button class="btn ${signup ? "alt" : ""}" id="tLogin">${esc(t("log_in"))}</button>
      <button class="btn ${signup ? "" : "alt"}" id="tSignup">${esc(t("create_account"))}</button></div>
    <div class="panel form" style="max-width:560px"><p class="sub" style="margin:0">${esc(t(signup ? "signup_hint" : "login_hint"))}</p>
      <label for="em">${esc(t("email"))}</label><input id="em" type="email" autocomplete="email">
      <label for="pw">${esc(t("password"))}</label><input id="pw" type="password" autocomplete="${signup ? "new-password" : "current-password"}">
      <label style="font-weight:400"><input type="checkbox" id="showpw" style="width:auto"> ${esc(t("show_password"))}</label>
      ${signup ? `<p class="sub" style="font-size:16px;margin:0">${esc(t("password_hint"))}</p>` : ""}
      ${signup ? `<label for="co">${esc(t("company"))}</label><input id="co" autocomplete="organization">
      <label>${esc(t("i_am"))}</label>
      <label style="font-weight:400"><input type="radio" name="role" value="buyer" checked style="width:auto"> ${esc(t("role_buyer"))}</label>
      <label style="font-weight:400"><input type="radio" name="role" value="vendor" style="width:auto"> ${esc(t("role_vendor"))}</label>
      <label for="lic">${esc(t("license_label"))}</label><input id="lic" type="file" accept="application/pdf,.pdf">
      <p class="sub" style="font-size:16px;margin:4px 0 0">${esc(t("license_hint"))}</p>` : ""}
      <div id="loginErr" class="error" role="alert" style="display:none"></div>
      <div class="actions" style="margin-top:18px"><button class="btn" id="signin">${esc(signup ? t("create_account") : t("log_in"))}</button>
        ${signup ? "" : `<button class="btn alt" id="forgot">${esc(t("forgot_password"))}</button>`}</div></div>`;
  $("#tLogin").onclick = () => renderLogin(view, "login");
  $("#tSignup").onclick = () => renderLogin(view, "signup");
  $("#showpw").onchange = e => { $("#pw").type = e.target.checked ? "text" : "password"; };
  $("#pw").onkeydown = e => { if (e.key === "Enter" && !signup) $("#signin").click(); };
  const showErr = (msg, field) => {  // inline styles, so it is red even if the browser kept an old stylesheet
    const e = $("#loginErr");
    e.textContent = msg; e.style.cssText = "display:block;background:#fdecea;color:#8a1c13;border:2px solid #c0392b;border-radius:12px;padding:12px 16px;margin-top:14px;font-weight:700";
    document.querySelectorAll("#em,#pw,#co").forEach(i => { i.style.borderColor = ""; });
    if (field) { field.style.borderColor = "#c0392b"; field.focus(); }
  };
  $("#signin").onclick = async () => {
    const email = $("#em").value.trim();
    if (!email) return showErr(t("err_email"), $("#em"));
    if (!$("#pw").value) return showErr(t("err_password"), $("#pw"));
    if (signup && $("#pw").value.length < 8) return showErr(t("err_password_short"), $("#pw"));
    if (signup && !$("#co").value.trim()) return showErr(t("err_company"), $("#co"));
    const body = { mode, email, password: $("#pw").value };
    if (signup) { body.company = $("#co").value.trim(); body.role = document.querySelector('input[name=role]:checked').value; }
    const f = signup ? $("#lic").files[0] : null;
    if (f) {
      if (f.size > 5 * 1024 * 1024) return toast("5 MB maximum");
      body.license_name = f.name;
      body.license_b64 = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result.split(",")[1]); r.readAsDataURL(f); });
    }
    $("#signin").disabled = true; $("#loginErr").style.display = "none";
    try {
      const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {  // shown on the form itself, in red, until the next try
        showErr(res.status === 401 ? t("login_failed") : (data.detail || t("error")), res.status === 401 ? $("#pw") : null);
        return;
      }
      state.token = data.token; state.account = data.account;
      localStorage.setItem("token", data.token); localStorage.setItem("account", JSON.stringify(data.account));
      location.hash = "#/"; render();
    } finally { $("#signin").disabled = false; }
  };
  $("#forgot") && ($("#forgot").onclick = () => renderForgot(view));
}

/* ---------- forgot password: ask for a link, then choose a new password ---------- */
function renderForgot(view) {
  view.innerHTML = `<h1>${esc(t("forgot_title"))}</h1>
    <div class="panel form" style="max-width:560px"><p class="sub" style="margin:0">${esc(t("forgot_hint"))}</p>
      <label for="em">${esc(t("email"))}</label><input id="em" type="email" autocomplete="email">
      <div id="fmsg" class="notice" style="display:none"></div>
      <div class="actions" style="margin-top:18px"><button class="btn" id="send">${esc(t("send_reset"))}</button>
        <button class="btn alt" id="back">${esc(t("back_to_login"))}</button></div></div>`;
  $("#back").onclick = () => renderLogin(view, "login");
  const go = async () => {
    const email = $("#em").value.trim(); if (!email) return;
    $("#send").disabled = true;
    try {
      await fetch("/api/forgot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
      $("#fmsg").textContent = t("reset_sent"); $("#fmsg").style.display = "block";  // same message for every address
    } finally { $("#send").disabled = false; }
  };
  $("#send").onclick = go; $("#em").onkeydown = e => { if (e.key === "Enter") go(); };
}

function renderReset(view, token) {
  view.innerHTML = `<h1>${esc(t("reset_title"))}</h1>
    <div class="panel form" style="max-width:560px">
      <label for="pw">${esc(t("new_password"))}</label><input id="pw" type="password" autocomplete="new-password">
      <label style="font-weight:400"><input type="checkbox" id="showpw" style="width:auto"> ${esc(t("show_password"))}</label>
      <p class="sub" style="font-size:16px;margin:0">${esc(t("password_hint"))}</p>
      <div id="rerr" class="error" style="display:none"></div>
      <div class="actions" style="margin-top:18px"><button class="btn" id="save">${esc(t("set_password"))}</button></div></div>`;
  $("#showpw").onchange = e => { $("#pw").type = e.target.checked ? "text" : "password"; };
  const go = async () => {
    const password = $("#pw").value; if (!password) return;
    $("#save").disabled = true;
    try {
      const res = await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { $("#rerr").textContent = data.detail || t("error"); $("#rerr").style.display = "block"; return; }
      logOut(); toast(t("reset_done"));  // clears any old session and shows the log in screen
    } finally { $("#save").disabled = false; }
  };
  $("#save").onclick = go; $("#pw").onkeydown = e => { if (e.key === "Enter") go(); };
}

/* ---------- admin: review company licenses ---------- */
async function renderAdmin(view) {
  const load = async () => {
    const res = await fetch("/api/admin/accounts", { headers: { "X-Admin-Key": state.adminKey } });
    if (!res.ok) return null;
    return res.json();
  };
  let rows = state.adminKey ? await load() : null;
  if (!rows) {
    view.innerHTML = `<h1>Admin</h1><div class="panel form" style="max-width:480px"><label for="ak">Admin password</label><input id="ak" type="password">
      <div class="actions" style="margin-top:14px"><button class="btn" id="akgo">${esc(t("continue"))}</button></div></div>`;
    $("#akgo").onclick = () => { state.adminKey = $("#ak").value; sessionStorage.setItem("adminKey", state.adminKey); renderAdmin(view); };
    return;
  }
  view.innerHTML = `<h1>Admin: accounts and licenses</h1>` + (rows.map(a => `<div class="lead" style="cursor:default"><div><b>${esc(a.company)}</b> · ${esc(a.role)}<br>
    <span class="sub" style="margin:0">${esc(a.email)} · status: <b>${esc(a.status)}</b></span></div><div style="display:flex;gap:8px;flex-wrap:wrap">
    ${a.license_name ? `<a class="btn alt" style="text-decoration:none" target="_blank" href="/api/admin/license/${a.id}?key=${encodeURIComponent(state.adminKey)}">View PDF</a>` : ""}
    <button class="btn" data-a="${a.id}" data-v="1">Approve</button><button class="btn alt" data-a="${a.id}" data-v="0">Reject</button></div></div>`).join("") || "<p>No accounts yet.</p>");
  view.querySelectorAll("[data-a]").forEach(b => b.onclick = async () => {
    await api(`/api/admin/accounts/${b.dataset.a}/review`, { method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": state.adminKey }, body: { approve: b.dataset.v === "1" } });
    renderAdmin(view);
  });
}

/* ---------- buyer: store-style browsing ---------- */
function cheapest(v) {
  let best = null;
  for (const p of v.products) { const pr = p.tiers[0].price; if (!best || pr < best.price) best = { price: pr, unit: p.unit, min: p.min_order }; }
  return best;
}
const verifiedTag = v => v.verified ? `<span class="tag" style="background:var(--green);color:#fff">✔ ${esc(t("verified"))}</span>` : "";
function vendorCard(v, extra = "") {
  const c = cheapest(v);
  const tags = verifiedTag(v) + v.certifications.map(x => `<span class="tag">${esc(state.T["cert_" + x] || x)}</span>`).join("");
  const priceLines = c ? `<div>${esc(t("from_price", { price: c.price.toFixed(2), unit: c.unit }))}</div><div>${esc(t("min_order", { n: c.min.toLocaleString() }))}</div>` : `<div>${esc(t("no_products"))}</div>`;
  return `<div class="vcard" tabindex="0" onclick="location.hash='#/buyer/booth/${v.id}'" onkeydown="if(event.key==='Enter')this.click()">
    <div class="photo">${v.emoji}</div>
    <div class="body"><h3>${esc(v.name)}</h3>${esc([v.city, v.country].filter(Boolean).join(", "))}${v.rating ? " · ★ " + v.rating : ""}<br>${extra}${tags}
      ${priceLines}</div>
    <button class="btn go">${esc(t("visit_booth"))}</button></div>`;
}
function row(title, cards, id) {
  return `<section class="row"><div class="row-head"><h2>${esc(title)}</h2>
    <div class="arrows"><button aria-label="left" onclick="scrollRow('${id}',-1)">‹</button><button aria-label="right" onclick="scrollRow('${id}',1)">›</button></div></div>
    <div class="scroller" id="${id}">${cards}</div></section>`;
}
window.scrollRow = (id, dir) => { const el = document.getElementById(id); el.scrollBy({ left: dir * 580 }); };

async function renderBuyer(view) {
  if (!state.vendors.length) state.vendors = await api("/api/vendors");
  const chips = ["All", ...CATEGORIES].map(c => `<button class="chip ${state.category === c ? "on" : ""}" data-cat="${esc(c)}">${esc(c === "All" ? t("all") : t("cat_" + c))}</button>`).join("");
  let html = `${buyerNav("browse")}<div class="search"><input id="q" placeholder="${esc(t("search_placeholder"))}" value="${esc(state.query || "")}"><button class="btn" id="go">${esc(t("search"))}</button></div>
    <div class="chips">${chips}</div><div id="results"></div>`;
  const cats = state.category === "All" ? [...CATEGORIES, "New vendors"] : [state.category];
  html += cats.map((c, i) => {
    const vs = state.vendors.filter(v => c === "New vendors" ? !CATEGORIES.includes(v.category) : v.category === c);
    return vs.length ? row(t("cat_" + c), vs.map(v => vendorCard(v)).join(""), "row" + i) : "";
  }).join("");
  view.innerHTML = html;
  view.querySelectorAll(".chip").forEach(b => b.onclick = () => { state.category = b.dataset.cat; renderBuyer(view); });
  $("#go").onclick = runSearch; $("#q").onkeydown = e => { if (e.key === "Enter") runSearch(); };
  if (state.matches) paintMatches();
}
function paintMatches() {
  const m = state.matches;
  const box = $("#results"); if (!box) return;
  if (!m.results.length) { box.innerHTML = `<p class="sub">${esc(m.summary || t("no_results"))}</p>`; return; }
  const cards = m.results.map(r => vendorCard(r.vendor, `<span class="match">${esc(t("match", { n: r.match_pct }))}</span><div class="reason">${esc(r.reason)}</div>`)).join("");
  box.innerHTML = `<p class="sub">${esc(m.summary)}</p>` + row(t("best_matches"), cards, "rowm");
}
async function runSearch() {
  const text = $("#q").value.trim(); if (!text) return;
  state.query = text;
  $("#results").innerHTML = `<p class="sub">${esc(t("searching"))}</p>`; $("#go").disabled = true;
  try { state.matches = await api("/api/match", { method: "POST", body: { text, lang: state.lang, session: state.session } }); paintMatches(); }
  catch (e) { $("#results").innerHTML = ""; }
  finally { $("#go").disabled = false; updateTokens(); }
}

/* ---------- booth page + chat ---------- */
async function renderBooth(view, vendorId) {
  state.shown.clear();  // so open requests pop up again when you come back to a booth
  const v = await api(`/api/vendors/${vendorId}?lang=${state.lang}&session=${state.session}`);
  const conv = await api("/api/conversations", { method: "POST", body: { vendor_id: vendorId, buyer_name: state.buyerName, lang: state.lang } });
  const prices = v.products.map(p => `<tr><td><b>${esc(p.name)}</b><br>${p.tiers.map(x => esc(t("unit_price", { unit: p.unit, price: x.price.toFixed(2), qty: x.min_qty.toLocaleString() }))).join("<br>")}</td></tr>`).join("");
  const tags = verifiedTag(v) + v.certifications.map(x => `<span class="tag">${esc(state.T["cert_" + x] || x)}</span>`).join("");
  view.innerHTML = `<button class="btn alt" onclick="history.back()">← ${esc(t("back"))}</button>
    <div class="booth"><div class="panel"><div class="booth-photo">${v.emoji}</div><h2>${esc(v.name)}</h2>
      <div>${esc(v.city)}, ${esc(v.country)} · ★ ${v.rating}</div>${tags}<p>${esc(v.description)}</p>
      <h2 style="font-size:20px">${esc(t("products"))}</h2><table class="prices">${prices}</table>
      <p><b>${esc(t("shipping"))}:</b><br>${Object.entries(v.shipping_weeks).map(([r, w]) => esc(r + ": " + t("weeks", { n: w }))).join("<br>")}</p>
      <p><b>${esc(t("sample_info"))}:</b> ${esc(v.sample_policy)}</p></div>
      <div id="chatbox"></div></div>`;
  mountChat($("#chatbox"), conv.id, "buyer", v);
}

function mountChat(box, convId, side, vendor) {
  box.innerHTML = `<div class="panel chat"><div class="chat-head"><span>${esc(t("chat_title"))}: ${esc(vendor.name)}</span>
      <button class="btn alt" id="brief" style="min-height:40px;padding:4px 14px;font-size:16px">${esc(t("summary"))}</button></div>
    <div class="msgs" id="msgs"></div>
    <div class="quick">
      <button class="btn" id="qMeet">📅 ${esc(t("meeting"))}</button>
      <button class="btn" id="qVideo">🎥 ${esc(t("video_call"))}</button>
      ${side === "buyer" ? `<button class="btn" id="qSample">📦 ${esc(t("sample"))}</button>` : ""}
    </div>
    <div class="composer"><textarea id="msgIn" placeholder="${esc(t("type_message"))}" maxlength="1000"></textarea>
      <button class="btn" id="send">${esc(t("send"))}</button></div></div>`;
  const ctx = { convId, side, vendor, original: new Set(), lastKey: "", busy: false };

  const send = async () => {
    const ta = $("#msgIn"); const text = ta.value.trim(); if (!text || ctx.busy) return;
    ctx.busy = true; ta.value = ""; $("#send").disabled = true; addTyping();
    try { await api(`/api/conversations/${convId}/messages`, { method: "POST", body: { text, lang: state.lang, side, session: state.session } }); }
    catch (e) { ta.value = text; }
    ctx.busy = false; $("#send").disabled = false; await refresh(); updateTokens();
  };
  const addTyping = () => { const m = $("#msgs"); if (m) { m.insertAdjacentHTML("beforeend", `<div class="typing">${esc(t("thinking"))}</div>`); m.scrollTop = m.scrollHeight; } };
  $("#send").onclick = send;
  $("#msgIn").onkeydown = e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };
  $("#qMeet").onclick = () => startMeeting(ctx, "meeting", "");
  $("#qVideo").onclick = () => chooseVideoApp(ctx);
  if (side === "buyer") $("#qSample").onclick = () => confirmSample(ctx);
  $("#brief").onclick = async () => {
    $("#brief").disabled = true;
    try { const r = await api(`/api/conversations/${convId}/brief?lang=${state.lang}&session=${state.session}`, { method: "POST" });
      showModal(`<h3>${esc(t("summary_title"))}</h3><pre>${esc(r.brief)}</pre><div class="actions"><button class="btn" onclick="closeModal()">${esc(t("close"))}</button></div>`); }
    finally { $("#brief").disabled = false; updateTokens(); }
  };

  async function refresh() {
    const data = await fetch(`/api/conversations/${convId}?lang=${state.lang}&session=${state.session}`).then(r => r.json());
    paintChat(ctx, data); handleRequests(data, side, ctx);
  }
  ctx.refresh = refresh;
  refresh();
  state.timer = setInterval(() => { if (!ctx.busy && !modalOpen) refresh(); }, 3000);
}

function paintChat(ctx, data) {
  const box = $("#msgs"); if (!box) return;
  const key = JSON.stringify([data.messages.map(m => m.id + m.text), data.meetings.map(m => m.id + m.status), data.samples.map(s => s.id + s.status), [...ctx.original]]);
  if (key === ctx.lastKey) return; ctx.lastKey = key;
  const mine = m => m.sender === ctx.side || (ctx.side === "vendor" && m.sender === "vendor_auto");
  const label = m => ({ buyer: t("buyer_label"), vendor: t("vendor_label"), agent: t("assistant_label"), vendor_auto: t("auto_label") }[m.sender]);
  let html = data.messages.map(m => `<div class="bubble ${mine(m) ? "me" : ""} ${m.sender === "vendor_auto" ? "auto" : ""}">
      <div class="who">${esc(label(m))}</div>${esc(m.text)}
      ${m.number_check !== "ok" ? `<div class="warn">⚠ ${esc(t("number_warn"))}</div>` : ""}
      ${m.translated ? `<small>${esc(t("translated_from", { lang: langName(m.orig_lang) }))} · <button class="link" data-orig="${m.id}">${esc(ctx.original.has(m.id) ? t("hide_original") : t("show_original"))}</button></small>
        ${ctx.original.has(m.id) ? `<div class="orig">${esc(m.original)}</div>` : ""}` : ""}</div>`).join("");
  const fmt = iso => new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  for (const m of data.meetings) {
    const what = m.app ? m.app + " " + t("call_word") : t("meeting_word");
    if (m.status === "pending") html += `<div class="status">⏳ ${esc(t("waiting_approval", { what, time: fmt(m.start_utc) }))}</div>`;
    if (m.status === "declined") html += `<div class="status">✖ ${esc(t("declined_note", { time: fmt(m.start_utc) }))}</div>`;
    if (m.status === "accepted") html += `<div class="status">✔ ${esc(what)} · ${esc(fmt(m.start_utc))}${m.link ? `<br><a href="${esc(m.link)}" target="_blank" rel="noopener">${esc(m.link)}</a>` : ""}</div>`;
  }
  for (const s of data.samples) {
    if (s.status === "pending") html += `<div class="status">⏳ ${esc(t("sample_waiting"))}</div>`;
    if (s.status === "declined") html += `<div class="status">✖ ${esc(t("sample_declined"))}</div>`;
    if (s.status === "shipped") html += `<div class="status">📦 ${esc(t("sample_sent"))}</div>`;
  }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = html;
  box.querySelectorAll("[data-orig]").forEach(b => b.onclick = () => {
    const id = +b.dataset.orig; ctx.original.has(id) ? ctx.original.delete(id) : ctx.original.add(id); ctx.lastKey = ""; paintChat(ctx, data);
  });
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/* ---------- quick actions ---------- */
function slotChoices() {
  const out = []; const d = new Date(); const times = [[9, 0], [14, 0], [10, 30]];
  let i = 0;
  while (out.length < 3) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const s = new Date(d); s.setHours(times[i][0], times[i][1], 0, 0); out.push(s); i++;
  }
  return out;
}
const fmtLocal = d => d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function chooseVideoApp(ctx) {
  showModal(`<h3>${esc(t("which_prefer"))}</h3><div class="opts">
    <button class="btn" data-app="Zoom">Zoom</button><button class="btn" data-app="Google Meet">Google Meet</button></div>
    <div class="actions"><button class="btn alt" onclick="closeModal()">${esc(t("cancel"))}</button></div>`);
  document.querySelectorAll("#modal [data-app]").forEach(b => b.onclick = () => startMeeting(ctx, "video", b.dataset.app));
}
function startMeeting(ctx, kind, appName) {
  const opts = slotChoices().map((d, i) => `<button class="btn" data-i="${i}">${esc(fmtLocal(d))}</button>`).join("");
  showModal(`<h3>${esc(t("pick_time"))}</h3><div class="opts">${opts}</div>
    <label>${esc(t("custom_time"))}</label><input type="datetime-local" id="custom">
    <p style="font-size:16px">${esc(t("your_time_zone"))}</p>
    <div class="actions"><button class="btn" id="useCustom">${esc(t("confirm"))}</button><button class="btn alt" onclick="closeModal()">${esc(t("cancel"))}</button></div>`);
  const slots = slotChoices();
  const submit = async d => {
    closeModal();
    await api(`/api/conversations/${ctx.convId}/meetings`, { method: "POST", body: { kind, app: appName, start_utc: d.toISOString(), proposed_by: ctx.side } });
    ctx.refresh();
  };
  document.querySelectorAll("#modal [data-i]").forEach(b => b.onclick = () => submit(slots[+b.dataset.i]));
  $("#useCustom").onclick = () => { const v = $("#custom").value; if (v) submit(new Date(v)); };
}
function confirmSample(ctx) {
  showModal(`<h3>${esc(t("sample_confirm_title"))}</h3><p>${esc(t("sample_confirm_body"))}</p>
    <div class="actions"><button class="btn" id="yes">${esc(t("send_request"))}</button><button class="btn alt" onclick="closeModal()">${esc(t("cancel"))}</button></div>`);
  $("#yes").onclick = async () => { closeModal(); await api(`/api/conversations/${ctx.convId}/samples`, { method: "POST" }); ctx.refresh(); };
}

/* Pop-ups that depend on what the other person did. Each fires once per item. */
function handleRequests(data, side, ctx) {
  if (modalOpen) return;
  const other = side === "buyer" ? "vendor" : "buyer";
  const who = side === "buyer" ? data.vendor.name : data.conversation.buyer_name;
  const fmt = iso => fmtLocal(new Date(iso));
  for (const m of data.meetings) {
    const what = m.app ? m.app + " " + t("call_word") : t("meeting_word");
    if (m.status === "pending" && m.proposed_by === other && !state.shown.has("m" + m.id + side)) {
      state.shown.add("m" + m.id + side);
      showModal(`<h3>${esc(t("request_meeting_title"))}</h3><p>${esc(t("request_meeting_body", { who, what, time: fmt(m.start_utc) }))}</p>
        <div class="actions"><button class="btn" id="ok">✔ ${esc(t("agree"))}</button><button class="btn alt" id="no">${esc(t("decline"))}</button></div>`);
      $("#ok").onclick = async () => { closeModal(); await api(`/api/meetings/${m.id}/respond`, { method: "POST", body: { accept: true } }); ctx.refresh(); };
      $("#no").onclick = async () => { closeModal(); await api(`/api/meetings/${m.id}/respond`, { method: "POST", body: { accept: false } }); ctx.refresh(); };
      return;
    }
    const calKey = `cal_${side}_${m.id}`;
    if (m.status === "accepted" && !localStorage.getItem(calKey) && !state.shown.has(calKey)) {
      state.shown.add(calKey);
      fetch(`/api/meetings/${m.id}/calendar-links`).then(r => r.json()).then(l => {
        if (modalOpen) { state.shown.delete(calKey); return; }
        localStorage.setItem(calKey, "1");
        showModal(`<h3>${esc(t("add_calendar_title"))}</h3><p><b>${esc(fmt(m.start_utc))}</b><br>${esc(what)}</p><div class="opts">
          <a class="btn" href="${esc(l.google)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(t("google_cal"))}</a>
          <a class="btn" href="${esc(l.ics)}" style="text-decoration:none">${esc(t("apple_cal"))}</a>
          <a class="btn" href="${esc(l.outlook)}" target="_blank" rel="noopener" style="text-decoration:none">${esc(t("outlook_cal"))}</a></div>
          <div class="actions"><button class="btn alt" onclick="closeModal()">${esc(t("no_thanks"))}</button></div>`);
      });
      return;
    }
  }
  for (const s of data.samples) {
    if (side === "vendor" && s.status === "pending" && !state.shown.has("s" + s.id)) {
      state.shown.add("s" + s.id);
      showModal(`<h3>${esc(t("sample_vendor_title"))}</h3><p>${esc(t("sample_vendor_body", { who }))}</p>
        <div class="actions"><button class="btn" id="ok">✔ ${esc(t("confirm_sample"))}</button><button class="btn alt" id="no">${esc(t("decline"))}</button></div>`);
      $("#ok").onclick = async () => { closeModal(); await api(`/api/samples/${s.id}/respond`, { method: "POST", body: { accept: true } }); ctx.refresh(); };
      $("#no").onclick = async () => { closeModal(); await api(`/api/samples/${s.id}/respond`, { method: "POST", body: { accept: false } }); ctx.refresh(); };
      return;
    }
    if (side === "buyer" && s.status === "confirmed" && !state.shown.has("sa" + s.id)) {
      state.shown.add("sa" + s.id);
      showModal(`<h3>${esc(t("sample_yes_title"))}</h3><p>${esc(t("sample_yes_body"))}</p>
        <input id="a1" placeholder="${esc(t("street"))}"><input id="a2" placeholder="${esc(t("city"))}">
        <div class="actions"><button class="btn" id="ok">${esc(t("send_address"))}</button></div>`);
      $("#ok").onclick = async () => {
        const address = ($("#a1").value + ", " + $("#a2").value).trim(); if (address.length < 6) return;
        closeModal(); await api(`/api/samples/${s.id}/address`, { method: "POST", body: { address } }); ctx.refresh();
      };
      return;
    }
  }
}

/* ---------- vendor side ---------- */
async function renderVendorDash(view, vendorId, tab = "home", openConv = null) {
  stopTimers();
  const v = await api(`/api/vendors/${vendorId}`);
  if (!state.vendorLangSet || state.vendorLangSet !== vendorId) {  // first visit: use the company's own language
    state.vendorLangSet = vendorId;
    if (state.languages.find(l => l.code === v.language) && v.language !== state.lang) { $("#langSel").value = v.language; return setLang(v.language); }
  }
  view.innerHTML = `<h1>${esc(t("vendor_welcome", { name: v.name }))} ${v.emoji}</h1>
    <div class="tabs"><button class="btn ${tab === "home" ? "" : "alt"}" id="tHome">🏠 ${esc(t("vendor_home"))}</button>
    <button class="btn ${tab === "leads" ? "" : "alt"}" id="tLeads">${esc(t("leads"))}</button>
    <button class="btn ${tab === "booth" ? "" : "alt"}" id="tBooth">${esc(t("my_booth"))}</button>
    </div><div id="pane"></div>`;
  $("#tHome").onclick = () => renderVendorDash(view, vendorId, "home");
  $("#tLeads").onclick = () => renderVendorDash(view, vendorId, "leads");
  $("#tBooth").onclick = () => renderVendorDash(view, vendorId, "booth");
  if (tab === "booth") return renderBoothEditor($("#pane"), v);
  if (openConv) return openVendorChat($("#pane"), openConv, v, view);
  if (tab === "home") {
    await paintVendorHome($("#pane"), v, view);
    state.vendorTimer = setInterval(() => { if (!modalOpen) paintVendorHome($("#pane"), v, view); }, 5000);
    return;
  }
  await paintLeads($("#pane"), v, view);
  state.vendorTimer = setInterval(() => { if (!modalOpen) paintLeads($("#pane"), v, view); }, 4000);
}
/* Vendor home: counters, what needs an answer, meetings coming up, samples to ship, recent buyers. */
async function paintVendorHome(pane, v, view) {
  const items = await fetch(`/api/vendor/${v.id}/dashboard?lang=${state.lang}&session=${state.session}`).then(r => r.json());
  if (!$("#pane") || $("#tHome") === null) return;
  const now = Date.now(), todo = [], waiting = [], upcoming = [], ship = [];
  for (const c of items) {
    const open = `onclick="renderVendorDash($('#view'),'${v.id}','leads',${c.conv_id})"`;
    for (const m of c.meetings) {
      const what = m.app ? m.app + " " + t("call_word") : t("meeting_word"), time = fmtLocal(new Date(m.start_utc));
      if (m.status === "pending" && m.proposed_by === "buyer") todo.push({ open, icon: "📅", text: t("todo_v_meeting", { buyer: c.buyer_name, what, time }) });
      if (m.status === "pending" && m.proposed_by === "vendor") waiting.push({ open, icon: "⏳", text: t("wait_v_meeting", { buyer: c.buyer_name, what, time }) });
      if (m.status === "accepted" && new Date(m.start_utc).getTime() > now - 30 * 60000) upcoming.push({ c, m, what, open });
    }
    for (const s of c.samples) {
      if (s.status === "pending") todo.push({ open, icon: "📦", text: t("todo_v_sample", { buyer: c.buyer_name }) });
      if (s.status === "confirmed") waiting.push({ open, icon: "⏳", text: t("wait_v_address", { buyer: c.buyer_name }) });
      if (s.status === "shipped") ship.push({ c, s, open });
    }
  }
  upcoming.sort((a, b) => new Date(a.m.start_utc) - new Date(b.m.start_utc));
  const stat = (n, label, hot) => `<div class="stat ${hot ? "hot" : ""}"><b>${n}</b><span>${esc(label)}</span></div>`;
  const todoRow = x => `<div class="lead" tabindex="0" ${x.open}><div>${x.icon} ${esc(x.text)}</div><button class="btn">${esc(t("open_chat"))}</button></div>`;
  const meetRow = x => `<div class="lead" tabindex="0" ${x.open}><div><b>${esc(fmtLocal(new Date(x.m.start_utc)))}</b> · ${esc(x.what)}<br>${esc(x.c.buyer_name)}${x.m.link ? `<br><a href="${esc(x.m.link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${esc(x.m.link)}</a>` : ""}</div></div>`;
  const shipRow = x => `<div class="lead" tabindex="0" ${x.open}><div>📦 <b>${esc(x.c.buyer_name)}</b><br>${esc(t("ship_to", { address: x.s.address }))}</div></div>`;
  const buyerRow = c => `<div class="lead" tabindex="0" onclick="renderVendorDash($('#view'),'${v.id}','leads',${c.conv_id})"><div><b>${esc(c.buyer_name)}</b><br><span class="sub" style="margin:0">${esc(c.last_text)}</span></div>
    <span class="sub" style="margin:0;white-space:nowrap">${esc(fmtLocal(new Date(c.last_time.replace(" ", "T") + "Z")))}</span></div>`;
  pane.innerHTML = `<div class="stats">${stat(items.length, t("stat_buyers"))}${stat(todo.length, t("stat_pending"), todo.length)}${stat(upcoming.length, t("stat_meetings"))}${stat(ship.length, t("stat_ship"))}</div>
    <h2>${esc(t("pending_for_you"))}</h2>${todo.length ? todo.map(todoRow).join("") : `<p class="sub">${esc(t("nothing_pending"))}</p>`}${waiting.map(todoRow).join("")}
    <h2 style="margin-top:26px">${esc(t("upcoming_meetings"))}</h2>${upcoming.length ? upcoming.map(meetRow).join("") : `<p class="sub">${esc(t("no_meetings"))}</p>`}
    <h2 style="margin-top:26px">${esc(t("samples_to_ship"))}</h2>${ship.length ? ship.map(shipRow).join("") : `<p class="sub">${esc(t("no_ship"))}</p>`}
    <h2 style="margin-top:26px">${esc(t("recent_buyers"))}</h2>${items.length ? items.map(buyerRow).join("") : `<p class="sub">${esc(t("no_leads"))}</p>`}`;
  for (const c of items) if (c.meetings.some(m => m.status === "pending" && m.proposed_by === "buyer") || c.samples.some(s => s.status === "pending")) {
    if (modalOpen) break;  // approval pop-ups appear on the home page too
    const data = await fetch(`/api/conversations/${c.conv_id}?lang=${state.lang}&session=${state.session}`).then(r => r.json());
    handleRequests(data, "vendor", { refresh: () => paintVendorHome(pane, v, view) });
  }
}

async function paintLeads(pane, v, view) {
  const items = await fetch(`/api/vendor/${v.id}/inbox?lang=${state.lang}&session=${state.session}`).then(r => r.json());
  if (!$("#pane") || $("#tLeads") === null) return;
  pane.innerHTML = items.length ? items.map(c => {
    const pend = c.pending_meetings + c.pending_samples;
    return `<div class="lead" tabindex="0" data-c="${c.id}"><div><b>${esc(c.buyer_name)}</b><br><span class="sub" style="margin:0">${esc(c.last_en)}</span></div>
      ${pend ? `<span class="badge">${esc(t("pending"))}</span>` : ""}</div>`;
  }).join("") : `<p class="sub">${esc(t("no_leads"))}</p>`;
  pane.querySelectorAll(".lead").forEach(el => el.onclick = () => renderVendorDash(view, v.id, "leads", +el.dataset.c));
  for (const c of items) if ((c.pending_meetings || c.pending_samples) && !modalOpen) {  // pop-up on the dashboard itself
    const data = await fetch(`/api/conversations/${c.id}?lang=${state.lang}&session=${state.session}`).then(r => r.json());
    handleRequests(data, "vendor", { refresh: () => paintLeads(pane, v, view) });
  }
}
function openVendorChat(pane, convId, v, view) {
  pane.innerHTML = `<button class="btn alt" id="bk">← ${esc(t("leads"))}</button><div id="chatbox" style="margin-top:12px"></div>`;
  $("#bk").onclick = () => renderVendorDash(view, v.id, "leads");
  mountChat($("#chatbox"), convId, "vendor", v);
}
function renderBoothEditor(pane, v) {
  pane.innerHTML = `<div class="panel form"><label>${esc(t("description"))}</label><textarea id="desc" rows="3">${esc(v.description)}</textarea>
    <label>${esc(t("sample_policy"))}</label><input id="pol" value="${esc(v.sample_policy)}">
    <label style="font-weight:400"><input type="checkbox" id="auto" style="width:auto" ${v.auto_accept !== false ? "checked" : ""}> ${esc(t("auto_accept"))}</label>
    <div class="actions" style="margin-top:12px"><button class="btn" id="save">${esc(t("save"))}</button></div>
    <h2 style="margin-top:26px">${esc(t("add_product"))}</h2><div class="grid2">
    <div><label>${esc(t("product_name"))}</label><input id="pn"></div><div><label>${esc(t("unit"))}</label><input id="pu"></div>
    <div><label>${esc(t("price"))}</label><input id="pp" type="number" step="0.01"></div><div><label>${esc(t("minimum"))}</label><input id="pm" type="number"></div></div>
    <div class="actions" style="margin-top:12px"><button class="btn" id="addp">${esc(t("add"))}</button></div></div>`;
  $("#save").onclick = async () => { await api(`/api/vendor/${v.id}/booth`, { method: "PUT", body: { description: $("#desc").value, sample_policy: $("#pol").value, auto_accept: $("#auto").checked } }); state.vendors = []; toast(t("saved")); };
  $("#addp").onclick = async () => {
    await api(`/api/vendor/${v.id}/booth`, { method: "PUT", body: { add_product: { name: $("#pn").value, unit: $("#pu").value || "unit", price: $("#pp").value, min_order: $("#pm").value } } });
    state.vendors = []; toast(t("saved"));
  };
}

/* ---------- start ---------- */
(async function init() {
  state.languages = await fetch("/api/languages").then(r => r.json());
  $("#langSel").innerHTML = state.languages.map(l => `<option value="${l.code}">${esc(l.name)}</option>`).join("");
  $("#langSel").value = state.lang;
  $("#langSel").onchange = e => setLang(e.target.value);
  $("#usageBtn").onclick = showUsage;
  $("#logoutBtn").onclick = logOut;
  $("#overlay").onclick = e => { if (e.target.id === "overlay" && !$("#modal input#nm")) closeModal(); };
  await loadUi(); updateTokens(); render();
})();
