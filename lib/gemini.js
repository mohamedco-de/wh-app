// محادثة مع Gemini (نص + صورة اختيارية) مع ذاكرة قصيرة لكل محادثة
const { UserError } = require('./errors');

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MAX_TURNS = 8; // عدد الأدوار المحفوظة لكل محادثة
const SYSTEM = 'أنت مساعد ذكي داخل واتساب. رد بنفس لغة المستخدم، باختصار ووضوح، وبدون تنسيق markdown ثقيل.';

const histories = new Map(); // chatId -> [{role, parts:[{text}]}]

function reset(chatId) { histories.delete(chatId); }

async function ask(chatId, text, image /* {buffer, mime} اختياري */) {
  if (!API_KEY) throw new UserError('مفتاح GEMINI_API_KEY غير موجود في ملف .env');

  const history = histories.get(chatId) || [];
  const parts = [];
  if (image) parts.push({ inlineData: { mimeType: image.mime, data: image.buffer.toString('base64') } });
  parts.push({ text: text || 'صف لي هذه الصورة.' });

  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [...history, { role: 'user', parts }],
        generationConfig: { maxOutputTokens: 2000 },
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new UserError('تعذر الاتصال بـ Gemini، جرب مرة ثانية.');
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.warn('[gemini]', res.status, json?.error?.message || '');
    if (res.status === 429) throw new UserError('Gemini مشغول أو وصلت حد الاستخدام، جرب بعد شوي.');
    if (res.status === 400 || res.status === 403) throw new UserError('مفتاح Gemini غير صالح أو الطلب مرفوض.');
    throw new UserError('Gemini رجّع خطأ، جرب مرة ثانية.');
  }

  const reply = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!reply) {
    const why = json?.promptFeedback?.blockReason;
    throw new UserError(why ? 'Gemini رفض الرد على هذا الطلب.' : 'ما جاني رد من Gemini.');
  }

  // نحفظ النص فقط (بدون بيانات الصورة) لتوفير الذاكرة
  history.push({ role: 'user', parts: [{ text: image ? `[صورة] ${text || ''}` : text }] });
  history.push({ role: 'model', parts: [{ text: reply }] });
  while (history.length > MAX_TURNS * 2) history.shift();
  histories.set(chatId, history);
  return reply;
}

module.exports = { ask, reset };
