// إزالة الخلفية عبر remove.bg
const { UserError } = require('./errors');

const API_KEY = process.env.REMOVEBG_API_KEY || '';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

// يرجّع Buffer لصورة PNG بخلفية شفافة
async function removeBackground(buffer, mime = 'image/jpeg') {
  if (!API_KEY) throw new UserError('مفتاح REMOVEBG_API_KEY غير موجود في ملف .env');

  const form = new FormData();
  form.append('image_file', new Blob([buffer], { type: mime }), `image.${EXT[mime] || 'jpg'}`);
  form.append('size', 'auto');
  form.append('format', 'png');

  let res;
  try {
    res = await fetch('https://api.remove.bg/v1.0/removebg', {
      method: 'POST',
      headers: { 'X-Api-Key': API_KEY },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new UserError('تعذر الاتصال بخدمة إزالة الخلفية، جرب مرة ثانية.');
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).errors?.[0]?.title || ''; } catch { /* ignore */ }
    console.warn('[removebg]', res.status, detail);
    if (res.status === 402) throw new UserError('رصيد remove.bg خلص.');
    if (res.status === 403) throw new UserError('مفتاح remove.bg غير صحيح.');
    if (res.status === 429) throw new UserError('طلبات كثيرة، انتظر شوي وجرب.');
    throw new UserError(`ما قدرت أزيل الخلفية${detail ? ` (${detail})` : ''}.`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { removeBackground };
