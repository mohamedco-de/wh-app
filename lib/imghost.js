// رفع الصور على هوست دائم: https://img.svif.cloud
const { UserError } = require('./errors');

const ENDPOINT = 'https://img.svif.cloud/api/upload';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// يرفع الصورة ويرجّع direct_url (مع محاولتين إضافيتين عند أخطاء الشبكة/السيرفر)
async function uploadImage(buffer, { mime = 'image/jpeg', filename } = {}) {
  if (!buffer || !buffer.length) throw new UserError('الصورة فاضية.');
  const name = filename || `image_${Date.now()}.${EXT[mime] || 'jpg'}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: mime }), name);
      const res = await fetch(ENDPOINT, { method: 'POST', body: form, signal: AbortSignal.timeout(45000) });

      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* ignore */ }

      if (res.status === 413) throw new UserError('الصورة كبيرة على الهوست.');
      if (res.status >= 500) { lastErr = new Error(`host HTTP ${res.status}`); await sleep(1500 * attempt); continue; }
      if (!res.ok || !json || json.success === false) {
        throw new UserError(`فشل الرفع${json?.error || json?.message ? ` (${json.error || json.message})` : ''}.`);
      }
      const link = json.direct_url || json.url;
      if (!link) throw new UserError('الهوست ما رجّع رابط.');
      return link;
    } catch (e) {
      if (e.safe) throw e;           // أخطاء نهائية ما نعيدها
      lastErr = e;                    // شبكة / مهلة: نعيد
      await sleep(1500 * attempt);
    }
  }
  console.warn('[imghost]', lastErr?.message);
  throw new UserError('تعذر الرفع على الهوست، جرب مرة ثانية.');
}

module.exports = { uploadImage };
