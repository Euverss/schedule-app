/* =========================================================
   哲恒排班登记 - 演出记录照片存储（IndexedDB）
   ---------------------------------------------------------
   照片（现场照片）保存在浏览器本地数据库 IndexedDB：
   - 容量大（通常几百 MB），不受 localStorage 5MB 限制
   - 不参与云同步（云端 Gist 单文件约 1MB，放不下照片）
   - 添加时自动压缩（最长边 1280px、JPEG 质量 0.72，
     单张约 150~250KB），保证多存不臃肿
   ========================================================= */

const PhotoDB = (() => {
  const DB_NAME = 'schedule-photos';
  const STORE   = 'photos';
  const MAX_SIDE = 1280;   // 压缩后最长边
  const QUALITY = 0.72;     // JPEG 质量

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  // 存一张照片（覆盖同 id）
  async function add(id, blob) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ id: id, blob: blob, createdAt: Date.now() });
      tx.oncomplete = () => resolve(id);
      tx.onerror = () => reject(tx.error);
    });
  }

  // 取一张照片 → Blob（不存在返回 null）
  async function get(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  }

  // 删除一张照片（不存在也静默成功）
  async function remove(id) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // 压缩图片：File/Blob → 压缩后的 JPEG Blob
  // 浏览器解码时自动应用 EXIF 方向，无需手动处理
  function compress(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          b => (b ? resolve(b) : reject(new Error('压缩失败'))),
          'image/jpeg',
          QUALITY
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  function newId() {
    return 'ph-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  return { add, get, remove, compress, newId };
})();

window.PhotoDB = PhotoDB;
