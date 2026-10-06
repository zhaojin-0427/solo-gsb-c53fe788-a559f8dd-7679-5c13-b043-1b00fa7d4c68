// 字幕节奏与镜头边界校正台 —— 原生 JS 前端
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  project: null,
  deliveryVerify: null,      // 当前展示的核验结果（绑定 project_id + timeline_hash）
  deliverySnapshot: null,    // 最近一次“已提交”稿件在提交瞬间读取到的快照
  verifyUploadSeq: 0,        // 提交序号：每次点击上传并核验递增，自动重核不递增
  verifyRequestSeq: 0,       // 请求序号：每次核验请求递增，用于丢弃同稿迟到响应
  verifyInflightSeq: null,   // 当前在途的读稿/核验请求序号；防止变轴时并发重核
  verifyNotice: "",          // 无结果时核验区显示的提示（已作废 / 重新核验中）
};

const VERIFY_LABEL = {
  pass: "通过",
  time_mismatch: "时间不符",
  missing: "缺失",
  new: "新增",
  pending: "待确认",
};

// ---------- 工具 ----------
function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 3200);
}

function fmtMs(ms) {
  if (ms == null) return "—";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return [h, m, s].map(v => String(v).padStart(2, "0")).join(":") +
         "," + String(x).padStart(3, "0");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : {"Content-Type": "application/json"},
    ...opts,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  return res.json();
}

// ---------- 项目列表 ----------
async function loadProjects(selectId) {
  const rows = await api("/api/projects");
  const sel = $("#projectSelect");
  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = ""; opt0.textContent = "— 选择历史项目 —";
  sel.appendChild(opt0);
  for (const r of rows) {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = `#${r.id} ${r.name}（${r.cue_count} 条，采纳 ${r.adopted_count}）`;
    sel.appendChild(o);
  }
}

// ---------- 渲染 ----------
const DECISION_LABEL = { intentional: "有意留白", needs_subtitle: "待补字幕" };

function renderGapReview(p) {
  const panel = $("#gapReviewPanel");
  const gr = p.gap_review;
  if (!gr || !gr.shot_count) {           // 无镜头：不生成审阅项
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");
  $("#gapStats").innerHTML = [
    ["留白区间", gr.total, ""],
    ["待审", gr.pending_count, gr.pending_count ? "warn" : "good"],
    ["已审", gr.total - gr.pending_count, "good"],
  ].map(([k, v, cls]) => `<span class="stat ${cls}">${k} <b>${v}</b></span>`).join("");

  const list = $("#gapList");
  list.innerHTML = "";
  const byShot = new Map();              // 相接/重叠镜头分别列出
  for (const it of gr.items) {
    const arr = byShot.get(it.shot_ord) || [];
    arr.push(it);
    byShot.set(it.shot_ord, arr);
  }
  for (const [ord, items] of byShot) {
    const box = document.createElement("div");
    box.className = "shot-gaps";
    const head = document.createElement("div");
    head.className = "shot-head";
    head.textContent = `镜头 #${ord}　${fmtMs(items[0].shot_start_ms)} → ` +
      `${fmtMs(items[0].shot_end_ms)}（${items[0].shot_start_ms} → ${items[0].shot_end_ms} ms）`;
    box.appendChild(head);
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "gap-item";
      const pill = it.decision
        ? `<span class="pill ${it.decision === "intentional" ? "intentional" : "needs-sub"}">${DECISION_LABEL[it.decision]}</span>`
        : `<span class="pill proposed">待审</span>`;
      const attrs = `data-shot="${it.shot_ord}" data-start="${it.gap_start_ms}" data-end="${it.gap_end_ms}"`;
      row.innerHTML = `
        <span class="gap-time">${fmtMs(it.gap_start_ms)} → ${fmtMs(it.gap_end_ms)}<span class="muted">${it.gap_start_ms} → ${it.gap_end_ms} ms · 时长 ${it.duration_ms} ms</span></span>
        ${pill}
        <span class="row-actions">
          <button class="mini" data-gap-act="intentional" ${attrs}>有意留白</button>
          <button class="mini" data-gap-act="needs_subtitle" ${attrs}>待补字幕</button>
          ${it.decision ? `<button class="mini" data-gap-act="clear" ${attrs}>清除</button>` : ""}
        </span>`;
      box.appendChild(row);
    }
    list.appendChild(box);
  }
}

// ---------- 交付字幕核验 ----------
// 核验结论与「项目 + 生效时间轴 + 已提交稿件 + 上传序号」绑定：
// - “上传并核验”的提交动作才是稿件切换边界。提交时立即把文件内容读入
//   deliverySnapshot；此后自动重核只使用这份快照。仅在文件框改选乙而未提交，
//   不会影响甲；即使清空文件框，甲的快照仍可读取，也继续用甲自动重核。
// - 服务端在项目详情与核验响应中返回同一 timeline_hash（生效轴指纹）。
//   参数重算 / 采纳 / 撤销改变了生效轴后，旧结论立即作废；快照仍可读时
//   自动按新轴重新核验，快照不可读时提示重传。生效轴未变（如仅调 CPS、
//   相同参数重提）或修改失败时，结论保留。
// - 响应指纹与本页详情不符时，本页详情可能已过期（另一标签页改轴）：
//   先拉取该项目最新详情再裁决——响应指纹与最新详情一致，说明已返回的
//   结论按新详情仍然有效，直接接纳并同步页面；仍不一致（等待期间生效轴
//   再次变化）才用最近一次已提交快照按新轴重核。自动重核链有终止条件
//   （VERIFY_MAX_AUTO_ATTEMPTS）：详情刷新失败、快照不可用或达到上限
//   时立即停止并提示重新上传——不显示旧结论，也不无界发请求。
// - verifyUploadSeq 标识最近一次提交动作；verifyRequestSeq 标识每一次
//   核验请求。迟到响应必须同时属于当前项目、当前提交和当前在途请求才可
//   落地：未提交的改选稿不能取代旧稿，旧项目或旧提交的迟到响应也会丢弃。
const VERIFY_MAX_AUTO_ATTEMPTS = 3;  // 一条自动重核链最多发起的核验请求数

function resetDeliveryVerify() {
  state.deliveryVerify = null;
  state.deliverySnapshot = null;
  state.verifyNotice = "";
  state.verifyInflightSeq = null;
  state.verifyUploadSeq++;             // 使在途的旧提交/旧详情全部失效
  state.verifyRequestSeq++;
  const f = $("#deliveryVerifyForm");
  if (f) f.reset();
}

function isReadableDeliverySnapshot(snapshot) {
  if (!snapshot) return false;
  if (typeof snapshot.bytes === "string") return snapshot.bytes.length > 0;
  return !!snapshot.bytes && Number(snapshot.size) > 0;
}

async function readDeliveryFile(file) {
  const buffer = await file.arrayBuffer();
  // 复制一份 ArrayBuffer，避免底层 File/Blob 生命周期变化后快照不可读。
  const copy = buffer.slice(0);
  const bytes = typeof Blob === "function" ? new Blob([copy]) : copy;
  return {name: file.name || "", bytes, size: copy.byteLength};
}

function verifyStale(uploadSeq, requestSeq, pid) {
  return uploadSeq !== state.verifyUploadSeq ||
         state.verifyInflightSeq !== requestSeq ||
         !state.project || state.project.id !== pid;
}

function invalidateDeliveryVerify(message) {
  state.verifyInflightSeq = null;
  state.deliverySnapshot = null;
  state.deliveryVerify = null;
  state.verifyNotice = message;
  renderDeliveryVerify();
}

function failSubmittedDeliveryVerify(fallback, message) {
  state.verifyInflightSeq = null;
  const current = state.project;
  const oldResult = fallback?.result;
  const oldSnapshot = fallback?.snapshot;
  if (oldResult && current && oldResult.project_id === current.id &&
      oldResult.timeline_hash === current.timeline_hash) {
    // 新稿提交后读取/服务端解析失败：它不能取代上一份仍对当前生效轴
    // 有效的结论；后续自动重核继续沿用上一份快照。
    state.deliverySnapshot = oldSnapshot;
    state.deliveryVerify = oldResult;
    state.verifyNotice = "";
    renderDeliveryVerify();
    return;
  }
  if (isReadableDeliverySnapshot(oldSnapshot)) {
    // 提交失败时生效轴也已变化：新稿没有成为已提交稿，回到上一份成功
    // 提交的甲稿并按当前轴重核。
    state.deliverySnapshot = oldSnapshot;
    state.deliveryVerify = null;
    state.verifyNotice = "新提交稿未能核验，正在用最近一次已提交稿重新核验…";
    renderDeliveryVerify();
    runDeliveryVerify(oldSnapshot);
    return;
  }
  invalidateDeliveryVerify(message);
}

function syncDeliveryVerify() {
  const p = state.project;
  const v = state.deliveryVerify;
  if (!v) return;
  if (!p || v.project_id !== p.id) {
    // 项目已切换 / 删除（正常路径已由 resetDeliveryVerify 清理，此为防御）
    state.deliveryVerify = null;
    state.verifyNotice = "";
    return;
  }
  if (v.timeline_hash === p.timeline_hash) return;   // 生效轴未变：保留
  // 生效轴已变化：旧结论立即作废，不再显示
  state.deliveryVerify = null;
  if (state.verifyInflightSeq !== null) {
    // 当前提交/重核仍在途：让该请求按指纹裁决，不得另发一条重核请求。
    state.verifyNotice = "生效时间轴已变化，正在等待当前已提交稿件的核验结果…";
    return;
  }
  const snapshot = state.deliverySnapshot;
  if (isReadableDeliverySnapshot(snapshot)) {
    state.verifyNotice = "生效时间轴已变化，正在用最近一次已提交稿重新核验…";
    runDeliveryVerify(snapshot);
  } else {
    state.verifyNotice = "生效时间轴已变化，旧核验结论已作废，请重新上传回传稿。";
  }
}

function acceptDeliveryVerify(result, requestSeq) {
  if (state.verifyInflightSeq === requestSeq) state.verifyInflightSeq = null;
  state.verifyNotice = "";
  state.deliveryVerify = result;
  renderDeliveryVerify();
  const s = result.summary;
  toast(`核验完成：通过 ${s.pass} · 时间不符 ${s.time_mismatch} · ` +
        `缺失 ${s.missing} · 新增 ${s.new} · 待确认 ${s.pending}`);
}

async function submitDeliveryVerify(file) {
  const p = state.project;
  if (!p || !file) return;
  const uploadSeq = ++state.verifyUploadSeq;
  const readRequestSeq = ++state.verifyRequestSeq;
  const fallback = {result: state.deliveryVerify,
                    snapshot: state.deliverySnapshot};
  state.verifyInflightSeq = readRequestSeq;
  state.deliveryVerify = null;
  state.verifyNotice = `正在核验「${file.name || "交付稿"}」…`;
  renderDeliveryVerify();

  let snapshot;
  try {
    snapshot = await readDeliveryFile(file);
  } catch (e) {
    if (verifyStale(uploadSeq, readRequestSeq, p.id)) return;
    failSubmittedDeliveryVerify(
      fallback, `无法读取回传稿：${e.message}，请重新上传。`);
    toast(e.message, true);
    return;
  }
  if (verifyStale(uploadSeq, readRequestSeq, p.id)) return;
  state.deliverySnapshot = snapshot;  // 成功读取后，乙才真正成为最近提交稿
  await runDeliveryVerify(snapshot, 0, uploadSeq, fallback);
}

async function runDeliveryVerify(snapshot, attempt = 0,
                                 uploadSeq = state.verifyUploadSeq,
                                 fallback = null) {
  const p = state.project;
  if (!p || !isReadableDeliverySnapshot(snapshot)) return;
  const requestSeq = ++state.verifyRequestSeq;
  state.verifyInflightSeq = requestSeq;
  const fd = new FormData();
  fd.append("delivery", snapshot.bytes, snapshot.name);
  try {
    const result = await api(`/api/projects/${p.id}/verify-delivery`,
                             { method: "POST", body: fd });
    if (verifyStale(uploadSeq, requestSeq, p.id)) return;
    if (result.project_id !== p.id) return;               // 防御
    if (result.timeline_hash === state.project.timeline_hash) {
      acceptDeliveryVerify(result, requestSeq);          // 指纹相符：结论有效
      return;
    }
    // 指纹不符：本页详情可能已过期（另一标签页改轴），先取最新详情再裁决
    await reconcileDeliveryVerify(result, snapshot, uploadSeq, requestSeq,
                                  attempt);
  } catch (e) {
    if (verifyStale(uploadSeq, requestSeq, p.id)) return;
    if (fallback) {
      failSubmittedDeliveryVerify(
        fallback, `提交稿件核验失败：${e.message}，请重新上传回传稿。`);
    } else {
      invalidateDeliveryVerify(
        `自动重新核验失败：${e.message}，请重新上传回传稿。`);
    }
    toast(e.message, true);
  }
}

// 核验响应指纹与本页详情不符：本页详情可能已过期（另一标签页改参数/采纳），
// 先拉取该项目最新详情再裁决——
// - 响应指纹与最新详情一致：已返回的结论按新详情仍然有效，接纳并同步页面；
// - 仍不一致：生效轴在等待期间再次变化，用最近一次已提交快照按新轴重核。
// 终止条件：自动重核链达到 VERIFY_MAX_AUTO_ATTEMPTS 次、详情刷新失败或
// 快照不可用时立即停止，作废旧结论并提示重新上传，不无界发请求。
async function reconcileDeliveryVerify(result, snapshot, uploadSeq,
                                       requestSeq, attempt) {
  const pid = result.project_id;
  let fresh;
  try {
    fresh = await api(`/api/projects/${pid}`);
  } catch (e) {
    if (verifyStale(uploadSeq, requestSeq, pid)) return;
    invalidateDeliveryVerify(
      `项目详情刷新失败：${e.message}，核验结论已作废，请重新上传回传稿。`);
    toast(e.message, true);
    return;
  }
  if (verifyStale(uploadSeq, requestSeq, pid)) return;
  state.project = fresh;          // 页面详情同步到最新（另一标签页的改动）
  if (result.timeline_hash === fresh.timeline_hash) {
    acceptDeliveryVerify(result, requestSeq);   // 结论按新详情可接纳
    render();
    loadProjects();
    return;
  }
  // 生效轴在等待期间又变化：已返回的结论不可接纳，需按最新生效轴重核
  state.deliveryVerify = null;
  if (!isReadableDeliverySnapshot(snapshot)) {
    invalidateDeliveryVerify(
      "生效时间轴已变化，旧核验结论已作废，请重新上传回传稿。");
    render();
    return;
  }
  if (attempt + 1 >= VERIFY_MAX_AUTO_ATTEMPTS) {
    invalidateDeliveryVerify(
      "生效时间轴多次变化，自动重新核验已停止，请重新上传回传稿。");
    render();
    return;
  }
  state.verifyNotice = "生效时间轴已变化，正在用最近一次已提交稿重新核验…";
  render();
  await runDeliveryVerify(snapshot, attempt + 1, uploadSeq);
}

function renderDeliveryVerify() {
  const v = state.deliveryVerify;
  const tb = $("#verifyTable tbody");
  const stats = $("#verifyStats");
  tb.innerHTML = "";
  if (!v) {
    stats.innerHTML = "";
    $("#deliveryName").textContent = state.verifyNotice || "";
    return;
  }
  $("#deliveryName").textContent =
    `已核验：${v.delivery_name || "交付稿"}（生效轴 ${v.reference_count} 条 / 交付 ${v.delivered_count} 条 / 同文案配对 ${v.matched_text_count} 对）`;
  const s = v.summary;
  stats.innerHTML = [
    ["通过", s.pass, "good"],
    ["时间不符", s.time_mismatch, s.time_mismatch ? "bad" : "good"],
    ["缺失", s.missing, s.missing ? "bad" : "good"],
    ["新增", s.new, s.new ? "warn" : ""],
    ["待确认", s.pending, s.pending ? "warn" : "good"],
  ].map(([k, n, cls]) => `<span class="stat ${cls}">${k} <b>${n}</b></span>`).join("");

  const cell = (ord, start, end, cls = "") => ord == null
    ? `<td class="muted">—</td>`
    : `<td class="${cls}">#${ord}<span class="muted">${start} → ${end} ms</span></td>`;

  for (const r of v.rows) {
    const tr = document.createElement("tr");
    tr.className = `verify-row verdict-${r.verdict}`;
    const pill = `<span class="pill vf-${r.verdict}">${VERIFY_LABEL[r.verdict]}</span>`;
    let body;
    if (r.kind === "match") {
      const dCls = r.verdict === "time_mismatch" || r.verdict === "pending"
        ? "vf-time" : "";
      const dTxt = (n) => (n > 0 ? "+" : "") + n;
      const deltaCls = r.delta_start_ms === 0 && r.delta_end_ms === 0
        ? "delta-zero" : "vf-time";
      const textFlag = r.text_same ? ""
        : `<div class="hash warn-text">⚠ 等优对应中文案不同，请人工核对</div>`;
      body = `
        <td>${pill}</td>
        ${cell(r.ref_ord, r.ref_start_ms, r.ref_end_ms)}
        ${cell(r.del_ord, r.del_start_ms, r.del_end_ms, dCls)}
        <td class="${deltaCls}">${dTxt(r.delta_start_ms)} / ${dTxt(r.delta_end_ms)}</td>
        <td class="text-cell">${esc(r.text)}${textFlag}</td>`;
    } else if (r.kind === "ref_only") {
      const cand = r.candidate
        ? `<div class="hash">等优候选：交付 #${cand.del_ord}
             ${cand.del_start_ms} → ${cand.del_end_ms} ms「${esc(cand.delivered_text)}」</div>`
        : "";
      body = `
        <td>${pill}</td>
        ${cell(r.ref_ord, r.ref_start_ms, r.ref_end_ms)}
        <td class="muted">—</td>
        <td class="muted">—</td>
        <td class="text-cell">${esc(r.text)}${cand}</td>`;
    } else {
      const cand = r.candidate
        ? `<div class="hash">等优候选：生效轴 #${cand.ref_ord}
             ${cand.ref_start_ms} → ${cand.ref_end_ms} ms「${esc(cand.text)}」</div>`
        : "";
      body = `
        <td>${pill}</td>
        <td class="muted">—</td>
        ${cell(r.del_ord, r.del_start_ms, r.del_end_ms)}
        <td class="muted">—</td>
        <td class="text-cell">${esc(r.delivered_text)}${cand}</td>`;
    }
    tr.innerHTML = body;
    tb.appendChild(tr);
  }
}

function render() {
  syncDeliveryVerify();   // 先按最新生效轴同步核验状态（作废/自动重核）
  const p = state.project;
  if (!p) {
    $("#workspace").classList.add("hidden");
    $("#importPanel").classList.remove("hidden");
    renderDeliveryVerify();
    return;
  }
  $("#importPanel").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  $("#projectTitle").textContent = `#${p.id} ${p.name}`;
  const sf = $("#settingsForm");
  sf.cps_limit.value = p.cps_limit;
  sf.min_gap_ms.value = p.min_gap_ms;
  sf.tolerance_ms.value = p.tolerance_ms;

  const st = p.analysis.stats;
  $("#stats").innerHTML = [
    ["条目数", st.cue_count, ""],
    ["镜头数", st.shot_count, ""],
    ["间隔/重叠问题", st.gap_violations, st.gap_violations ? "bad" : "good"],
    ["CPS 超限", st.cps_violations, st.cps_violations ? "bad" : "good"],
    ["跨镜头条目", st.cross_shot_count, st.cross_shot_count ? "bad" : "good"],
    ["可提案条目", st.proposal_count, "good"],
    ["需移动条目", st.proposal_moved_count, "warn"],
    ["冲突条目", st.conflict_cue_count, st.conflict_cue_count ? "bad" : "good"],
    ["总移动量", st.total_shift_ms + " ms", ""],
  ].map(([k, v, cls]) => `<span class="stat ${cls}">${k} <b>${v}</b></span>`).join("");

  const conf = $("#conflicts");
  conf.innerHTML = "";
  for (const ch of p.analysis.chains) {
    const div = document.createElement("div");
    div.className = "chain";
    div.innerHTML = `<span class="tag">冲突链 ${ch.cue_ids.join(" → ")}</span>${esc(ch.reason)}`;
    conf.appendChild(div);
  }
  for (const it of p.analysis.intrinsic) {
    const div = document.createElement("div");
    div.className = "chain intrinsic";
    div.innerHTML = `<span class="tag">内在冲突 · ${esc(it.cue_id)}</span>${esc(it.reason)}`;
    conf.appendChild(div);
  }

  const tb = $("#cueTable tbody");
  tb.innerHTML = "";
  for (const c of p.analysis.cues) {
    const tr = document.createElement("tr");
    const flags = [];
    if (c.overlap_with) flags.push(`<span class="flag gap" title="${esc(c.overlap_with)}">间隔</span>`);
    if (!c.cps_ok) flags.push(`<span class="flag" title="CPS ${c.cps} 超限">CPS ${c.cps}</span>`);
    if (c.cross_shot) flags.push(`<span class="flag cross">跨镜头</span>`);

    const propTxt = c.proposal_start_ms == null ? "—（无解）"
      : `${c.proposal_start_ms} → ${c.proposal_end_ms}`;
    let deltaCls = "delta-zero", dTxt = "—";
    if (c.proposal_start_ms != null) {
      const d = c.proposal_start_ms - c.start_ms;
      dTxt = (d > 0 ? "+" : "") + d + " ms";
      deltaCls = d === 0 ? "delta-zero" : "delta-pos";
    }
    let status;
    if (c.adopted) {
      status = `<span class="pill adopted">已采纳</span>`;
    } else if (c.proposal_start_ms != null) {
      status = `<span class="pill proposed">待采纳</span>`;
    } else {
      status = `<span class="pill conflict">冲突</span>`;
    }
    const canAdopt = c.proposal_start_ms != null;
    const actionBtns = `
      <div class="row-actions">
        ${canAdopt ? `<button class="mini primary" data-act="adopt" data-uid="${c.uid}">采纳</button>` : ""}
        ${c.adopted ? `<button class="mini" data-act="revert" data-uid="${c.uid}">撤销</button>` : ""}
      </div>`;
    const startShown = c.adopted_start_ms ?? c.start_ms;
    const endShown = c.adopted_end_ms ?? c.end_ms;
    tr.className = c.proposal_start_ms == null ? "row-bad" : "";
    tr.innerHTML = `
      <td>${c.ord}</td>
      <td>${esc(c.cue_id)}</td>
      <td class="text-cell">${esc(c.text)}<div class="hash">sha256:${c.raw_hash.slice(0, 16)}…</div></td>
      <td>${startShown} → ${endShown}</td>
      <td>${c.duration_ms}</td>
      <td>${c.graphemes}</td>
      <td class="${c.cps_ok ? "cps-ok" : "cps-bad"}">${c.cps === Infinity ? "∞" : c.cps}</td>
      <td>${flags.join("") || "—"}</td>
      <td>${propTxt}</td>
      <td class="${deltaCls}">${dTxt}</td>
      <td>${status}${actionBtns}</td>`;
    tb.appendChild(tr);
  }

  const base = `/api/projects/${p.id}/export`;
  $("#exportJson").href = base + "?fmt=json";
  $("#exportZip").href = base + "?fmt=zip";
  $("#exportSrt").href = base + "?fmt=srt";
  $("#projectSelect").value = String(p.id);
  renderGapReview(p);
  renderDeliveryVerify();
}

// 采纳可能因另一标签页并发改参数而被拒（旧提案失效）：重新拉取详情，
// 让表格与统计条回到服务端的最新一致状态。
async function refreshAfterConflict(pid) {
  try {
    state.project = await api(`/api/projects/${pid}`);
    render();
    loadProjects();
  } catch (_) {}
}

// ---------- 事件 ----------
$("#importForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const fd = new FormData();
  fd.append("name", f.name.value.trim() || "未命名项目");
  fd.append("cps_limit", f.cps_limit.value);
  fd.append("min_gap_ms", f.min_gap_ms.value);
  fd.append("tolerance_ms", f.tolerance_ms.value);
  fd.append("subtitle", f.subtitle.files[0]);
  if (f.shots_file.files[0]) fd.append("shots_file", f.shots_file.files[0]);
  try {
    state.project = await api("/api/projects", { method: "POST", body: fd });
    resetDeliveryVerify();
    toast("导入并分析完成");
    await loadProjects();
    render();
  } catch (e) { toast(e.message, true); }
});

$("#settingsForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.project) return;
  const f = ev.target;
  try {
    state.project = await api(`/api/projects/${state.project.id}/settings`, {
      method: "PUT",
      body: JSON.stringify({
        cps_limit: parseFloat(f.cps_limit.value),
        min_gap_ms: parseInt(f.min_gap_ms.value, 10),
        tolerance_ms: parseInt(f.tolerance_ms.value, 10),
      }),
    });
    toast("已按新参数重新求解");
    render();
    loadProjects();
  } catch (e) { toast(e.message, true); }
});

$("#cueTable").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn || !state.project) return;
  const uid = parseInt(btn.dataset.uid, 10);
  const c = state.project.analysis.cues.find(x => x.uid === uid);
  const pid = state.project.id;
  try {
    if (btn.dataset.act === "adopt") {
      state.project = await api(`/api/projects/${pid}/adopt`, {
        method: "POST",
        body: JSON.stringify({
          cue_uid: uid,
          new_start_ms: c.proposal_start_ms,
          new_end_ms: c.proposal_end_ms,
        }),
      });
      toast(`已采纳 cue ${c.cue_id}`);
    } else {
      state.project = await api(`/api/projects/${pid}/adopt/${uid}`,
                                { method: "DELETE" });
      toast(`已撤销 cue ${c.cue_id}`);
    }
    render();
    loadProjects();
  } catch (e) {
    toast(e.message + "（参数可能已在别处更新，已刷新）", true);
    refreshAfterConflict(pid);
  }
});

$("#adoptAllBtn").addEventListener("click", async () => {
  if (!state.project) return;
  const todo = state.project.analysis.cues.filter(
    c => c.proposal_start_ms != null && !c.adopted);
  if (!todo.length) return toast("没有可采纳的提案");
  try {
    let p = state.project;
    for (const c of todo) {
      p = await api(`/api/projects/${p.id}/adopt`, {
        method: "POST",
        body: JSON.stringify({
          cue_uid: c.uid,
          new_start_ms: c.proposal_start_ms,
          new_end_ms: c.proposal_end_ms,
        }),
      });
    }
    state.project = p;
    toast(`已批量采纳 ${todo.length} 条`);
    render();
    loadProjects();
  } catch (e) {
    toast(e.message + "（参数可能已在别处更新，已刷新）", true);
    refreshAfterConflict(state.project.id);
  }
});

// 镜头留白审阅：标记 / 清除。过期页面（参数或采纳已在别处变化）提交的
// 结论会被服务端 400 拒绝，此时刷新到最新状态，避免误标新留白。
$("#gapList").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("button[data-gap-act]");
  if (!btn || !state.project) return;
  const pid = state.project.id;
  const shotOrd = parseInt(btn.dataset.shot, 10);
  const gapStart = parseInt(btn.dataset.start, 10);
  const gapEnd = parseInt(btn.dataset.end, 10);
  const act = btn.dataset.gapAct;
  try {
    if (act === "clear") {
      const q = `shot_ord=${shotOrd}&gap_start_ms=${gapStart}&gap_end_ms=${gapEnd}`;
      state.project = await api(`/api/projects/${pid}/gaps/review?${q}`,
                                { method: "DELETE" });
      toast("已清除审阅标记，回到待审");
    } else {
      state.project = await api(`/api/projects/${pid}/gaps/review`, {
        method: "POST",
        body: JSON.stringify({
          shot_ord: shotOrd, gap_start_ms: gapStart,
          gap_end_ms: gapEnd, decision: act,
        }),
      });
      toast(`已标记为「${DECISION_LABEL[act]}」`);
    }
    render();
  } catch (e) {
    toast(e.message + "（留白已随参数/采纳变化，已刷新）", true);
    refreshAfterConflict(pid);
  }
});

// 交付字幕核验：上传回传稿，服务端保序最优对应后返回逐行结论。
// 只读核验，失败（空稿/解析失败）仅弹错，不影响当前项目数据。
$("#deliveryVerifyForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!state.project) return;
  const file = ev.target.delivery.files[0];
  if (!file) return;
  // 文件框改选本身不切换稿件；只有提交并成功读取后才保存为稿件快照。
  await submitDeliveryVerify(file);
});

$("#deleteProjectBtn").addEventListener("click", async () => {  if (!state.project) return;
  if (!confirm(`确定删除项目「${state.project.name}」？该操作不可恢复。`)) return;
  try {
    await api(`/api/projects/${state.project.id}`, { method: "DELETE" });
    state.project = null;
    resetDeliveryVerify();
    toast("项目已删除");
    await loadProjects();
    render();
  } catch (e) { toast(e.message, true); }
});

$("#projectSelect").addEventListener("change", async (ev) => {
  const id = ev.target.value;
  if (!id) return;
  resetDeliveryVerify();   // 先作废旧项目核验并使在途响应失效，再切换
  try {
    state.project = await api(`/api/projects/${id}`);
    render();
  } catch (e) { toast(e.message, true); }
});

$("#newProjectBtn").addEventListener("click", () => {
  state.project = null;
  resetDeliveryVerify();
  $("#projectSelect").value = "";
  render();
});

// 初始化
loadProjects().catch(() => {});
