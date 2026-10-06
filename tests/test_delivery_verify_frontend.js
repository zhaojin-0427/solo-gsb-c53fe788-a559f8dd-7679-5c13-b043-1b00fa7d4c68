// 交付字幕核验的前端绑定回归（node 直接运行，无框架）：
// 用最小 DOM/fetch 桩在 vm 中加载 app/static/app.js，验证——
// - 核验结果与「项目 + 生效轴 timeline_hash + 上传序号」绑定；
// - 参数重算/采纳/撤销改变生效轴（hash 变化）后：旧结论立即作废，
//   最近一次“已提交并成功读取”的稿件快照仍可读时自动按新轴重核；
//   仅改选文件框不提交不会替换快照，清空文件框也不影响快照；
// - 生效轴未变（hash 相同）时结论保留，不发多余请求；
// - 跨标签页改轴（本页详情过期）：响应指纹不符时先拉取最新项目详情——
//   结论按新详情有效则直接接纳（不再重核、不循环请求），仍不符才用
//   最近一次已提交稿快照按新轴重核；自动重核有终止条件，详情刷新失败 /
//   快照不可用 / 达到上限时停止并提示重新上传，不显示旧结论；
// - 再次提交、详情刷新或切换项目交错时，迟到的响应被丢弃，只呈现当前
//   项目最近一次有效上传的结果；响应到达即过期（等待期间生效轴被改）
//   时不展示。
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_JS = path.join(__dirname, "..", "app", "static", "app.js");

// ---------- 最小 DOM 桩 ----------
function makeEl(tag = "div") {
  return {
    tagName: tag,
    innerHTML: "",
    textContent: "",
    value: "",
    href: "",
    files: [],
    children: [],
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    reset() { this.files = []; if (this.delivery) this.delivery.files = []; },
    closest() { return null; },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
  };
}

const bySelector = new Map();
const documentStub = {
  querySelector(sel) {
    if (!bySelector.has(sel)) bySelector.set(sel, makeEl());
    return bySelector.get(sel);
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
};

// ---------- fetch 桩：响应时机完全由测试控制 ----------
const pending = [];   // 在途请求 {url, opts, resolve}
const fetchLog = [];
function fetchStub(url, opts = {}) {
  fetchLog.push({ url, method: opts.method || "GET" });
  return new Promise((resolve) => pending.push({ url, opts, resolve }));
}
function popPending(substr) {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].url.includes(substr)) return pending.splice(i, 1)[0];
  }
  throw new Error(`没有在途请求匹配 ${substr}`);
}
function popPendingExact(url) {   // 精确匹配（区分详情 GET 与列表/核验请求）
  for (let i = pending.length - 1; i >= 0; i--) {
    if (pending[i].url === url) return pending.splice(i, 1)[0];
  }
  throw new Error(`没有在途请求匹配 ${url}`);
}
function respondJson(req, body, ok = true, status = 200) {
  req.resolve({ ok, status, json: async () => body });
}
const flush = () => new Promise((r) => setImmediate(r));

class FormDataStub {
  constructor() { this.parts = []; }
  append(k, v, name) { this.parts.push([k, v, name]); }
}

// ---------- 在 vm 中加载 app.js，并暴露词法绑定的 state 与函数 ----------
const src = fs.readFileSync(APP_JS, "utf8") +
  "\n;globalThis.__app = { state, render, renderDeliveryVerify," +
  " syncDeliveryVerify, resetDeliveryVerify, runDeliveryVerify," +
  " submitDeliveryVerify };";
const sandbox = {
  document: documentStub,
  fetch: fetchStub,
  FormData: FormDataStub,
  Blob,
  setTimeout: () => 0,
  clearTimeout: () => {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.js" });
const app = sandbox.__app;
const { state } = app;

// ---------- 测试工具 ----------
function proj(id, hash) {
  return {
    id, name: `P${id}`, cps_limit: 21, min_gap_ms: 40, tolerance_ms: 200,
    created_at: "", timeline_hash: hash,
    shots: [], cues: [],
    analysis: {
      cues: [], chains: [], intrinsic: [],
      stats: { cue_count: 0, shot_count: 0, gap_violations: 0,
               cps_violations: 0, cross_shot_count: 0, proposal_count: 0,
               proposal_moved_count: 0, conflict_cue_count: 0,
               total_shift_ms: 0 },
    },
    gap_review: null,
  };
}
function verifyResult(pid, hash, pass) {
  return { project_id: pid, project_name: `P${pid}`, delivery_name: "d.srt",
           timeline_hash: hash, reference_count: 2, delivered_count: 2,
           matched_text_count: 2,
           summary: { pass, time_mismatch: 0, missing: 0, new: 0,
                      pending: 0 },
           rows: [] };
}
function verifyPostCount() {
  return fetchLog.filter((r) => r.url.includes("/verify-delivery")).length;
}

const deliveryForm = documentStub.querySelector("#deliveryVerifyForm");
deliveryForm.delivery = makeEl("input");
const settingsForm = documentStub.querySelector("#settingsForm");
settingsForm.cps_limit = makeEl("input");
settingsForm.min_gap_ms = makeEl("input");
settingsForm.tolerance_ms = makeEl("input");

function makeDeliveryFile(id) {
  return {
    name: `${id}.srt`,
    arrayBuffer: async () => {
      const body = `content-${id}`;
      const bytes = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i);
      return bytes.buffer.slice(0);
    },
  };
}

function makeUnreadableDeliveryFile(id) {
  return {
    name: `${id}.srt`,
    arrayBuffer: async () => { throw new Error("browser-read-denied"); },
  };
}

function clearVerifyState() {
  state.deliveryVerify = null;
  state.deliverySnapshot = null;
  state.verifyNotice = "";
  state.verifyInflightSeq = null;
  state.verifyUploadSeq += 1;
  state.verifyRequestSeq += 1;
}

async function prepareDelivery(file) {
  const p = app.submitDeliveryVerify(file);
  await flush();                       // await file.arrayBuffer()
  return { promise: p };
}

// ---------- 场景 ----------

async function test_manual_upload_binds_result() {
  clearVerifyState();
  state.project = proj(1, "h1");
  const fileA = makeDeliveryFile("A");
  deliveryForm.delivery.files = [fileA];
  const { promise: p } = await prepareDelivery(fileA);
  assert.strictEqual(verifyPostCount(), 1, "应发出一次核验请求");
  respondJson(popPending("verify-delivery"), verifyResult(1, "h1", 2));
  await p; await flush();
  assert.ok(state.deliveryVerify, "结果应展示");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h1");
  assert.strictEqual(state.deliveryVerify.project_id, 1);
  console.log("frontend manual upload binds project+timeline ok");
}

async function test_timeline_change_auto_reverify() {
  // 参数重算改变生效轴（h1 → h2）：旧结论立即作废，
  // 已选稿仍在 → 自动用同一稿件按新生效轴重新核验
  state.project = proj(1, "h2");
  app.render();
  assert.strictEqual(state.deliveryVerify, null, "旧结论必须立即作废");
  assert.ok(state.verifyNotice.includes("重新核验"), "应提示正在重核");
  assert.strictEqual(verifyPostCount(), 2, "应自动发起重新核验");
  respondJson(popPending("verify-delivery"), verifyResult(1, "h2", 1));
  await flush();
  assert.ok(state.deliveryVerify, "自动重核结果应展示");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h2");
  assert.strictEqual(state.deliveryVerify.summary.pass, 1);
  console.log("frontend timeline change -> invalidate + auto re-verify ok");
}

async function test_timeline_unchanged_keeps_result() {
  // 生效轴未变（如仅调 CPS 上限 / 相同参数重提）：结论保留，不发请求
  state.project = proj(1, "h2");
  const before = verifyPostCount();
  app.render();
  assert.strictEqual(verifyPostCount(), before, "不应发起新核验");
  assert.ok(state.deliveryVerify, "有效结论应保留");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "h2");
  console.log("frontend unchanged timeline keeps result ok");
}

async function test_concurrent_uploads_last_wins() {
  // 连续两次上传：第一次的响应迟到，不得覆盖第二次的结果
  clearVerifyState();
  state.project = proj(1, "h2");
  const fileB = makeDeliveryFile("B");
  deliveryForm.delivery.files = [fileB];
  const { promise: p1 } = await prepareDelivery(fileB);
  const req1 = popPending("verify-delivery");
  const fileB2 = makeDeliveryFile("B2");
  deliveryForm.delivery.files = [fileB2];
  const { promise: p2 } = await prepareDelivery(fileB2);
  const req2 = popPending("verify-delivery");
  respondJson(req2, verifyResult(1, "h2", 5));   // 第二次先返回
  await p2; await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 5);
  respondJson(req1, verifyResult(1, "h2", 99));  // 第一次迟到
  await p1; await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 5,
                     "迟到响应不得覆盖最近一次上传的结果");
  console.log("frontend concurrent uploads: last response wins ok");
}

async function test_switch_project_discards_inflight() {
  // 上传未完成时切换项目：迟到响应不得落到新项目
  clearVerifyState();
  state.project = proj(1, "h2");
  const fileC = makeDeliveryFile("C");
  deliveryForm.delivery.files = [fileC];
  const { promise: p } = await prepareDelivery(fileC);
  const req = popPending("verify-delivery");
  app.resetDeliveryVerify();          // 切换项目的前置清理（在途失效）
  state.project = proj(2, "k1");
  respondJson(req, verifyResult(1, "h2", 7));
  await p; await flush();
  assert.strictEqual(state.deliveryVerify, null,
                     "切换项目后迟到响应必须丢弃");
  console.log("frontend switch project discards in-flight response ok");
}

async function test_cleared_input_uses_committed_snapshot() {
  // 先得到项目 2 的有效结果
  clearVerifyState();
  state.project = proj(2, "k1");
  const fileD = makeDeliveryFile("D");
  deliveryForm.delivery.files = [fileD];
  const { promise: p } = await prepareDelivery(fileD);
  respondJson(popPending("verify-delivery"), verifyResult(2, "k1", 3));
  await p; await flush();
  assert.ok(state.deliveryVerify);
  assert.strictEqual(state.deliverySnapshot.name, "D.srt");
  // 文件输入已清空（或随后只改选乙未提交），不影响最近一次已提交的甲稿；
  // 生效轴变化后仍自动用甲稿快照重核。
  deliveryForm.delivery.files = [];
  const before = verifyPostCount();
  state.project = proj(2, "k2");
  app.render();
  assert.strictEqual(state.deliveryVerify, null, "旧结论必须作废");
  assert.strictEqual(verifyPostCount(), before + 1, "应使用已提交快照自动重核");
  const req = popPending("verify-delivery");
  assert.strictEqual(req.opts.body.parts[0][2], "D.srt",
                     "自动重核不得读取文件框中未提交的乙稿");
  respondJson(req, verifyResult(2, "k2", 2));
  await flush();
  assert.strictEqual(state.deliveryVerify.timeline_hash, "k2");
  console.log("frontend cleared input still uses committed snapshot ok");
}

async function test_uncommitted_selection_never_replaces_snapshot() {
  // 甲提交后，只在文件框改选乙、不点击提交；生效轴变化必须继续核验甲。
  clearVerifyState();
  state.project = proj(3, "m1");
  const fileA2 = makeDeliveryFile("A-committed");
  deliveryForm.delivery.files = [fileA2];
  const { promise: p } = await prepareDelivery(fileA2);
  respondJson(popPending("verify-delivery"), verifyResult(3, "m1", 3));
  await p; await flush();

  deliveryForm.delivery.files = [makeDeliveryFile("B-uncommitted")];
  const before = verifyPostCount();
  state.project = proj(3, "m2");
  app.render();
  assert.strictEqual(verifyPostCount(), before + 1, "应自动重核");
  const req = popPending("verify-delivery");
  assert.strictEqual(req.opts.body.parts[0][2], "A-committed.srt",
                     "未提交改选稿不得用于自动重核");
  assert.strictEqual(state.deliverySnapshot.name, "A-committed.srt");
  respondJson(req, verifyResult(3, "m2", 1));
  await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 1);

  // 乙提交后，才成为新的稿件切换边界；以后自动重核使用乙。
  const fileB = makeDeliveryFile("B-committed");
  deliveryForm.delivery.files = [fileB];
  const { promise: p2 } = await prepareDelivery(fileB);
  const reqB = popPending("verify-delivery");
  assert.strictEqual(reqB.opts.body.parts[0][2], "B-committed.srt");
  respondJson(reqB, verifyResult(3, "m2", 2));
  await p2; await flush();
  state.project = proj(3, "m3");
  app.render();
  const reqB2 = popPending("verify-delivery");
  assert.strictEqual(reqB2.opts.body.parts[0][2], "B-committed.srt",
                     "乙提交后才允许取代甲");
  respondJson(reqB2, verifyResult(3, "m3", 4));
  await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 4);
  console.log("frontend uncommitted selection never replaces snapshot ok");
}

async function test_unreadable_new_submission_keeps_committed_snapshot() {
  // 乙提交时浏览器都无法读取：乙不能取代甲；旧结论与甲快照继续保留，
  // 后续变轴仍使用甲自动重核。
  clearVerifyState();
  state.project = proj(11, "v1");
  const fileA = makeDeliveryFile("valid-A");
  deliveryForm.delivery.files = [fileA];
  let { promise: p } = await prepareDelivery(fileA);
  respondJson(popPending("verify-delivery"), verifyResult(11, "v1", 8));
  await p; await flush();
  const oldResult = state.deliveryVerify;
  const postCount = verifyPostCount();

  const badFile = makeUnreadableDeliveryFile("unreadable-B");
  deliveryForm.delivery.files = [badFile];
  p = app.submitDeliveryVerify(badFile);
  await flush();
  await p;
  assert.strictEqual(state.deliveryVerify, oldResult, "读取失败应保留甲结论");
  assert.strictEqual(state.deliverySnapshot.name, "valid-A.srt",
                     "读取失败的乙不得替换甲快照");
  assert.strictEqual(verifyPostCount(), postCount, "读取失败不发起核验请求");

  state.project = proj(11, "v2");
  app.render();
  const req = popPending("verify-delivery");
  assert.strictEqual(req.opts.body.parts[0][2], "valid-A.srt");
  respondJson(req, verifyResult(11, "v2", 7));
  await flush();
  assert.strictEqual(state.deliveryVerify.timeline_hash, "v2");
  console.log("frontend unreadable new submission keeps committed A ok");
}

async function test_failed_new_submission_during_axis_change_rechecks_old_snapshot() {
  // 乙已能读取并发出请求，但服务端在新轴上拒绝乙；乙未形成有效结论，
  // 应回到甲快照按新轴重核，而不是清空甲。
  clearVerifyState();
  state.project = proj(12, "w1");
  const fileA = makeDeliveryFile("old-A");
  deliveryForm.delivery.files = [fileA];
  let { promise: p } = await prepareDelivery(fileA);
  respondJson(popPending("verify-delivery"), verifyResult(12, "w1", 2));
  await p; await flush();

  const fileB = makeDeliveryFile("rejected-B");
  deliveryForm.delivery.files = [fileB];
  ({ promise: p } = await prepareDelivery(fileB));
  const badReq = popPending("verify-delivery");
  assert.strictEqual(badReq.opts.body.parts[0][2], "rejected-B.srt");
  state.project = proj(12, "w2");
  const before = verifyPostCount();
  respondJson(badReq, { detail: "交付字幕解析失败：bad" }, false, 400);
  await flush();
  assert.strictEqual(verifyPostCount(), before + 1,
                     "乙失败后应自动改用甲按新轴重核");
  const oldReq = popPending("verify-delivery");
  assert.strictEqual(oldReq.opts.body.parts[0][2], "old-A.srt");
  respondJson(oldReq, verifyResult(12, "w2", 1));
  await p; await flush();
  assert.strictEqual(state.deliveryVerify.summary.pass, 1);
  assert.strictEqual(state.deliverySnapshot.name, "old-A.srt");
  console.log("frontend failed new submission rechecks previous snapshot ok");
}

async function test_stale_on_arrival_reverified() {
  // 响应等待期间另一标签页改了参数（本地已刷新到 k3）：
  // 按旧轴 k2 算出的结果到达即过期 → 先拉取最新详情（仍为 k3）裁决，
  // 结论不可接纳 → 自动用已选稿按新轴重核，不展示过期结果
  clearVerifyState();
  state.project = proj(2, "k2");
  const fileE = makeDeliveryFile("E");
  deliveryForm.delivery.files = [fileE];
  const { promise: p } = await prepareDelivery(fileE);
  const req = popPending("verify-delivery");
  state.project = proj(2, "k3");      // 生效轴在等待期间变化
  const before = verifyPostCount();
  respondJson(req, verifyResult(2, "k2", 4));
  await flush();
  respondJson(popPendingExact("/api/projects/2"), proj(2, "k3"));  // 详情仍 k3
  await flush();
  assert.strictEqual(verifyPostCount(), before + 1,
                     "到达即过期应自动按新生效轴重核");
  assert.ok(!state.deliveryVerify ||
            state.deliveryVerify.timeline_hash === "k3",
            "过期结果不得展示");
  respondJson(popPending("verify-delivery"), verifyResult(2, "k3", 4));
  await p; await flush();
  assert.strictEqual(state.deliveryVerify.timeline_hash, "k3");
  console.log("frontend stale-on-arrival discarded + re-verified ok");
}

async function test_auto_reverify_failure_asks_reupload() {
  // 自动重核失败（如回传稿解析失败）：作废旧结论，提示人工重传
  clearVerifyState();
  state.project = proj(2, "k3");
  const fileF = makeDeliveryFile("F");
  deliveryForm.delivery.files = [fileF];
  const { promise: p } = await prepareDelivery(fileF);
  respondJson(popPending("verify-delivery"), verifyResult(2, "k3", 2));
  await p; await flush();
  assert.ok(state.deliveryVerify);
  state.project = proj(2, "k4");
  app.render();                        // 触发自动重核
  respondJson(popPending("verify-delivery"),
              { detail: "交付字幕解析失败：bad" }, false, 400);
  await flush();
  assert.strictEqual(state.deliveryVerify, null, "失败后不得保留旧结论");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend auto re-verify failure -> ask re-upload ok");
}

async function test_cross_tab_change_accepted_after_detail_refresh() {
  // 核心回归（循环请求修复）：另一标签页改了最小间隔，本页详情仍旧（c1）。
  // 核验响应携带新指纹 c2——旧实现会判过期并无界自动重核且永无结论；
  // 修复后应先拉取最新详情（c2），结论按新详情可接纳：直接展示、
  // 页面详情同步到最新，且不再发起任何重核请求。
  clearVerifyState();
  state.project = proj(7, "c1");               // 本页详情过期
  const fileX = makeDeliveryFile("X");
  deliveryForm.delivery.files = [fileX];
  const base = verifyPostCount();
  const { promise: p } = await prepareDelivery(fileX);
  respondJson(popPending("verify-delivery"), verifyResult(7, "c2", 4));
  await flush();
  respondJson(popPendingExact("/api/projects/7"), proj(7, "c2"));  // 最新详情
  await p; await flush();
  assert.strictEqual(verifyPostCount(), base + 1,
                     "结论可按新详情接纳时不得重复发起核验（无循环请求）");
  assert.ok(state.deliveryVerify, "按新详情有效的结论应展示");
  assert.strictEqual(state.deliveryVerify.timeline_hash, "c2");
  assert.strictEqual(state.deliveryVerify.summary.pass, 4);
  assert.strictEqual(state.project.timeline_hash, "c2",
                     "页面详情应同步到最新");
  console.log("frontend cross-tab change accepted after detail refresh ok");
}

async function test_repeated_timeline_changes_stop_reverify() {
  // 多次变轴：每次响应到达时生效轴都已再次变化（详情也一路变化），
  // 自动重核必须有终止条件——达到上限后停止、作废旧结论并提示重传，
  // 不无界发请求。
  clearVerifyState();
  state.project = proj(4, "r1");
  const fileR = makeDeliveryFile("R");
  deliveryForm.delivery.files = [fileR];
  const base = verifyPostCount();
  const { promise: p } = await prepareDelivery(fileR);        // 第 1 次核验
  respondJson(popPending("verify-delivery"), verifyResult(4, "r2", 1));
  await flush();
  respondJson(popPendingExact("/api/projects/4"), proj(4, "r3"));
  await flush();                                          // 仍不符 → 第 2 次
  respondJson(popPending("verify-delivery"), verifyResult(4, "r4", 1));
  await flush();
  respondJson(popPendingExact("/api/projects/4"), proj(4, "r5"));
  await flush();                                          // 仍不符 → 第 3 次
  respondJson(popPending("verify-delivery"), verifyResult(4, "r6", 1));
  await flush();
  respondJson(popPendingExact("/api/projects/4"), proj(4, "r7"));
  await p; await flush();                                 // 达到上限 → 停止
  assert.strictEqual(verifyPostCount(), base + 3,
                     "自动重核链必须有终止条件（最多 3 次核验请求）");
  assert.strictEqual(state.deliveryVerify, null,
                     "达到上限后不得显示旧结论");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend repeated timeline changes -> bounded stop ok");
}

async function test_detail_refresh_failure_stops() {
  // 详情刷新失败（如项目已被删除/网络错误）：停止并提示重传，
  // 不显示旧结论，也不再发核验请求
  clearVerifyState();
  state.project = proj(5, "f1");
  const fileDetail = makeDeliveryFile("Detail");
  deliveryForm.delivery.files = [fileDetail];
  const base = verifyPostCount();
  const { promise: p } = await prepareDelivery(fileDetail);
  respondJson(popPending("verify-delivery"), verifyResult(5, "f2", 1));
  await flush();
  respondJson(popPendingExact("/api/projects/5"),
              { detail: "项目不存在" }, false, 404);
  await p; await flush();
  assert.strictEqual(verifyPostCount(), base + 1,
                     "详情刷新失败不得继续重核");
  assert.strictEqual(state.deliveryVerify, null, "不得显示旧结论");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend detail refresh failure -> stop + ask re-upload ok");
}

async function test_unreadable_snapshot_during_reconcile_stops() {
  // 等待详情期间快照变成不可读：生效轴仍不符时不得自动重核，提示重传
  clearVerifyState();
  state.project = proj(6, "n1");
  const fileN = makeDeliveryFile("N");
  deliveryForm.delivery.files = [fileN];
  const base = verifyPostCount();
  const { promise: p } = await prepareDelivery(fileN);
  respondJson(popPending("verify-delivery"), verifyResult(6, "n2", 1));
  await flush();
  state.deliverySnapshot.bytes = null;
  state.deliverySnapshot.size = 0;
  respondJson(popPendingExact("/api/projects/6"), proj(6, "n3"));
  await p; await flush();
  assert.strictEqual(verifyPostCount(), base + 1,
                     "快照不可读不得继续重核");
  assert.strictEqual(state.deliveryVerify, null, "不得显示旧结论");
  assert.ok(state.verifyNotice.includes("重新上传"), "应提示重新上传");
  console.log("frontend unreadable snapshot during reconcile -> stop ok");
}

async function test_reconcile_discards_after_project_switch() {
  // 详情刷新在途时切换项目：迟到的详情响应不得落到新项目
  clearVerifyState();
  state.project = proj(8, "s1");
  const fileS = makeDeliveryFile("S");
  deliveryForm.delivery.files = [fileS];
  const { promise: p } = await prepareDelivery(fileS);
  respondJson(popPending("verify-delivery"), verifyResult(8, "s2", 1));
  await flush();
  const getReq = popPendingExact("/api/projects/8");
  app.resetDeliveryVerify();                  // 切换项目的前置清理（在途失效）
  state.project = proj(9, "t1");
  respondJson(getReq, proj(8, "s3"));         // 旧项目的详情迟到
  await p; await flush();
  assert.strictEqual(state.deliveryVerify, null,
                     "切换项目后迟到详情必须丢弃");
  assert.strictEqual(state.project.id, 9);
  assert.strictEqual(state.project.timeline_hash, "t1",
                     "新项目详情不得被旧响应覆盖");
  console.log("frontend reconcile discarded after project switch ok");
}

async function test_reconcile_discards_when_newer_upload() {
  // 详情刷新在途时再次上传：旧链一律丢弃，只呈现最近一次上传的结果
  clearVerifyState();
  state.project = proj(10, "u1");
  const fileU = makeDeliveryFile("U");
  deliveryForm.delivery.files = [fileU];
  const { promise: p1 } = await prepareDelivery(fileU);
  respondJson(popPending("verify-delivery"), verifyResult(10, "u2", 1));
  await flush();
  const getReq = popPendingExact("/api/projects/10");
  const fileU2 = makeDeliveryFile("U2");
  deliveryForm.delivery.files = [fileU2];
  const { promise: p2 } = await prepareDelivery(fileU2);  // 再次提交（更新提交序号）
  respondJson(getReq, proj(10, "u3"));                // 旧链的详情迟到
  await p1; await flush();
  assert.strictEqual(state.deliveryVerify, null, "旧链不得展示结论");
  // 第二次上传的响应 u3 与本地 u1 不符 → 再经一次详情同步后接纳
  respondJson(popPending("verify-delivery"), verifyResult(10, "u3", 6));
  await flush();
  respondJson(popPendingExact("/api/projects/10"), proj(10, "u3"));
  await p2; await flush();
  assert.ok(state.deliveryVerify, "最近一次上传的结果应展示");
  assert.strictEqual(state.deliveryVerify.summary.pass, 6);
  assert.strictEqual(state.deliveryVerify.timeline_hash, "u3");
  console.log("frontend reconcile discarded when newer upload ok");
}

async function main() {
  await test_manual_upload_binds_result();
  await test_timeline_change_auto_reverify();
  await test_timeline_unchanged_keeps_result();
  await test_concurrent_uploads_last_wins();
  await test_switch_project_discards_inflight();
  await test_cleared_input_uses_committed_snapshot();
  await test_uncommitted_selection_never_replaces_snapshot();
  await test_unreadable_new_submission_keeps_committed_snapshot();
  await test_failed_new_submission_during_axis_change_rechecks_old_snapshot();
  await test_stale_on_arrival_reverified();
  await test_auto_reverify_failure_asks_reupload();
  await test_cross_tab_change_accepted_after_detail_refresh();
  await test_repeated_timeline_changes_stop_reverify();
  await test_detail_refresh_failure_stops();
  await test_unreadable_snapshot_during_reconcile_stops();
  await test_reconcile_discards_after_project_switch();
  await test_reconcile_discards_when_newer_upload();
  console.log("frontend delivery verify binding regression ok");
}

main().catch((e) => { console.error(e); process.exit(1); });
