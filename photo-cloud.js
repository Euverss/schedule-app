/* =========================================================
   哲恒排班登记 - 照片云备份（GitHub 私有仓库）
   ---------------------------------------------------------
   原理：照片存为你 GitHub 账号里的私有仓库
   Euverss/schedule-photos（仅自己可见）：

   - 绑定一个带「仓库」权限的 Token（和同步 Token 分开）
   - 绑定后自动上传：
       · 添加照片 → 压缩 → 先存本机 IndexedDB →
         后台静默上传到私有仓库 → 链接随排班数据云同步
       · 断网时照片留在本机，联网后自动补传
   - 两台设备都绑定后，都能看到对方的照片
     （首次查看从云端拉取，之后缓存在本机）
   - 删除照片时同时删除云端文件，不留垃圾

   容量：仓库单文件上限 100MB、总容量宽松，
   一张压缩后约 200KB，足够存很多年。
   ========================================================= */

const PhotoCloud = (() => {
  const PHOTO_TOKEN_KEY = 'schedule.photoToken';
  const PHOTO_REPO_KEY  = 'schedule.photoRepo';   // "owner/schedule-photos"
  const REPO_NAME = 'schedule-photos';
  const BRANCH = 'main';
  const API = 'https://api.github.com';
  const RAW = 'https://raw.githubusercontent.com';

  let token = localStorage.getItem(PHOTO_TOKEN_KEY) || '';
  let repo  = localStorage.getItem(PHOTO_REPO_KEY)  || '';
  let state = 'idle';    // idle | busy | ok | error
  let error = '';

  function configured() { return !!(token && repo); }

  /* ---------- 内部：GitHub API ---------- */

  async function api(method, path, body) {
    const resp = await fetch(API + path, {
      method: method,
      headers: {
        'Authorization': 'Bearer ' + token,
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

  /* ---------- 内部：blob ↔ base64 ---------- */

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(new Error('读取照片失败'));
      fr.readAsDataURL(blob);
    });
  }

  /* ---------- 对外：上传 / 读取 / 删除 ---------- */

  // 上传一张照片 → 返回云端路径
  async function upload(blob, path) {
    const content = await blobToBase64(blob);
    await api('PUT', '/repos/' + repo + '/contents/' + path, {
      message: 'photo: ' + path,
      content: content
    });
    return path;
  }

  // 从云端拉取一张照片 → Blob（失败返回 null）
  async function fetchBlob(path) {
    try {
      const resp = await fetch(RAW + '/' + repo + '/' + BRANCH + '/' + path, {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (!resp.ok) return null;
      return resp.blob();
    } catch (e) {
      return null;
    }
  }

  // 删除云端照片（需要先查 sha；失败静默返回 false）
  async function remove(path) {
    try {
      const meta = await api('GET', '/repos/' + repo + '/contents/' + path);
      if (!meta || !meta.sha) return false;
      await api('DELETE', '/repos/' + repo + '/contents/' + path, {
        message: 'delete: ' + path,
        sha: meta.sha
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  // 照片在仓库里的路径：photos/2026-08/2026-08-31-1-phxxx.jpg
  function photoPath(date, slot, id) {
    const ym = (date || '').slice(0, 7) || 'unknown';
    return 'photos/' + ym + '/' + date + '-' + slot + '-' + id + '.jpg';
  }

  /* ---------- 对外：绑定 / 解绑 ---------- */

  async function bind(newToken) {
    newToken = (newToken || '').trim();
    if (!newToken) { error = '请先粘贴 Token'; return null; }

    state = 'busy';
    renderUI();

    try {
      // 1) 验证 Token
      const uResp = await fetch(API + '/user', {
        headers: { 'Authorization': 'Bearer ' + newToken }
      });
      if (!uResp.ok) throw new Error('Token 无效（需要仓库权限）');
      const user = await uResp.json();

      // 2) 确认照片仓库存在；不存在则自动创建（私有）
      const rResp = await fetch(API + '/repos/' + user.login + '/' + REPO_NAME, {
        headers: { 'Authorization': 'Bearer ' + newToken }
      });
      if (rResp.status === 404) {
        const cResp = await fetch(API + '/user/repos', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + newToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            name: REPO_NAME,
            private: true,
            description: 'schedule-app photo backup (auto managed)',
            auto_init: true
          })
        });
        if (!cResp.ok) throw new Error('无法创建照片仓库（Token 需要仓库权限）');
      } else if (!rResp.ok) {
        throw new Error('无法访问照片仓库');
      }

      // 3) 保存绑定
      token = newToken;
      repo = user.login + '/' + REPO_NAME;
      localStorage.setItem(PHOTO_TOKEN_KEY, token);
      localStorage.setItem(PHOTO_REPO_KEY, repo);

      state = 'ok';
      error = '';
      renderUI();
      return repo;
    } catch (e) {
      state = 'error';
      error = e.message || '绑定失败';
      renderUI();
      return null;
    }
  }

  function unbind() {
    token = '';
    repo = '';
    state = 'idle';
    error = '';
    localStorage.removeItem(PHOTO_TOKEN_KEY);
    localStorage.removeItem(PHOTO_REPO_KEY);
    renderUI();
    if (window.toast) toast('已解绑照片云备份，照片仍保存在本机');
  }

  /* ---------- 对外：设置面板 UI ---------- */

  function renderUI() {
    const box = document.getElementById('photoBox');
    if (!box) return;
    box.innerHTML = '';

    if (!configured()) {
      if (error) {
        const errLine = document.createElement('div');
        errLine.className = 'sync-state err';
        errLine.textContent = '⚠ ' + error;
        box.appendChild(errLine);
      }
      const row = document.createElement('div');
      row.className = 'sync-row';
      const input = document.createElement('input');
      input.type = 'password';
      input.id = 'photoTokenInput';
      input.placeholder = '粘贴带仓库权限的 GitHub Token';
      input.autocomplete = 'off';
      row.appendChild(input);
      const btn = document.createElement('button');
      btn.className = 'mini-btn';
      btn.textContent = '绑定';
      btn.addEventListener('click', async () => {
        const t = document.getElementById('photoTokenInput').value;
        const r = await bind(t);
        if (r) {
          toast('照片云备份已绑定 ✓');
          // 立即补传本机待上传照片
          if (window.uploadPendingPhotos) setTimeout(uploadPendingPhotos, 600);
        } else {
          toast('照片云绑定失败，请检查 Token');
        }
      });
      row.appendChild(btn);
      box.appendChild(row);

      const help = document.createElement('div');
      help.className = 'sync-help';
      help.innerHTML =
        '绑定后每场演出的照片自动上传到你的 GitHub 私有仓库，<b>两台设备都能看到</b>。' +
        '<a href="https://github.com/settings/tokens/new?scopes=repo&description=排班照片云备份" target="_blank" rel="noopener">点此创建 Token</a>（选 repo 权限）。';
      box.appendChild(help);
      return;
    }

    // —— 已绑定 ——
    const stateLine = document.createElement('div');
    stateLine.className = 'sync-state ' + (state === 'error' ? 'err' : 'ok');
    stateLine.textContent = '✓ 已绑定 ' + repo + '（私有）';
    box.appendChild(stateLine);

    const row = document.createElement('div');
    row.className = 'sync-row';
    const unBtn = document.createElement('button');
    unBtn.className = 'mini-btn sync-unbind';
    unBtn.textContent = '解绑';
    unBtn.addEventListener('click', unbind);
    row.appendChild(unBtn);
    box.appendChild(row);

    const help = document.createElement('div');
    help.className = 'sync-help';
    help.textContent = '照片保存在你自己的 GitHub 私有仓库（仅自己可见）· 每台设备都要绑定 · 断网时照片先存本机，联网自动补传';
    box.appendChild(help);
  }

  return {
    configured, upload, fetchBlob, remove, photoPath, bind, unbind, renderUI,
    get repo() { return repo; }
  };
})();

window.PhotoCloud = PhotoCloud;
