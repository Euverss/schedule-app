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

// 当前设置
let settings = Object.assign(
  {}, DEFAULT_SETTINGS,
  safeParse(localStorage.getItem(SETTINGS_KEY))
);

// 所有场次：{ id, date:"YYYY-MM-DD", slot:1|2|3, store, time, note }
let shifts = safeParse(localStorage.getItem(SHIFTS_KEY)) || [];

// 当前视图月份
let viewYear  = settings.year;
let viewMonth = new Date().getMonth(); // 0-11，默认打开当前月
let selectedDate = todayStr();
let editingId = null;   // 正在编辑的场次 id
let remindOn = localStorage.getItem(REMIND_KEY) === '1';
let remindTimer = null;

/* ---------- 2. 工具函数 ---------- */

function safeParse(str) {
  try { return JSON.parse(str); } catch (e) { return null; }
}

function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }
function saveShifts()   { localStorage.setItem(SHIFTS_KEY, JSON.stringify(shifts)); }

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// '2026-08-25' → '8月25日 星期二'
function formatDateCN(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()];
  return m + '月' + d + '日 星期' + week;
}

// 当前视图月份的标识 '2026-08'
function viewMonthKey() {
  return viewYear + '-' + pad(viewMonth + 1);
}

// 当月场次
function monthShifts() {
  const prefix = viewMonthKey() + '-';
  return shifts.filter(s => s.date.startsWith(prefix));
}

// 某天的场次
function dayShifts(dateStr) {
  return shifts.filter(s => s.date === dateStr);
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
  document.getElementById('headerDate').textContent = '年份 ' + settings.year + ' · 数据保存在本机';
  document.getElementById('calTitle').textContent = viewYear + '年' + (viewMonth + 1) + '月';

  const ms = monthShifts();
  document.getElementById('calSub').textContent = '本月已登记 ' + ms.length + ' 场';
}

/* ---------- 4. 月历渲染 ---------- */

function renderCalendar() {
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();

  // 本月每天场次数（用于显示圆点）
  const countMap = {};
  monthShifts().forEach(s => {
    const d = Number(s.date.slice(8, 10));
    countMap[d] = (countMap[d] || 0) + 1;
  });

  // 上个月补位
  for (let i = firstDay - 1; i >= 0; i--) {
    const d = prevMonthDays - i;
    const dateStr = new Date(viewYear, viewMonth - 1, d).toISOString().slice(0, 10);
    grid.appendChild(dayCell(dateStr, true, 0));
  }

  // 本月
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = viewYear + '-' + pad(viewMonth + 1) + '-' + pad(d);
    grid.appendChild(dayCell(dateStr, false, countMap[d] || 0));
  }

  // 下个月补位
  const nextCount = 7 - (grid.children.length % 7);
  if (nextCount < 7) {
    for (let d = 1; d <= nextCount; d++) {
      const dateStr = new Date(viewYear, viewMonth + 1, d).toISOString().slice(0, 10);
      grid.appendChild(dayCell(dateStr, true, 0));
    }
  }
}

function dayCell(dateStr, otherMonth, count) {
  const cell = document.createElement('div');
  cell.className = 'cal-day' + (otherMonth ? ' other-month' : '');

  const num = document.createElement('span');
  num.className = 'day-num';
  num.textContent = Number(dateStr.slice(8, 10));
  cell.appendChild(num);

  if (isToday(dateStr)) cell.classList.add('today');
  if (dateStr === selectedDate) cell.classList.add('selected');
  if (count > 0) {
    cell.classList.add('has-event');
    const dots = document.createElement('span');
    dots.className = 'dots';
    // 最多显示 3 个圆点
    for (let i = 0; i < Math.min(count, 3); i++) {
      const dot = document.createElement('span');
      dot.className = 'dot';
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

/* ---------- 6. 统计面板 ---------- */

function renderStats() {
  const ms = monthShifts();
  const total = ms.length;

  // Hero 大数字（场次总数）
  document.getElementById('statTotal').textContent = total;

  // 环形图与中心数字
  const donut = document.getElementById('statDonut');
  document.getElementById('statDonutCenter').textContent = total;

  const grid = document.getElementById('statGrid');
  grid.innerHTML = '';

  if (total === 0) {
    donut.style.background = 'var(--line)';
    const empty = document.createElement('div');
    empty.className = 'stat-empty';
    empty.textContent = '本月暂无登记，快去添加场次吧';
    grid.appendChild(empty);
    return;
  }

  // 统计各门店场次
  const storeColors = ['var(--store-1)', 'var(--store-2)', 'var(--store-3)', 'var(--store-4)'];
  const stats = {};
  ms.forEach(s => { stats[s.store] = (stats[s.store] || 0) + 1; });
  const storeNames = Object.keys(stats);

  // 环形图：按门店占比生成 conic-gradient
  let acc = 0;
  const stops = storeNames.map((store, idx) => {
    const pct = (stats[store] / total) * 100;
    const from = acc;
    acc += pct;
    const color = storeColors[idx % storeColors.length];
    return color + ' ' + from.toFixed(1) + '% ' + acc.toFixed(1) + '%';
  });
  donut.style.background = 'conic-gradient(' + stops.join(', ') + ')';

  // 各门店进度条
  storeNames.forEach((store, idx) => {
    const row = document.createElement('div');
    row.className = 'stat-bar-row';

    const dot = document.createElement('div');
    dot.className = 'stat-dot';
    dot.style.background = storeColors[idx % storeColors.length];
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
    fill.style.background = storeColors[idx % storeColors.length];
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
      e.date = date; e.slot = currentSlot; e.store = store; e.time = time; e.note = note;
    }
  } else {
    // 新增：检查当天该场次是否冲突
    const dup = shifts.find(x => x.date === date && x.slot === currentSlot);
    if (dup) { toast('场次 ' + currentSlot + ' 当天已登记，请选择其他场次'); return; }
    // 检查当天是否满 3 场
    if (dayShifts(date).length >= 3) {
      toast('当天 3 场已满，最多登记 3 场');
      return;
    }
    shifts.push({
      id: newId(),
      date, slot: currentSlot, store, time, note
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
  shifts = shifts.filter(x => x.id !== editingId);
  saveShifts();
  closeModal();
  renderAll();
  toast('已删除');
}

/* ---------- 8. 设置弹窗 ---------- */

function openSettings() {
  document.getElementById('setSinger').value = settings.singer;
  document.getElementById('setYear').value = settings.year;
  renderChips('store');
  renderChips('time');
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
  const ms = monthShifts().sort((a, b) => a.date.localeCompare(b.date) || a.slot - b.slot);
  if (ms.length === 0) { toast('本月还没有登记，无需导出'); return; }

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
  a.download = settings.singer + '_' + viewYear + '年' + (viewMonth + 1) + '月排班.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  toast('已导出本月排班 CSV');
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
    // 到点前后 1 分钟内提醒一次（用 s._notified 标记）
    if (Math.abs(curMin - startMin) <= 1 && !s._notified) {
      s._notified = true;
      saveShifts();
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
  renderStats();
}

/* ---------- 11.5 初始数据导入（Excel 8月排班） ---------- */

// 把 seed-august.js 提供的 8 月排班合并进本地数据。
// 已存在"同日期+同场次"的记录会跳过，不会覆盖用户自己录的数据。
function importSeedShifts() {
  const seed = window.AUGUST_SEED;
  if (!Array.isArray(seed) || seed.length === 0) return 0;

  let added = 0;
  seed.forEach(s => {
    if (!s || !s.date || !s.store) return;
    const dup = shifts.find(x => x.date === s.date && x.slot === s.slot);
    if (dup) return; // 该日期该场次已登记 → 跳过
    shifts.push({
      id: newId(),
      date: s.date,
      slot: s.slot,
      store: s.store,
      time: s.time || '',
      note: s.note || ''
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

// 提醒开关
document.getElementById('remindToggle').addEventListener('click', toggleRemind);

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

// 导入完成提示（等页面渲染完再显示，避免被其他 toast 覆盖）
if (importedCount > 0) {
  setTimeout(() => toast('已导入 8 月排班 ' + importedCount + ' 场 ✓'), 600);
}
