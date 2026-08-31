/* =========================================================
   哲恒排班登记 - 多设备云同步（GitHub Gist）
   ---------------------------------------------------------
   原理：排班数据保存为你 GitHub 账号里的一个"私有 Gist"
   （相当于你自己的免费云端小硬盘）。

   - 每台设备在 设置 → 多设备同步 里粘贴一次 Token 即可绑定
   - 绑定后自动同步：
       · 打开应用时拉取云端最新数据
       · 任何修改 3 秒后自动推送到云端
       · 切回前台 / 每 1 分钟自动拉取
       · 断网恢复后自动重试
   - 合并规则：每条记录"谁最后修改听谁的"，删除操作也会同步
   - Token 只保存在本机浏览器，只授予 gist（便签）权限

   注意：手机上若 GitHub 打不开（需代理），同步会等待网络
   恢复后自动继续，本机数据不受影响。
   ========================================================= */

const GIST_API  = 'https://api.github.com';
const GIST_MARK = 'schedule-app-sync';       // Gist 描述里的识别标记
const GIST_FILE = 'schedule-data.json';      // Gist 内的数据文件名
const LZ_MARK   = 'LZ4:';                    // 压缩数据前缀（LZ-String Base64）

const SYNC_TOKEN_KEY = 'schedule.syncToken';
const SYNC_GIST_KEY  = 'schedule.syncGistId';
const SYNC_LAST_KEY  = 'schedule.syncLastAt';

let syncToken   = localStorage.getItem(SYNC_TOKEN_KEY) || '';
let syncGistId  = localStorage.getItem(SYNC_GIST_KEY) || '';
let syncLastAt  = Number(localStorage.getItem(SYNC_LAST_KEY) || 0);
let syncState   = 'idle';    // idle | busy | ok | error
let syncError   = '';        // 错误详情（设置面板里显示）
let syncPending = false;    // 本地有改动还没推送到云端
let lastPullAt  = 0;        // 上次拉取时间（前台切换限流用）
let pushTimer   = null;
let queue       = Promise.resolve(); // 串行化所有同步动作，避免并发

/* ---------- 内部：GitHub Gist API ---------- */

async function gistApi(method, path, body) {
  const resp = await fetch(GIST_API + path, {
    method: method,
    headers: {
      'Authorization': 'Bearer ' + syncToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!resp.ok) {
    const e = new Error('GitHub ' + resp.status);
    e.status = resp.status;
    throw e;
  }
  return resp.status === 204 ? null : resp.json();
}

/* ---------- 内部：数据打包 / 合并 ---------- */

// 推送到云端的完整数据快照（只挑有效字段，自动去掉运行期临时属性）
function buildPayload() {
  return {
    app: 'schedule-app-sync',
    version: 1,
    savedAt: Date.now(),
    settings: {
      singer: settings.singer,
      year: settings.year,
      stores: settings.stores,
      timeSlots: settings.timeSlots,
      _savedAt: settings._savedAt || 0
    },
    shifts: shifts.map(s => ({
      id: s.id,
      date: s.date,
      slot: s.slot,
      store: s.store,
      time: s.time || '',
      note: s.note || '',
      deleted: !!s.deleted,
      updatedAt: s.updatedAt || 0
    })),
    // 演出记录：只同步文字部分（歌单/备注/照片数量标记），照片本体留本机
    records: buildRecordsPayload()
  };
}

// 演出记录打包：剥离 photoIds（照片仅本机），photoCount 记录本机真实张数
function buildRecordsPayload() {
  const out = {};
  Object.keys(records).forEach(date => {
    const day = records[date];
    if (!day || typeof day !== 'object') return;
    Object.keys(day).forEach(slot => {
      const r = day[slot];
      if (!r) return;
      if (!out[date]) out[date] = {};
      out[date][slot] = {
        songs: Array.isArray(r.songs) ? r.songs : [],
        note: r.note || '',
        photoCount: (r.photoIds && r.photoIds.length) || 0,
        deleted: !!r.deleted,
        updatedAt: r.updatedAt || 0
      };
    });
  });
  return out;
}

/* ---------- 内部：云端内容压缩（缓解 Gist 单文件 1MB 上限） ---------- */

const hasLZ = () => typeof LZString !== 'undefined' && typeof LZString.compressToBase64 === 'function';

// 全量数据 → 云端文件内容：优先 LZ-String Base64 压缩（等效空间放大 5-10 倍），
// 压缩失败或库缺失时退回明文 JSON，保证永不阻塞同步
function encodePayload() {
  const raw = JSON.stringify(buildPayload());
  if (!hasLZ()) return raw;
  try {
    return LZ_MARK + LZString.compressToBase64(raw);
  } catch (e) {
    return raw;
  }
}

// 云端文件内容 → 明文 JSON 字符串：识别 LZ4: 前缀自动解压；
// 兼容老版本明文数据；解压结果须通过 JSON 校验（防损坏数据吐出垃圾串），
// 失败时按明文返回，后续推送会覆盖修复
function decodeContent(content) {
  if (!content) return '';
  if (content.indexOf(LZ_MARK) === 0 && hasLZ()) {
    try {
      const dec = LZString.decompressFromBase64(content.slice(LZ_MARK.length));
      if (dec) {
        JSON.parse(dec); // 校验：损坏的压缩串可能解出非 JSON 垃圾
        return dec;
      }
    } catch (e) { /* 解压/校验失败 → 按明文处理 */ }
  }
  return content;
}

// 把云端数据合并进本地。返回 true 表示本地数据发生了变化。
// 规则：
//   1) 按记录 id 合并，修改时间(updatedAt)新的胜出
//   2) 同"日期+场次"只保留最新一条（兼容不同时期导入的种子数据）
//   3) 已删除(墓碑)记录参与合并，删除会传播到所有设备；超过 60 天自动清理
//   4) 设置（歌手/年份/门店/时间段）整体按保存时间新的胜出
function mergeRemoteData(remote) {
  if (!remote || typeof remote !== 'object') return false;
  let changed = false;

  // 1) 按合并并
  const remoteShifts = Array.isArray(remote.shifts) ? remote.shifts : [];
  const byId = new Map();
  shifts.forEach(s => { if (s && s.id) byId.set(s.id, s); });
  remoteShifts.forEach(rs => {
    if (!rs || !rs.id || !rs.date) return;
    const cur = byId.get(rs.id);
    if (!cur) {
      byId.set(rs.id, rs);
    } else if ((rs.updatedAt || 0) > (cur.updatedAt || 0)) {
      byId.set(rs.id, rs);
    }
  });

  // 2) 同"日期+场次"去重，保留 updatedAt 最新的；相同时按 id 排序定胜负（保证各设备结果一致）
  const byKey = new Map();
  byId.forEach(s => {
    const key = s.date + '#' + s.slot;
    const cur = byKey.get(key);
    if (!cur) { byKey.set(key, s); return; }
    const a = s.updatedAt || 0, b = cur.updatedAt || 0;
    if (a > b || (a === b && s.id < cur.id)) byKey.set(key, s);
  });

  // 3) 清理 60 天前的墓碑
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  const merged = [];
  byKey.forEach(s => {
    if (s.deleted && (s.updatedAt || 0) < cutoff) return;
    merged.push(s);
  });

  // 内容对比（排序后比较，字段归一化）
  const norm = s => JSON.stringify([s.id, s.date, s.slot, s.store, s.time || '', s.note || '', !!s.deleted, s.updatedAt || 0]);
  const sigBefore = JSON.stringify(shifts.map(norm).sort());
  const sigAfter  = JSON.stringify(merged.map(norm).sort());
  if (sigBefore !== sigAfter) changed = true;

  // 4) 设置合并：保存时间新的胜出
  let settingsChanged = false;
  const rs = remote.settings;
  if (rs && (rs._savedAt || 0) > (settings._savedAt || 0)) {
    if (rs.singer) settings.singer = rs.singer;
    if (rs.year) settings.year = rs.year;
    if (Array.isArray(rs.stores) && rs.stores.length) settings.stores = rs.stores;
    if (Array.isArray(rs.timeSlots) && rs.timeSlots.length) settings.timeSlots = rs.timeSlots;
    settings._savedAt = rs._savedAt;
    settingsChanged = true;
  }

  // 5) 演出记录合并：文字部分（歌单/备注）按 updatedAt 新者胜出；
  //    photoIds 始终保留本机（照片本体不同步），云端只取 photoCount 标记；
  //    云端墓碑 → 本机记录同步删除（本机照片一并清理）
  const recordsChanged = mergeRemoteRecords(remote.records);

  if (changed || settingsChanged || recordsChanged) {
    window.__syncApplying = true; // 静默保存，不触发推送
    try {
      shifts = merged;
      saveShifts();
      if (settingsChanged) saveSettings();
      if (recordsChanged) saveRecords();
    } finally {
      window.__syncApplying = false;
    }
    renderAll();
    toast('已从云端同步最新数据 ✓');
  }
  return changed || settingsChanged || recordsChanged;
}

// 演出记录合并（返回 true 表示本地记录发生变化）
function mergeRemoteRecords(remoteRecords) {
  if (!remoteRecords || typeof remoteRecords !== 'object') return false;
  const sigBefore = JSON.stringify(records);
  let localChanged = false;

  Object.keys(remoteRecords).forEach(date => {
    const day = remoteRecords[date];
    if (!day || typeof day !== 'object') return;
    Object.keys(day).forEach(slotStr => {
      const rr = day[slotStr];
      if (!rr) return;
      const slot = Number(slotStr);
      if (!slot) return;

      const local = records[date] && records[date][slot];
      if (!local) {
        // 本机没有 → 直接采用云端记录（本机无照片）
        if (!records[date]) records[date] = {};
        records[date][slot] = {
          songs: Array.isArray(rr.songs) ? rr.songs : [],
          note: rr.note || '',
          photoIds: [],
          photoCount: rr.photoCount || 0,
          deleted: !!rr.deleted,
          updatedAt: rr.updatedAt || 0
        };
        localChanged = true;
      } else if ((rr.updatedAt || 0) > (local.updatedAt || 0)) {
        // 云端较新 → 采用云端的文字部分；photoIds 保留本机
        local.songs = Array.isArray(rr.songs) ? rr.songs : [];
        local.note = rr.note || '';
        local.photoCount = rr.photoCount || 0;
        local.deleted = !!rr.deleted;
        local.updatedAt = rr.updatedAt || 0;
        localChanged = true;

        // 云端删除（墓碑）→ 本机照片也清理
        if (local.deleted && local.photoIds && local.photoIds.length) {
          local.photoIds.forEach(id => { PhotoDB.remove(id).catch(() => {}); });
          local.photoIds = [];
        }
      }
    });
  });

  // 60 天前的已删除记录 → 彻底清理
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  Object.keys(records).forEach(date => {
    Object.keys(records[date]).forEach(slot => {
      const r = records[date][slot];
      if (r && r.deleted && (r.updatedAt || 0) < cutoff) delete records[date][slot];
    });
    if (!Object.keys(records[date]).length) delete records[date];
  });

  return localChanged || JSON.stringify(records) !== sigBefore;
}

/* ---------- 内部：拉取 / 推送 / 状态 ---------- */

async function doPull() {
  if (!syncGistId) throw new Error('未绑定');
  let gist;
  try {
    gist = await gistApi('GET', '/gists/' + syncGistId);
  } catch (e) {
    if (e.status === 404) {
      // 云端 Gist 被手动删除了 → 用本地数据重建
      const created = await gistApi('POST', '/gists', {
        description: GIST_MARK + '-' + settings.singer,
        public: false,
        files: { [GIST_FILE]: { content: encodePayload() } }
      });
      syncGistId = created.id;
      localStorage.setItem(SYNC_GIST_KEY, syncGistId);
      return;
    }
    throw e;
  }
  lastPullAt = Date.now();

  const file = gist.files && gist.files[GIST_FILE];
  if (!file || !file.content) return; // 空的 → 等推送补上
  let content = file.content;
  if (file.truncated && file.raw_url) {
    const r = await fetch(file.raw_url, {
      headers: { 'Authorization': 'Bearer ' + syncToken }
    });
    content = await r.text();
  }
  content = decodeContent(content); // 识别 LZ4: 压缩前缀自动解压（兼容明文老数据）
  let remote = null;
  try { remote = JSON.parse(content); } catch (e) { /* 数据损坏 → 忽略，推送时会覆盖修复 */ }
  if (remote) mergeRemoteData(remote);
}

async function doPush() {
  if (!syncGistId) throw new Error('未绑定');
  await gistApi('PATCH', '/gists/' + syncGistId, {
    description: GIST_MARK + '-' + settings.singer,
    files: { [GIST_FILE]: { content: encodePayload() } }
  });
}

function markSyncOk() {
  syncState = 'ok';
  syncError = '';
  syncPending = false;
  syncLastAt = Date.now();
  localStorage.setItem(SYNC_LAST_KEY, String(syncLastAt));
}

function handleSyncError(e) {
  syncState = 'error';
  if (e && e.status === 401)      syncError = 'Token 已失效，请解绑后重新绑定';
  else if (e && e.status === 403) syncError = '操作太频繁，稍后会自动重试';
  else if (e && e.status === 404) syncError = '云端数据不存在，下次同步将自动重建';
  else                            syncError = '网络不通（手机上可能需要开代理）';
}

// 完整同步 = 拉取合并 → 推送（排队串行执行，避免并发写云端）
function syncNow() {
  if (!syncToken) return Promise.resolve();
  queue = queue.then(async () => {
    syncState = 'busy';
    refreshStatusUI();
    try {
      await doPull();
      await doPush();
      markSyncOk();
    } catch (e) {
      handleSyncError(e);
    }
    refreshStatusUI();
  });
  return queue;
}

function schedulePush() {
  clearTimeout(pushTimer);
  // 防抖 3 秒：连续修改只推送最后一次
  pushTimer = setTimeout(() => { syncNow(); }, 3000);
}

// 状态变化后刷新顶部状态栏 + 设置面板
function refreshStatusUI() {
  try { renderHeader(); } catch (e) { /* 页面还没就绪时忽略 */ }
  renderSyncUI();
}

function fmtTime(t) {
  if (!t) return '--:--';
  const d = new Date(t);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/* ---------- 设置面板 UI ---------- */

function renderSyncUI() {
  const box = document.getElementById('syncBox');
  if (!box) return;
  box.innerHTML = '';

  if (!syncToken) {
    // —— 未绑定：输入 Token ——
    // 上次绑定失败时保留错误提示，用户能看清原因
    if (syncError) {
      const errLine = document.createElement('div');
      errLine.className = 'sync-state err';
      errLine.textContent = '⚠ ' + syncError;
      box.appendChild(errLine);
    }
    const row = document.createElement('div');
    row.className = 'sync-row';
    const input = document.createElement('input');
    input.type = 'password';
    input.id = 'syncTokenInput';
    input.placeholder = '粘贴 GitHub Token（需 gist 权限）';
    input.autocomplete = 'off';
    row.appendChild(input);
    const btn = document.createElement('button');
    btn.className = 'mini-btn';
    btn.textContent = '绑定';
    btn.addEventListener('click', () => {
      bindToken(document.getElementById('syncTokenInput').value);
    });
    row.appendChild(btn);
    box.appendChild(row);

    const help = document.createElement('div');
    help.className = 'sync-help';
    help.innerHTML =
      '手机电脑<b>各绑定一次</b>，排班数据自动互通。' +
      '<a href="https://github.com/settings/tokens/new?scopes=gist&description=排班数据同步" target="_blank" rel="noopener">点此创建 Token</a>：' +
      '页面里直接点底部绿色按钮 → 复制生成的一串字符粘贴到左边。';
    box.appendChild(help);
    return;
  }

  // —— 已绑定：状态 + 操作 ——
  const state = document.createElement('div');
  state.className = 'sync-state ' + (syncState === 'error' ? 'err' : syncState === 'ok' ? 'ok' : '');
  if (syncState === 'busy')       state.textContent = '⟳ 正在同步…';
  else if (syncState === 'error') state.textContent = '⚠ ' + syncError;
  else if (syncPending)           state.textContent = '⏳ 有改动待同步';
  else                            state.textContent = '✓ 已同步 ' + fmtTime(syncLastAt);
  box.appendChild(state);

  const row = document.createElement('div');
  row.className = 'sync-row';
  const nowBtn = document.createElement('button');
  nowBtn.className = 'mini-btn';
  nowBtn.textContent = '立即同步';
  nowBtn.addEventListener('click', () => {
    if (syncState === 'busy') return;
    syncNow();
    toast('正在同步…');
  });
  row.appendChild(nowBtn);
  const unBtn = document.createElement('button');
  unBtn.className = 'mini-btn sync-unbind';
  unBtn.textContent = '解绑';
  unBtn.addEventListener('click', unbind);
  row.appendChild(unBtn);
  box.appendChild(row);

  const help = document.createElement('div');
  help.className = 'sync-help';
  help.textContent = '数据保存在你自己的 GitHub（私有）· 每台设备都要绑定 · 断网时改动先存本机，联网自动补同步';
  box.appendChild(help);
}

async function bindToken(token) {
  token = (token || '').trim();
  if (!token) { toast('请先粘贴 Token'); return; }
  if (syncState === 'busy') return;

  syncError = '';  // 清除上次错误提示
  syncToken = token; // 先临时设上用于验证
  syncState = 'busy';
  renderSyncUI();

  try {
    // 验证 Token 并查找是否已有同步 Gist（第二台设备直接复用）
    const gists = await gistApi('GET', '/gists?per_page=100');
    const found = (Array.isArray(gists) ? gists : []).find(g =>
      g && g.description && g.description.indexOf(GIST_MARK) >= 0
    );
    if (found) {
      syncGistId = found.id;
      localStorage.setItem(SYNC_GIST_KEY, syncGistId);
      localStorage.setItem(SYNC_TOKEN_KEY, syncToken);
      await syncNow(); // 拉取云端数据合并到本机
      toast('绑定成功，已同步云端数据 ✓');
    } else {
      // 第一台设备：创建云端备份
      const created = await gistApi('POST', '/gists', {
        description: GIST_MARK + '-' + settings.singer,
        public: false,
        files: { [GIST_FILE]: { content: encodePayload() } }
      });
      syncGistId = created.id;
      localStorage.setItem(SYNC_GIST_KEY, syncGistId);
      localStorage.setItem(SYNC_TOKEN_KEY, syncToken);
      markSyncOk();
      toast('绑定成功，云端备份已创建 ✓');
    }
  } catch (e) {
    // 失败 → 回滚
    syncToken = '';
    handleSyncError(e);
    if (e && e.status === 401) syncError = 'Token 无效，请确认复制完整（只有 gist 权限即可）';
    toast('绑定失败，请检查 Token 和网络');
  }
  refreshStatusUI();
}

function unbind() {
  syncToken = '';
  syncGistId = '';
  syncLastAt = 0;
  syncState = 'idle';
  syncError = '';
  syncPending = false;
  localStorage.removeItem(SYNC_TOKEN_KEY);
  localStorage.removeItem(SYNC_GIST_KEY);
  localStorage.removeItem(SYNC_LAST_KEY);
  clearTimeout(pushTimer);
  renderSyncUI();
  renderHeader();
  toast('已解绑，数据仍保存在本机');
}

/* ---------- 对外接口 ---------- */

const Sync = {
  // 本地数据有修改（由 app.js 的 saveShifts / saveSettings 调用）
  markPending() {
    if (!syncToken) return;
    syncPending = true;
    renderHeader(); // 顶部状态栏改为「待同步」
    schedulePush();
  },

  // 顶部状态栏文字
  statusText() {
    if (!syncToken) return '数据保存在本机';
    if (syncState === 'busy') return '同步中…';
    if (syncState === 'error') return '⚠️ 同步失败';
    if (syncPending) return '⏳ 待同步';
    return '🔄 已同步 ' + fmtTime(syncLastAt);
  },

  renderSyncUI,

  // 应用启动时调用（sync.js 在 app.js 之后加载，此时页面已渲染完成）
  start() {
    renderSyncUI();
    renderHeader();

    // 每 1 分钟自动拉取（绑定与否都注册，回调里再判断）
    // 说明：Gist API 限速 5000 次/小时，1 分钟一次两台设备也远未触及；
    // 缩短间隔让"页面一直开着"也能很快看到另一台设备的修改
    setInterval(() => {
      if (!document.hidden && syncToken) syncNow();
    }, 60 * 1000);

    // 切回前台时拉取（至少间隔 60 秒，避免频繁切换）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && syncToken && Date.now() - lastPullAt > 60 * 1000) {
        syncNow();
      }
    });

    // 网络恢复后自动重试
    window.addEventListener('online', () => {
      if (syncToken && (syncPending || syncState === 'error')) syncNow();
    });

    // 已绑定 → 启动立即同步一次
    if (syncToken) syncNow();
  }
};

window.Sync = Sync;

// 自启动：本文件在 app.js 之后加载，执行到这里时页面已就绪
Sync.start();
