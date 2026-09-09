/* =========================================================
   哲恒 排班登记 - 核心逻辑
   参照《哲恒排班登记模版（日期列）.xlsx》设计：
   - 12 个月循环查看，每年一个周期
   - 每天最多 3 场（场次 1/2/3）
   - 每场登记：门店 + 时间段 + 备注
   - 右侧自动统计：总场次及各门店场次
   数据保存在浏览器本地 (localStorage)
   ========================================================= */

/* ---------- 1. 数据 ---------- */

// 默认设置（对应模板"使用说明"里的下拉值）
const DEFAULT_SETTINGS = {
  singer: '哲恒',
  year: 2026,
  stores: ['仓山万达店', '宝龙广场店', '烟台山店', '外滩店'],
  timeSlots: [
    '21:00-21:40', '21:30-22:10', '22:00-22:40', '22:30-23:10',
    '23:00-23:40', '23:30-00:10', '00:00-00:40', '00:30-01:10'
  ]
};

const SETTINGS_KEY = 'schedule.settings';
const SHIFTS_KEY   = 'schedule.shifts';
const REMIND_KEY   = 'schedule.remindOn';
const RECORDS_KEY  = 'schedule.records';   // 演出记录（歌单/备注走云同步，照片仅本机）

// 当前设置
let settings = Object.assign(
  {}, DEFAULT_SETTINGS,
  safeParse(localStorage.getItem(SETTINGS_KEY))
);

// 所有场次：{ id, date:"YYYY-MM-DD", slot:1|2|3, store, time, note }
let shifts = safeParse(localStorage.getItem(SHIFTS_KEY)) || [];

// 演出记录：{ "YYYY-MM-DD": { 1: { songs:[], note:"", photos:[{id,path}], updatedAt } } }
// photos[].id = 本机 IndexedDB 里的照片 id（云端拉取的照片会静默回填）；photos[].path = 云端路径（空=待上传）
let records = safeParse(localStorage.getItem(RECORDS_KEY)) || {};

// 当前视图月份
let viewYear  = settings.year;
let viewMonth = new Date().getMonth(); // 0-11，默认打开当前月
let selectedDate = todayStr();
let editingId = null;   // 正在编辑的场次 id
let remindOn = localStorage.getItem(REMIND_KEY) === '1';
let remindTimer = null;
let notifiedSet = new Set(); // 今天已提醒过的场次（仅内存，避免触发云同步）
let filterStore = '';   // 门店筛选：'' = 全部；否则为门店名

/* ---------- 2. 工具函数 ---------- */

function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function saveSettings() {
  settings._savedAt = Date.now(); // 用于多设备同步时判断设置新旧
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  if (!window.__syncApplying && window.Sync) Sync.markPending(); // 有修改 → 待同步
}
function saveShifts() {
  localStorage.setItem(SHIFTS_KEY, JSON.stringify(shifts));
  if (!window.__syncApplying && window.Sync) Sync.markPending(); // 有修改 → 待同步
}
function saveRecords() {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
  if (!window.__syncApplying && window.Sync) Sync.markPending(); // 歌单/备注 → 待同步
}

/* ---------- 2.5 演出记录：查询 ---------- */

// 取某场次的记录（不存在/已删除返回 null）
function getRecord(date, slot) {
  const r = records[date] && records[date][slot];
  return (r && !r.deleted) ? r : null;
}

// 取记录的照片数组（旧数据 photoIds → 新结构 photos 自动迁移）
// 新结构：photos: [{ id: '本机IndexedDB键（云端照片可为空）', path: '云端路径（空=待上传）' }]
function recPhotos(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.photos)) return rec.photos;
  if (Array.isArray(rec.photoIds) && rec.photoIds.length) {
    rec.photos = rec.photoIds.map(id => ({ id: id, path: '' }));
    delete rec.photoIds;
    return rec.photos;
  }
  return [];
}

// 记录是否有实际内容（照片 / 歌单 / 备注）
function recordHasContent(r) {
  if (!r) return false;
  return recPhotos(r).length > 0 ||
         (r.songs && r.songs.length > 0) ||
         !!r.note;
}

// 某天是否存在有内容的演出记录（月历角标用）
function dayHasRecord(dateStr) {
  const day = records[dateStr];
  if (!day) return false;
  return Object.keys(day).some(slot => recordHasContent(day[slot]));
}

// 面板里显示的照片总数：照片数 与 云端标记数 取大
function recordPhotoTotal(r) {
  if (!r) return 0;
  const local = recPhotos(r).length;
  const remote = r.photoCount || 0;
  return Math.max(local, remote);
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 加载一张照片的 Blob：本机 IndexedDB 优先；本机没有但有云端路径 → 从云端拉取并静默缓存
// （缓存写入不触发云同步，避免循环）
async function loadPhotoBlob(ph) {
  if (!ph) return null;
  if (ph.id) {
    try {
      const blob = await PhotoDB.get(ph.id);
      if (blob) return blob;
    } catch (e) { /* 本机没有，继续试云端 */ }
  }
  if (ph.path && window.PhotoCloud && PhotoCloud.configured()) {
    const blob = await PhotoCloud.fetchBlob(ph.path);
    if (blob) {
      // 静默缓存到本机，下次直接本地读
      try {
        const id = PhotoDB.newId();
        await PhotoDB.add(id, blob);
        ph.id = id;
      } catch (e) { /* 缓存失败不影响显示 */ }
    }
    return blob;
  }
  return null;
}

/* ---------- 待上传队列：把本机新增的照片传到 GitHub 私有仓库 ---------- */

let photoUploadBusy = false;

async function uploadPendingPhotos() {
  if (!window.PhotoCloud || !PhotoCloud.configured() || photoUploadBusy) return;
  photoUploadBusy = true;
  try {
    // 扫描所有记录，找 path 为空（待上传）的照片
    const tasks = []; // {date, slot, rec, ph}
    for (const date of Object.keys(records)) {
      for (const slot of Object.keys(records[date])) {
        const rec = records[date][slot];
        if (rec && !rec.deleted) {
          recPhotos(rec).forEach(ph => {
            if (!ph.path) tasks.push({ date, slot, rec, ph });
          });
        }
      }
    }
    if (!tasks.length) return;

    let uploaded = 0;
    for (const t of tasks) {
      if (!t.ph.id) continue; // 本机没有文件（如另一台设备添加的），等那台设备传
      const blob = await PhotoDB.get(t.ph.id).catch(() => null);
      if (!blob) continue;
      const path = PhotoCloud.photoPath(t.date, t.slot, t.ph.id);
      try {
        await PhotoCloud.upload(blob, path);
        t.ph.path = path;
        t.rec.updatedAt = Date.now();
        uploaded++;
      } catch (e) { /* 单张失败下次再传 */ }
    }
    if (uploaded > 0) {
      saveRecords();
      // 刷新当前打开的面板（若有），去掉「待上传」角标
      if (document.getElementById('recordMask').classList.contains('show')) renderPhotoGrid();
    }
  } finally {
    photoUploadBusy = false;
  }
}
window.uploadPendingPhotos = uploadPendingPhotos;

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// '2026-08-25' → '8月25日 星期二'
function formatDateCN(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return m + '月' + d + '日 ' + weekdayCN(dateStr);
}

// '2026-08-25' → '星期二'
function weekdayCN(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return '星期' + ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
}

// 门店专属颜色（按 settings.stores 的顺序分配，列表外门店用第 4 色兜底）
const STORE_COLORS = ['var(--store-1)', 'var(--store-2)', 'var(--store-3)', 'var(--store-4)'];
function storeColor(name) {
  const i = settings.stores.indexOf(name);
  return STORE_COLORS[i >= 0 ? (i % STORE_COLORS.length) : 3];
}

// 当前视图月份的标识 '2026-08'
function viewMonthKey() {
  return viewYear + '-' + pad(viewMonth + 1);
}

// 当月场次（不含已删除的墓碑记录）
function monthShifts() {
  const prefix = viewMonthKey() + '-';
  return shifts.filter(s => !s.deleted && s.date.startsWith(prefix));
}

// 某天的场次（不含墓碑）
function dayShifts(dateStr) {
  return shifts.filter(s => !s.deleted && s.date === dateStr);
}

// 轻提示
function toast(msg) {
  let el = document.getElementById('toastEl');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toastEl';
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

/* ---------- 3. 页面标题与头部 ---------- */

function renderHeader() {
  document.getElementById('appTitle').textContent = settings.singer + ' 排班登记';
  // 副标题：同步状态（已绑定云同步时显示同步情况，否则提示本机保存）
  const syncStatus = (window.Sync && Sync.statusText()) || '数据保存在本机';
  document.getElementById('headerDate').textContent = '年份 ' + settings.year + ' · ' + syncStatus;
  document.getElementById('calTitle').textContent = viewYear + '年' + (viewMonth + 1) + '月';

  const ms = monthShifts();
  const calSub = document.getElementById('calSub');
  if (filterStore) {
    const n = ms.filter(s => s.store === filterStore).length;
    calSub.textContent = '筛选：' + filterStore + ' · 本月 ' + n + ' 场';
  } else {
    calSub.textContent = '本月已登记 ' + ms.length + ' 场';
  }
}

/* ---------- 4. 月历渲染 ---------- */

function renderCalendar() {
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

  // 本月每天场次数（用于显示圆点）；筛选门店时只统计该门店
  const countMap = {};
  monthShifts().forEach(s => {
    if (filterStore && s.store !== filterStore) return;
    const d = Number(s.date.slice(8, 10));
    countMap[d] = (countMap[d] || 0) + 1;
  });

  // 筛选门店时圆点用该门店颜色
  const dotColor = filterStore ? storeColor(filterStore) : null;

  // 本月有演出记录的日期（照片/歌单角标，不受门店筛选影响）
  const recordDays = {};
  Object.keys(records).forEach(dateStr => {
    if (dateStr.startsWith(viewMonthKey() + '-') && dayHasRecord(dateStr)) {
      recordDays[dateStr] = true;
    }
  });

  // 上个月补位（本地拼接，避免 toISOString 的 UTC 时区偏移）
  const prevY = viewMonth === 0 ? viewYear - 1 : viewYear;
  const prevM = viewMonth === 0 ? 11 : viewMonth - 1;
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const dateStr = prevY + '-' + pad(prevM + 1) + '-' + pad(d);
    grid.appendChild(dayCell(dateStr, true, 0, dotColor, recordDays[dateStr]));
  }

  // 本月
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(d);
    grid.appendChild(dayCell(dateStr, false, countMap[d] || 0, dotColor, recordDays[dateStr]));
  }

  // 下个月补位（本地拼接，避免 toISOString 的 UTC 时区偏移）
  const nextCount = 7 - (grid.children.length % 7);
  if (nextCount < 7) {
    const nextY = viewMonth === 11 ? viewYear + 1 : viewYear;
    const nextM = viewMonth === 11 ? 0 : viewMonth + 1;
    for (let d = 1; d <= nextCount; d++) {
      const dateStr = nextY + '-' + pad(nextM + 1) + '-' + pad(d);
      grid.appendChild(dayCell(dateStr, true, 0, dotColor, recordDays[dateStr]));
    }
  }

  // 图例联动
  const legend = document.getElementById('calLegend');
  if (filterStore) {
    legend.textContent = '● 圆点 = ' + filterStore + ' 有排班的日期 · 📷 = 有演出记录';
  } else {
    legend.textContent = '● = 当天有排班 · 📷 = 有演出记录';
  }
}

function dayCell(dateStr, otherMonth, count, dotColor, hasRec) {
  const cell = document.createElement('div');
  cell.className = 'cal-day' + (otherMonth ? ' other-month' : '');

  const num = document.createElement('span');
  num.className = 'day-num';
  num.textContent = Number(dateStr.slice(8, 10));
  cell.appendChild(num);

  if (isToday(dateStr)) cell.classList.add('today');
  if (dateStr === selectedDate) cell.classList.add('selected');
  if (hasRec) cell.classList.add('has-record');
  if (count > 0) {
    cell.classList.add('has-event');
    const dots = document.createElement('span');
    dots.className = 'dots';
    // 最多显示 3 个圆点
    for (let i = 0; i < Math.min(count, 3); i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      if (dotColor) dot.style.background = dotColor; // 筛选门店时用门店色
      dots.appendChild(dot);
    }
    cell.appendChild(dots);
  }

  cell.addEventListener('click', () => {
    selectedDate = dateStr;
    renderCalendar();
    renderList();
  });
  return cell;
}

function isToday(dateStr) {
  return dateStr === todayStr();
}

/* ---------- 5. 当日排班列表 ---------- */

function renderList() {
  const title = document.getElementById('listTitle');
  title.textContent = isToday(selectedDate)
    ? '今日排班'
    : formatDateCN(selectedDate) + ' 的排班';

  const dayEvents = dayShifts(selectedDate).sort((a, b) => a.slot - b.slot);
  const list = document.getElementById('eventList');
  document.getElementById('listCount').textContent = dayEvents.length + ' / 3 场';
  list.innerHTML = '';

  // 按场次 1/2/3 展示
  for (let slot = 1; slot <= 3; slot++) {
    const e = dayEvents.find(x => x.slot === slot);
    if (e) {
      list.appendChild(eventItem(e));
    } else {
      list.appendChild(emptySlot(slot));
    }
  }

  // 满 3 场提示
  if (dayEvents.length >= 3) {
    const tip = document.createElement('div');
    tip.className = 'full-tip';
    tip.textContent = '当天 3 场已满，多余场次请记在备注或另选日期';
    list.appendChild(tip);
  }
}

// 已登记的场次卡片
function eventItem(e) {
  const item = document.createElement('div');
  item.className = 'event-item';

  const badge = document.createElement('div');
  badge.className = 'slot-badge slot-' + e.slot;
  badge.textContent = '场次' + e.slot;
  item.appendChild(badge);

  const main = document.createElement('div');
  main.className = 'event-main';

  const store = document.createElement('div');
  store.className = 'event-store';
  store.textContent = e.store;
  main.appendChild(store);

  const meta = document.createElement('div');
  meta.className = 'event-meta';

  if (e.time) {
    const time = document.createElement('span');
    time.className = 'event-time';
    time.textContent = e.time;
    meta.appendChild(time);
  }
  main.appendChild(meta);

  if (e.note) {
    const note = document.createElement('div');
    note.className = 'event-note';
    note.textContent = '📝 ' + e.note;
    main.appendChild(note);
  }

  item.appendChild(main);

  // —— 演出记录联动：有记录 → 照片缩略横滚 + 摘要行；无记录 → 虚线添加按钮 ——
  const rec = getRecord(e.date, e.slot);
  if (recordHasContent(rec)) {
    item.classList.add('has-record');

    // 照片缩略横滚（最多预览 3 张 + 「还有 N 张」）
    const photos = recPhotos(rec);
    if (photos.length > 0) {
      const strip = document.createElement('div');
      strip.className = 'event-photos';
      const shown = photos.slice(0, 3);
      shown.forEach(ph => {
        const img = document.createElement('img');
        img.className = 'event-photo';
        img.alt = '现场照片';
        img.loading = 'lazy';
        strip.appendChild(img);
        loadPhotoBlob(ph).then(blob => {
          if (blob) {
            const url = URL.createObjectURL(blob);
            img.src = url;
            img.onload = () => URL.revokeObjectURL(url); // 加载完释放，下次从 IndexedDB 再取
          } else {
            // 拉不到（未绑定照片云 / 网络断）→ 云朵占位，不留裂图
            img.remove();
            const empty = document.createElement('div');
            empty.className = 'event-photo event-photo-empty';
            empty.textContent = '☁';
            strip.appendChild(empty);
          }
        }).catch(() => {});
      });
      if (photos.length > shown.length) {
        const more = document.createElement('div');
        more.className = 'event-photo-more';
        more.innerHTML = '<span class="cam">📷</span>还有' + (photos.length - shown.length) + '张';
        strip.appendChild(more);
      }
      item.appendChild(strip);
    }

    // 摘要行：歌单 N 首 / 现场备注 / 查看记录
    const row = document.createElement('div');
    row.className = 'event-record-row';
    if (rec.songs && rec.songs.length > 0) {
      const t = document.createElement('span');
      t.className = 'record-tag';
      t.textContent = '🎵 歌单 ' + rec.songs.length + ' 首';
      row.appendChild(t);
    }
    if (rec.note) {
      const t = document.createElement('span');
      t.className = 'record-tag';
      t.textContent = '📝 现场备注';
      row.appendChild(t);
    }
    const openBtn = document.createElement('button');
    openBtn.className = 'record-open-btn';
    openBtn.textContent = '查看记录';
    openBtn.addEventListener('click', (ev) => {
      ev.stopPropagation(); // 不触发卡片的编辑
      openRecord(e);
    });
    row.appendChild(openBtn);
    item.appendChild(row);
  } else {
    // 未记录 → 虚线添加按钮
    const addBtn = document.createElement('button');
    addBtn.className = 'add-record-btn';
    addBtn.innerHTML = '📷 添加演出记录（照片 / 歌单）';
    addBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openRecord(e);
    });
    item.appendChild(addBtn);
  }

  // 点击 → 编辑
  item.addEventListener('click', () => openModal(e));
  return item;
}

// 空场次占位（点击添加）
function emptySlot(slot) {
  const btn = document.createElement('button');
  btn.className = 'empty-slot';

  const badge = document.createElement('div');
  badge.className = 'slot-badge slot-' + slot;
  badge.textContent = '场次' + slot;
  btn.appendChild(badge);

  const plus = document.createElement('span');
  plus.className = 'plus';
  plus.textContent = '＋';
  btn.appendChild(plus);

  const txt = document.createElement('span');
  txt.textContent = '点此添加';
  btn.appendChild(txt);

  btn.addEventListener('click', () => {
    // 检查当天是否已满 3 场
    if (dayShifts(selectedDate).length >= 3) {
      toast('当天 3 场已满，最多登记 3 场');
      return;
    }
    openModal(null, slot);
  });
  return btn;
}

/* ---------- 5.5 门店筛选：查看该门店当月所有排班日期 ---------- */

// 筛选按钮列表：设置里的门店 + 当月出现过但不在列表里的门店
function filterStoreList() {
  const list = settings.stores.slice();
  const prefix = viewMonthKey() + '-';
  shifts.forEach(s => {
    if (!s.deleted && s.date.startsWith(prefix) && !list.includes(s.store)) list.push(s.store);
  });
  return list;
}

// 门店筛选按钮组（全部 + 各门店）
function renderStoreFilter() {
  const box = document.getElementById('storeFilter');
  box.innerHTML = '';

  // 若当前筛选的门店已被删除/不存在 → 回到全部
  if (filterStore && !filterStoreList().includes(filterStore)) filterStore = '';

  // 「全部」按钮
  const allBtn = document.createElement('button');
  allBtn.className = 'store-chip' + (filterStore ? '' : ' active');
  allBtn.style.setProperty('--chip-color', 'var(--primary)');
  allBtn.textContent = '全部';
  allBtn.addEventListener('click', () => {
    if (filterStore) { filterStore = ''; renderAll(); }
  });
  box.appendChild(allBtn);

  // 各门店按钮
  filterStoreList().forEach(store => {
    const btn = document.createElement('button');
    btn.className = 'store-chip' + (filterStore === store ? ' active' : '');
    btn.style.setProperty('--chip-color', storeColor(store));
    btn.textContent = store;
    btn.addEventListener('click', () => {
      if (filterStore !== store) { filterStore = store; renderAll(); }
    });
    box.appendChild(btn);
  });
}

// 所选门店当月所有排班日期列表
function renderStoreDates() {
  const box = document.getElementById('storeDates');
  const count = document.getElementById('storeCount');
  box.innerHTML = '';

  if (!filterStore) {
    count.textContent = filterStoreList().length + ' 家';
    const hint = document.createElement('div');
    hint.className = 'store-empty';
    hint.textContent = '点上方门店按钮，查看该店当月所有排班日期';
    box.appendChild(hint);
    return;
  }

  // 该门店当月排班，按日期+场次排序
  const list = monthShifts()
    .filter(s => s.store === filterStore)
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot);

  count.textContent = list.length + ' 场';

  if (list.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'store-empty';
    hint.textContent = filterStore + ' 本月暂无排班';
    box.appendChild(hint);
    return;
  }

  // 同一天多场合并成一行
  const byDate = {};
  list.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });

  Object.keys(byDate).forEach(dateStr => {
    const items = byDate[dateStr].sort((a, b) => a.slot - b.slot);
    const color = storeColor(filterStore);
    const row = document.createElement('div');
    row.className = 'store-date-row';
    row.style.setProperty('--row-color', color);

    // 左侧：日期 + 星期
    const left = document.createElement('div');
    left.className = 'store-date-left';
    const d = document.createElement('div');
    d.className = 'store-date-d';
    d.textContent = Number(dateStr.slice(8, 10));
    left.appendChild(d);
    const w = document.createElement('div');
    w.className = 'store-date-w';
    w.textContent = weekdayCN(dateStr);
    left.appendChild(w);
    row.appendChild(left);

    // 右侧：当天该门店各场次
    const right = document.createElement('div');
    right.className = 'store-date-right';
    items.forEach(s => {
      const it = document.createElement('div');
      it.className = 'store-date-item';
      const badge = document.createElement('span');
      badge.className = 'slot-badge slot-' + s.slot;
      badge.textContent = '场次' + s.slot;
      it.appendChild(badge);
      const t = document.createElement('span');
      t.className = 'store-date-time';
      t.textContent = s.time || '—';
      it.appendChild(t);
      if (s.note) {
        const n = document.createElement('span');
        n.className = 'store-date-note';
        n.textContent = s.note;
        it.appendChild(n);
      }
      // 点击某场次 → 选中该日期并打开编辑
      it.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedDate = dateStr;
        openModal(s);
      });
      right.appendChild(it);
    });
    row.appendChild(right);

    // 点击整行 → 编辑该日第一场
    row.addEventListener('click', () => {
      selectedDate = dateStr;
      openModal(items[0]);
    });
    box.appendChild(row);
  });
}

/* ---------- 6. 统计面板 ---------- */

// 统计时段：all 全月 | p1 1-10日 | p2 11-25日
let statPeriod = 'all';
const STAT_PERIODS = {
  all: { label: '本月',  empty: '本月暂无登记，快去添加场次吧', range: null },
  p1:  { label: '1-10日', empty: '1-10日 暂无登记', range: [1, 10] },
  p2:  { label: '11-25日', empty: '11-25日 暂无登记', range: [11, 25] }
};

// 当前时段的场次（在 monthShifts 基础上按日期号数过滤）
function periodShifts() {
  const ms = monthShifts();
  const p = STAT_PERIODS[statPeriod];
  if (!p || !p.range) return ms;
  return ms.filter(s => {
    const day = parseInt(s.date.slice(8), 10) || 0;
    return day >= p.range[0] && day <= p.range[1];
  });
}

function renderStats() {
  const p = STAT_PERIODS[statPeriod] || STAT_PERIODS.all;
  const ms = periodShifts();
  const total = ms.length;

  // Hero 大数字（场次总数）+ 标签跟随时段
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statHeroLabel').textContent = p.label + '总场次';

  // 环形图与中心数字
  const donut = document.getElementById('statDonut');
  document.getElementById('statDonutCenter').textContent = total;

  const grid = document.getElementById('statGrid');
  grid.innerHTML = '';

  if (total === 0) {
    donut.style.background = 'var(--line)';
    const empty = document.createElement('div');
    empty.className = 'stat-empty';
    empty.textContent = p.empty;
    grid.appendChild(empty);
    return;
  }

  // 统计各门店场次
  const stats = {};
  ms.forEach(s => { stats[s.store] = (stats[s.store] || 0) + 1; });
  const storeNames = Object.keys(stats);

  // 环形图：按门店占比生成 conic-gradient
  let acc = 0;
  const stops = storeNames.map((store, idx) => {
    const pct = (stats[store] / total) * 100;
    const from = acc;
    acc += pct;
    const color = storeColor(store);
    return color + ' ' + from.toFixed(1) + '% ' + acc.toFixed(1) + '%';
  });
  donut.style.background = 'conic-gradient(' + stops.join(', ') + ')';

  // 各门店进度条
  storeNames.forEach((store, idx) => {
    const row = document.createElement('div');
    row.className = 'stat-bar-row';

    const dot = document.createElement('div');
    dot.className = 'stat-dot';
    dot.style.background = storeColor(store);
    row.appendChild(dot);

    const name = document.createElement('div');
    name.className = 'stat-bar-name';
    name.textContent = store;
    row.appendChild(name);

    const track = document.createElement('div');
    track.className = 'stat-bar-track';

    const fill = document.createElement('div');
    fill.className = 'stat-bar-fill';
    fill.style.width = ((stats[store] / total) * 100).toFixed(1) + '%';
    fill.style.background = storeColor(store);
    track.appendChild(fill);
    row.appendChild(track);

    const num = document.createElement('div');
    num.className = 'stat-bar-num';
    num.textContent = stats[store];
    row.appendChild(num);

    grid.appendChild(row);
  });
}

/* ---------- 7. 弹窗：添加 / 编辑场次 ---------- */

// 填充门店 / 时间段下拉
function fillSelects() {
  const storeSel = document.getElementById('inputStore');
  storeSel.innerHTML = '';
  settings.stores.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    storeSel.appendChild(opt);
  });

  const timeSel = document.getElementById('inputTime');
  timeSel.innerHTML = '';
  settings.timeSlots.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    timeSel.appendChild(opt);
  });
}

// 当前选中的场次（1/2/3）
let currentSlot = 1;

function openModal(e, presetSlot) {
  editingId = e ? e.id : null;
  fillSelects();

  document.getElementById('modalTitle').textContent = e ? '编辑场次' : '添加场次';
  document.getElementById('inputDate').value = e ? e.date : selectedDate;
  document.getElementById('inputNote').value = e ? (e.note || '') : '';

  // 场次
  currentSlot = e ? e.slot : (presetSlot || nextFreeSlot());
  highlightSlot();

  // 门店 / 时间段
  const storeSel = document.getElementById('inputStore');
  const timeSel  = document.getElementById('inputTime');
  if (e) {
    if (settings.stores.includes(e.store)) storeSel.value = e.store;
    else { // 门店不在列表里 → 加入列表并选中
      settings.stores.push(e.store); saveSettings(); fillSelects();
      storeSel.value = e.store;
    }
    if (settings.timeSlots.includes(e.time)) timeSel.value = e.time;
  } else {
    // 默认选第一个空的值
    storeSel.selectedIndex = 0;
    timeSel.selectedIndex = 0;
  }

  // 编辑时显示删除按钮
  document.getElementById('deleteBtn').classList.toggle('hidden', !e);

  // 隐藏自定义输入框（若上次显示过）
  hideCustomInputs();

  document.getElementById('modalMask').classList.add('show');
}

// 下一个未占用的场次号；已满返回 3
function nextFreeSlot() {
  const used = new Set(dayShifts(selectedDate).map(x => x.slot));
  for (let i = 1; i <= 3; i++) if (!used.has(i)) return i;
  return 3;
}

function highlightSlot() {
  document.querySelectorAll('.slot-opt').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.slot) === currentSlot);
  });
}

function closeModal() {
  document.getElementById('modalMask').classList.remove('show');
  editingId = null;
  hideCustomInputs();
}

// 隐藏自定义输入框
function hideCustomInputs() {
  const s = document.getElementById('customStoreBox');
  if (s) s.remove();
  const t = document.getElementById('customTimeBox');
  if (t) t.remove();
}

// 显示一个"自定义"输入框（替代下拉选择）
function showCustomInput(which) {
  hideCustomInputs();
  const box = document.createElement('div');
  box.id = which === 'store' ? 'customStoreBox' : 'customTimeBox';
  box.className = 'field';
  box.style.marginTop = '8px';
  box.innerHTML =
    '<input type="text" maxlength="20" placeholder="' +
    (which === 'store' ? '输入新门店名称' : '输入时间段，如 23:30-00:10') +
    '">';
  const input = box.querySelector('input');

  // 找到下拉所在 field，插到其后
  const target = which === 'store'
    ? document.getElementById('inputStore').closest('.field')
    : document.getElementById('inputTime').closest('.field');
  target.parentNode.insertBefore(box, target.nextSibling);
  input.focus();

  // 输入时实时同步到下拉选中项
  input.addEventListener('input', () => {
    if (which === 'store') {
      const sel = document.getElementById('inputStore');
      if (input.value && ![...sel.options].some(o => o.value === input.value)) {
        const opt = document.createElement('option');
        opt.value = input.value;
        opt.textContent = input.value;
        sel.appendChild(opt);
        sel.value = input.value;
      }
    } else {
      const sel = document.getElementById('inputTime');
      if (input.value && ![...sel.options].some(o => o.value === input.value)) {
        const opt = document.createElement('option');
        opt.value = input.value;
        opt.textContent = input.value;
        sel.appendChild(opt);
        sel.value = input.value;
      }
    }
  });
}

function handleSave() {
  const date  = document.getElementById('inputDate').value;
  const store = document.getElementById('inputStore').value.trim();
  const time  = document.getElementById('inputTime').value.trim();
  const note  = document.getElementById('inputNote').value.trim();

  if (!date)  { toast('请选择日期'); return; }
  if (!store) { toast('请选择或输入门店'); return; }
  if (!time)  { toast('请选择或输入时间段'); return; }

  if (editingId) {
    // 编辑
    const e = shifts.find(x => x.id === editingId);
    if (e) {
      // 日期/场次变化 → 演出记录跟着搬家（照片 id 不变，无需移动 IndexedDB）
      if ((e.date !== date || e.slot !== currentSlot) && getRecord(e.date, e.slot)) {
        const rec = getRecord(e.date, e.slot);
        delete records[e.date][e.slot];
        if (!records[date]) records[date] = {};
        records[date][currentSlot] = rec;
        rec.updatedAt = Date.now();
        saveRecords();
      }
      e.date = date; e.slot = currentSlot; e.store = store; e.time = time; e.note = note;
      e.updatedAt = Date.now(); // 多设备同步用：最后修改时间
      e.deleted = false;
    }
  } else {
    // 新增：检查当天该场次是否冲突（只算未删除的）
    const dup = shifts.find(x => !x.deleted && x.date === date && x.slot === currentSlot);
    if (dup) { toast('场次 ' + currentSlot + ' 当天已登记，请选择其他场次'); return; }
    // 检查当天是否满 3 场
    if (dayShifts(date).length >= 3) {
      toast('当天 3 场已满，最多登记 3 场');
      return;
    }
    shifts.push({
      id: newId(),
      date, slot: currentSlot, store, time, note,
      updatedAt: Date.now()
    });
  }

  saveShifts();
  closeModal();

  // 刷新界面并跳到对应日期/月份
  selectedDate = date;
  const d = new Date(date + 'T00:00:00');
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  renderAll();
  toast('已保存 ✓');
}

function handleDelete() {
  // 多设备同步：改成墓碑标记（deleted），让删除操作也能同步到其他设备
  const e = shifts.find(x => x.id === editingId);
  if (e) { e.deleted = true; e.updatedAt = Date.now(); }

  // 连带处理演出记录：记录同样打墓碑同步删除；本机照片从 IndexedDB 清掉，云端照片一并删除
  const rec = getRecord(e.date, e.slot);
  if (rec) {
    rec.deleted = true;
    rec.updatedAt = Date.now();
    const photos = recPhotos(rec);
    if (photos.length) {
      photos.forEach(ph => {
        if (ph.id) PhotoDB.remove(ph.id).catch(() => {});
        if (ph.path && window.PhotoCloud && PhotoCloud.configured()) {
          PhotoCloud.remove(ph.path).catch(() => {});
        }
      });
      rec.photos = [];
    }
    saveRecords();
  }

  saveShifts();
  closeModal();
  renderAll();
  toast('已删除');
}

/* ---------- 7.5 演出记录面板（照片 / 歌单 / 现场备注） ---------- */

let recordCtx = { date: '', slot: 0 };   // 当前打开面板的场次
let recordUrls = [];                      // 面板里创建的 objectURL（关闭时统一释放）

// 面板当前操作的记录（不存在则创建空记录）
function ctxRecord() {
  if (!records[recordCtx.date]) records[recordCtx.date] = {};
  if (!records[recordCtx.date][recordCtx.slot]) {
    records[recordCtx.date][recordCtx.slot] = { songs: [], note: '', photos: [], photoCount: 0, updatedAt: 0 };
  }
  return records[recordCtx.date][recordCtx.slot];
}

function openRecord(e) {
  recordCtx = { date: e.date, slot: e.slot };

  const sub = document.getElementById('recordSub');
  sub.textContent = formatDateCN(e.date) + ' · 场次' + e.slot + ' · ' + e.store + (e.time ? ' · ' + e.time : '');

  const rec = ctxRecord();
  document.getElementById('recordNoteInput').value = rec.note || '';
  renderSongChips();
  renderPhotoGrid();

  document.getElementById('recordMask').classList.add('show');
}

function closeRecord() {
  // 备注即时保存（失焦兜底）
  const rec = records[recordCtx.date] && records[recordCtx.date][recordCtx.slot];
  if (rec && !rec.deleted) {
    const txt = document.getElementById('recordNoteInput').value.trim();
    if (txt !== (rec.note || '')) {
      rec.note = txt;
      rec.updatedAt = Date.now();
      saveRecords();
    }
  }

  document.getElementById('recordMask').classList.remove('show');
  // 释放面板里所有 objectURL
  recordUrls.forEach(u => URL.revokeObjectURL(u));
  recordUrls = [];
  // 刷新卡片与月历角标
  renderList();
  renderCalendar();
}

// 照片网格渲染
function renderPhotoGrid() {
  const grid = document.getElementById('photoGrid');
  grid.innerHTML = '';
  const rec = getRecord(recordCtx.date, recordCtx.slot);
  const photos = recPhotos(rec);

  document.getElementById('photoCountLabel').textContent = photos.length + ' / 9 张';

  photos.forEach((ph, idx) => {
    const cell = document.createElement('div');
    cell.className = 'photo-cell';
    const img = document.createElement('img');
    img.alt = '现场照片';
    cell.appendChild(img);

    // 待上传角标（本机新增、还没传到云端）
    if (!ph.path && window.PhotoCloud && PhotoCloud.configured()) {
      const flag = document.createElement('span');
      flag.className = 'photo-upload-flag';
      flag.textContent = '⇡';
      flag.title = '待上传到云端';
      cell.appendChild(flag);
    }

    // 点击 → 全屏查看
    cell.addEventListener('click', (ev) => {
      if (ev.target.closest('.photo-del')) return; // 点删除不触发查看
      loadPhotoBlob(ph).then(blob => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const viewerImg = document.getElementById('photoViewerImg');
        viewerImg.onload = () => URL.revokeObjectURL(url);
        viewerImg.src = url;
        document.getElementById('photoViewer').classList.add('show');
      }).catch(() => {});
    });

    // 删除按钮
    const del = document.createElement('button');
    del.className = 'photo-del';
    del.textContent = '×';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      removePhotoAt(idx);
    });
    cell.appendChild(del);

    grid.appendChild(cell);
    loadPhotoBlob(ph).then(blob => {
      if (blob) {
        const url = URL.createObjectURL(blob);
        recordUrls.push(url);
        img.src = url;
      } else {
        // 拉不到（未绑定照片云 / 网络断）→ 云朵占位，不留裂图
        img.remove();
        const empty = document.createElement('span');
        empty.className = 'photo-empty';
        empty.textContent = '☁';
        empty.title = (window.PhotoCloud && PhotoCloud.configured()) ? '点击重试 / 网络恢复后自动加载' : '绑定照片云备份后可查看（设置里绑定）';
        cell.insertBefore(empty, cell.firstChild);
      }
    }).catch(() => {});
  });

  // 「＋ 添加」格（最多 9 张）
  if (photos.length < 9) {
    const add = document.createElement('button');
    add.className = 'photo-add';
    add.innerHTML = '<span class="plus">＋</span>添加';
    add.addEventListener('click', () => {
      document.getElementById('photoFileInput').click();
    });
    grid.appendChild(add);
  }

  // 未绑定照片云备份时，另一台设备的照片只能在那台设备上看到
  const cloudOn = window.PhotoCloud && PhotoCloud.configured();
  const remote = (!cloudOn && rec && (rec.photoCount || 0) > photos.length) ? (rec.photoCount - photos.length) : 0;
  if (remote > 0) {
    const tip = document.createElement('div');
    tip.className = 'photo-remote-tip';
    tip.textContent = '另有 ' + remote + ' 张照片保存在添加它的那台设备上（绑定照片云备份后两台设备都能看）';
    grid.appendChild(tip);
  }
}

// 删除一张照片（本机 IndexedDB + 云端文件 + 记录同步更新）
function removePhotoAt(idx) {
  const rec = getRecord(recordCtx.date, recordCtx.slot);
  const photos = recPhotos(rec);
  if (!rec || idx < 0 || idx >= photos.length) return;
  const ph = photos[idx];
  photos.splice(idx, 1);
  rec.updatedAt = Date.now();
  if (ph.id) PhotoDB.remove(ph.id).catch(() => {});
  if (ph.path && window.PhotoCloud && PhotoCloud.configured()) {
    PhotoCloud.remove(ph.path).catch(() => {}); // 删除云端文件，不留垃圾
  }
  saveRecords();
  renderPhotoGrid();
}

// 选中照片文件 → 压缩 → IndexedDB → 触发云上传
async function handlePhotoFiles(files) {
  const rec = ctxRecord();
  const remain = 9 - recPhotos(rec).length;
  if (remain <= 0) { toast('每场最多 9 张照片'); return; }

  const list = Array.from(files).slice(0, remain);
  if (Array.from(files).length > remain) toast('每场最多 9 张，已截取前 ' + remain + ' 张');

  let added = 0;
  for (const file of list) {
    try {
      const blob = await PhotoDB.compress(file);
      const id = PhotoDB.newId();
      await PhotoDB.add(id, blob);
      recPhotos(rec).push({ id: id, path: '' }); // path 空 = 待上传
      added++;
    } catch (err) { /* 单张失败跳过 */ }
  }

  if (added > 0) {
    rec.updatedAt = Date.now();
    saveRecords();
    renderPhotoGrid();
    if (window.PhotoCloud && PhotoCloud.configured()) {
      toast('已保存 ' + added + ' 张，正在上传云端…');
      uploadPendingPhotos(); // 后台上传，不阻塞界面
    } else {
      toast('已保存 ' + added + ' 张照片 ✓（未绑定照片云备份，仅本机可见）');
    }
  } else {
    toast('照片保存失败，请重试');
  }
}

// 歌单 chips 渲染
function renderSongChips() {
  const box = document.getElementById('songChips');
  box.innerHTML = '';
  const rec = getRecord(recordCtx.date, recordCtx.slot);
  const songs = (rec && rec.songs) || [];

  document.getElementById('songCountLabel').textContent = songs.length + ' 首';

  songs.forEach((song, idx) => {
    const chip = document.createElement('span');
    chip.className = 'song-chip';
    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = song;
    chip.appendChild(txt);
    const x = document.createElement('button');
    x.className = 'song-x';
    x.textContent = '×';
    x.addEventListener('click', () => {
      rec.songs.splice(idx, 1);
      rec.updatedAt = Date.now();
      saveRecords();
      renderSongChips();
    });
    chip.appendChild(x);
    box.appendChild(chip);
  });

  if (songs.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'record-hint';
    hint.textContent = '还没有录歌，在下面输入框里回车添加';
    box.appendChild(hint);
  }
}

// 输入框回车 → 加歌
function addSongFromInput() {
  const input = document.getElementById('songInput');
  const name = input.value.trim();
  if (!name) return;
  const rec = ctxRecord();
  if (!rec.songs.includes(name)) {
    rec.songs.push(name);
    rec.updatedAt = Date.now();
    saveRecords();
  }
  input.value = '';
  renderSongChips();
}

// 「保存记录」按钮：兜底保存并关闭
function saveRecordAndClose() {
  const rec = records[recordCtx.date] && records[recordCtx.date][recordCtx.slot];
  if (rec && !rec.deleted) {
    const txt = document.getElementById('recordNoteInput').value.trim();
    if (txt !== (rec.note || '')) {
      rec.note = txt;
      rec.updatedAt = Date.now();
    }
    saveRecords();
  }
  closeRecord();
  toast('演出记录已保存 ✓');
}

/* ---------- 8. 设置弹窗 ---------- */

function openSettings() {
  document.getElementById('setSinger').value = settings.singer;
  document.getElementById('setYear').value = settings.year;
  renderChips('store');
  renderChips('time');
  if (window.Sync) Sync.renderSyncUI(); // 刷新多设备同步区域
  if (window.PhotoCloud) PhotoCloud.renderUI(); // 刷新照片云备份区域
  document.getElementById('settingsMask').classList.add('show');
}

function closeSettings() {
  document.getElementById('settingsMask').classList.remove('show');
}

// 渲染设置里的标签（chip）
function renderChips(which) {
  const box = document.getElementById(which === 'store' ? 'storeEditor' : 'timeEditor');
  const list = which === 'store' ? settings.stores : settings.timeSlots;
  box.innerHTML = '';
  list.forEach((val, idx) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = val;
    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '×';
    del.addEventListener('click', () => {
      list.splice(idx, 1);
      renderChips(which);
    });
    chip.appendChild(del);
    box.appendChild(chip);
  });
}

function addChip(which) {
  const input = document.getElementById(which === 'store' ? 'storeInput' : 'timeInput');
  const val = input.value.trim();
  if (!val) return;
  const list = which === 'store' ? settings.stores : settings.timeSlots;
  if (!list.includes(val)) {
    list.push(val);
    renderChips(which);
    toast('已添加');
  } else {
    toast('已存在');
  }
  input.value = '';
}

function saveSettingsAll() {
  const singer = document.getElementById('setSinger').value.trim();
  const year = Number(document.getElementById('setYear').value);

  if (!singer) { toast('歌手名称不能为空'); return; }
  if (!year || year < 2000 || year > 2099) { toast('年份无效'); return; }
  if (settings.stores.length === 0) { toast('至少保留一个门店'); return; }
  if (settings.timeSlots.length === 0) { toast('至少保留一个时间段'); return; }

  settings.singer = singer;
  // 年份变化 → 视图跟随
  if (year !== settings.year) {
    settings.year = year;
    viewYear = year;
  }
  saveSettings();
  closeSettings();
  renderAll();
  toast('设置已保存 ✓');
}

function resetSettings() {
  const keepYear = settings.year;
  const keepSinger = settings.singer;
  settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.year = keepYear;
  settings.singer = keepSinger;
  saveSettings();
  openSettings(); // 重新渲染弹窗
  renderAll();
  toast('已恢复默认门店/时间段');
}

/* ---------- 9. 导出本月排班（CSV） ---------- */

function exportMonth() {
  // 筛选门店时只导出该门店当月数据
  const ms = monthShifts()
    .filter(s => !filterStore || s.store === filterStore)
    .sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot);
  if (ms.length === 0) {
    toast(filterStore ? filterStore + ' 本月暂无排班，无需导出' : '本月还没有登记，无需导出');
    return;
  }

  const rows = [['日期', '星期', '场次', '门店', '时间段', '备注']];
  ms.forEach(s => {
    const [y, m, d] = s.date.split('-').map(Number);
    const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
    rows.push([y + '年' + m + '月' + d + '日', '星期' + week, '场次' + s.slot, s.store, s.time, s.note || '']);
  });

  const csv = '\uFEFF' + rows.map(r => r.map(c => '"' + (c || '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  if (filterStore) {
    a.download = settings.singer + '_' + viewYear + '年' + (viewMonth + 1) + '月_' + filterStore + '排班.csv';
  } else {
    a.download = settings.singer + '_' + viewYear + '年' + (viewMonth + 1) + '月排班.csv';
  }
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast(filterStore ? '已导出 ' + filterStore + ' 当月排班 CSV' : '已导出本月排班 CSV');
}

/* ---------- 10. 到点提醒 ---------- */

function updateRemindUI() {
  const el = document.getElementById('remindToggle');
  el.classList.toggle('on', remindOn);
  el.classList.toggle('off', !remindOn);
}

async function toggleRemind() {
  if (!remindOn) {
    if (!('Notification' in window)) { toast('当前浏览器不支持通知'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('未获得通知权限，请允许后再试'); return; }
  }
  remindOn = !remindOn;
  localStorage.setItem(REMIND_KEY, remindOn ? '1' : '0');
  updateRemindUI();
  toast(remindOn ? '提醒已开启 🔔' : '提醒已关闭');
  if (remindOn) startRemindLoop(); else stopRemindLoop();
}

function startRemindLoop() {
  stopRemindLoop();
  remindTimer = setInterval(checkReminders, 20 * 1000);
  checkReminders();
}

function stopRemindLoop() {
  if (remindTimer) { clearInterval(remindTimer); remindTimer = null; }
}

function checkReminders() {
  if (!remindOn || !('Notification' in window)) return;
  const now = new Date();
  const today = todayStr();
  const curMin = now.getHours() * 60 + now.getMinutes();

  // 找出今天的时间段，解析开始时间（如 "23:30-00:10" → 23:30）提醒
  dayShifts(today).forEach(s => {
    if (!s.time) return;
    const startStr = s.time.split('-')[0].trim();
    const m = startStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    const startMin = Number(m[1]) * 60 + Number(m[2]);
    // 到点前后 1 分钟内提醒一次（内存标记，不写入存储、不触发同步）
    const flag = s.id + '|' + today;
    if (Math.abs(curMin - startMin) <= 1 && !notifiedSet.has(flag)) {
      notifiedSet.add(flag);
      try {
        new Notification('🔔 ' + s.time + ' ' + s.store, {
          body: '场次' + s.slot + ' · ' + s.store + (s.note ? '\n' + s.note : ''),
          icon: 'icons/icon-512.png'
        });
      } catch (e) { /* 忽略 */ }
    }
  });
}

/* ---------- 11. 统一刷新 ---------- */

function renderAll() {
  renderHeader();
  renderCalendar();
  renderList();
  renderStoreFilter();
  renderStoreDates();
  renderStats();
}

/* ---------- 11.5 初始数据导入（Excel 8月排班） ---------- */

// 把 seed-august.js 提供的 8 月排班合并进本地数据。
// 已存在"同日期+同场次"的记录（含已删除的墓碑）会跳过：
// 不会覆盖用户自己录的数据，已删除的也不会被"复活"。
// id 采用确定性规则（seed-日期-场次），保证每台设备导入后 id 一致，同步不重复。
function importSeedShifts() {
  const seed = window.AUGUST_SEED;
  if (!Array.isArray(seed) || seed.length === 0) return 0;

  let added = 0;
  seed.forEach(s => {
    if (!s || !s.date || !s.store) return;
    const dup = shifts.find(x => x.date === s.date && x.slot === s.slot);
    if (dup) return; // 该日期该场次已登记（或已删除）→ 跳过
    shifts.push({
      id: 'seed-' + s.date + '-' + s.slot,
      date: s.date,
      slot: s.slot,
      store: s.store,
      time: s.time || '',
      note: s.note || '',
      updatedAt: 0
    });
    added++;
  });

  if (added > 0) saveShifts();
  return added;
}

/* ---------- 12. 事件绑定与启动 ---------- */

document.getElementById('prevMonth').addEventListener('click', () => {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear = settings.year; }
  renderAll();
});

document.getElementById('nextMonth').addEventListener('click', () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear = settings.year; }
  renderAll();
});

// 回到今天
document.getElementById('todayBtn').addEventListener('click', () => {
  const now = new Date();
  viewYear = settings.year;
  viewMonth = now.getMonth();
  selectedDate = todayStr();
  renderAll();
});

// 添加场次（悬浮按钮）：跳到当天，若当天已满提示
document.getElementById('addBtn').addEventListener('click', () => {
  if (dayShifts(selectedDate).length >= 3) {
    toast('当天 3 场已满，最多登记 3 场');
    return;
  }
  openModal(null);
});

// 场次选择
document.querySelectorAll('.slot-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    currentSlot = Number(btn.dataset.slot);
    highlightSlot();
  });
});

// 自定义门店 / 时间段
document.getElementById('customStoreBtn').addEventListener('click', () => showCustomInput('store'));
document.getElementById('customTimeBtn').addEventListener('click', () => showCustomInput('time'));

// 弹窗按钮
document.getElementById('saveBtn').addEventListener('click', handleSave);
document.getElementById('cancelBtn').addEventListener('click', closeModal);
document.getElementById('deleteBtn').addEventListener('click', handleDelete);
document.getElementById('modalMask').addEventListener('click', (ev) => {
  if (ev.target === document.getElementById('modalMask')) closeModal();
});

// 设置
document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('settingsSave').addEventListener('click', saveSettingsAll);
document.getElementById('settingsReset').addEventListener('click', resetSettings);
document.getElementById('settingsMask').addEventListener('click', (ev) => {
  if (ev.target === document.getElementById('settingsMask')) closeSettings();
});
document.getElementById('storeAddBtn').addEventListener('click', () => addChip('store'));
document.getElementById('timeAddBtn').addEventListener('click', () => addChip('time'));
document.getElementById('storeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addChip('store'); });
document.getElementById('timeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addChip('time'); });

// 导出本月排班（按钮已在 HTML 中内置）
document.getElementById('exportBtn').addEventListener('click', exportMonth);

// 统计时段切换（全月 / 1-10日 / 11-25日）
document.querySelectorAll('#statPeriodTabs .stat-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    statPeriod = btn.dataset.period || 'all';
    document.querySelectorAll('#statPeriodTabs .stat-tab').forEach(b => {
      b.classList.toggle('active', b === btn);
    });
    renderStats();
  });
});

// 提醒开关
document.getElementById('remindToggle').addEventListener('click', toggleRemind);

// 演出记录面板
document.getElementById('recordCloseBtn').addEventListener('click', closeRecord);
document.getElementById('recordSaveBtn').addEventListener('click', saveRecordAndClose);
document.getElementById('recordMask').addEventListener('click', (ev) => {
  if (ev.target === document.getElementById('recordMask')) closeRecord();
});
document.getElementById('photoFileInput').addEventListener('change', (ev) => {
  if (ev.target.files && ev.target.files.length > 0) handlePhotoFiles(ev.target.files);
  ev.target.value = ''; // 允许重复选择同一张图
});
document.getElementById('songInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addSongFromInput(); }
});
document.getElementById('recordNoteInput').addEventListener('change', () => {
  // 备注即时保存（失焦时）
  const rec = records[recordCtx.date] && records[recordCtx.date][recordCtx.slot];
  if (rec && !rec.deleted) {
    const txt = document.getElementById('recordNoteInput').value.trim();
    if (txt !== (rec.note || '')) {
      rec.note = txt;
      rec.updatedAt = Date.now();
      saveRecords();
    }
  }
});

// 照片全屏查看：点任意处关闭
document.getElementById('photoViewer').addEventListener('click', () => {
  document.getElementById('photoViewer').classList.remove('show');
});

// 页面进入前台时检查提醒
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkReminders();
});

// 注册 Service Worker（离线可用 + 可安装到桌面）
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// 启动
updateRemindUI();

// 启动时导入 Excel 里的 8 月排班（自动跳过已登记的同日期+同场次）
const importedCount = importSeedShifts();

renderAll();
if (remindOn) startRemindLoop();
// 云同步由 sync.js 自行启动（它在本文件之后加载）

// 照片云备份：启动时补传待上传照片；网络恢复时再试
setTimeout(() => { if (window.uploadPendingPhotos) uploadPendingPhotos(); }, 2500);
window.addEventListener('online', () => {
  if (window.uploadPendingPhotos) setTimeout(uploadPendingPhotos, 1500);
});

// 导入完成提示（等页面渲染完再显示，避免被其他 toast 覆盖）
if (importedCount > 0) {
  setTimeout(() => toast('已导入 8 月排班 ' + importedCount + ' 场 ✓'), 600);
}
