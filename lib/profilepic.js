// صورة بروفايل بأبعادها الأصلية (بدون قص ولا خلفية ولا هوامش).
//
// لماذا لا نستخدم sock.updateProfilePicture؟
//   دالة Baileys الرسمية تمرّر الصورة إلى generateProfilePicture اللي تقصّها إلى مربع (min(w,h)) وتصغّرها 640x640،
//   فالصورة الطولية تنقص. الحل هنا: نجهّز الـ JPEG بأنفسنا (بدون قص) ونرسل نفس عقدة الـ IQ اللي ترسلها المكتبة
//   مباشرة عبر sock.query (دالة موجودة في السوكيت نفسه).
//
// المعالجة بـ ffmpeg (مثبّت أصلاً في install.sh) — ما نضيف أي حزمة جديدة.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { S_WHATSAPP_NET, jidNormalizedUser } = require('@whiskeysockets/baileys');
const { UserError } = require('./errors');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
// أطول ضلع بالبكسل (لا نقص ولا نضيف حواف أبداً؛ النسبة تبقى كما هي)
const MAX_SIDE = Number(process.env.SETPP_MAX_SIDE) || 1280;
const MIN_SIDE = 320;                // الصور الأصغر من هذا نكبّرها (بنفس النسبة) عشان واتساب يقبلها
// لو رفض السيرفر مقاساً نجرّب الأصغر منه تلقائياً (دائماً بدون قص)
const SIDES = [...new Set([MAX_SIDE, 1024, 720, 512, 320].filter((x) => x <= MAX_SIDE))];
const TARGET_BYTES = 600 * 1024;     // نحاول نبقى تحت هذا الحجم

const run = (bin, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = stderr; return reject(err); }
    resolve(stdout);
  });
});

// ---------------------------------------------------------------- نوع الملف + اتجاه EXIF
function sniffExt(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.length > 8 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 3 && buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf.length > 2 && buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

// يقرأ وسم Orientation (0x0112) من EXIF داخل JPEG. يرجّع 1..8 (1 = بدون تدوير)
function readExifOrientation(buf) {
  if (!(buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8)) return 1;
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) { off++; continue; }
    const marker = buf[off + 1];
    if (marker === 0xff) { off++; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break; // بداية بيانات الصورة
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString('latin1', off + 4, off + 10) === 'Exif\0\0') {
      const t = off + 10; // بداية TIFF
      if (t + 8 > buf.length) return 1;
      const le = buf.toString('latin1', t, t + 2) === 'II';
      const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
      const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
      try {
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (e + 12 > buf.length) break;
          if (u16(e) === 0x0112) {
            const v = u16(e + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
      } catch { /* EXIF تالف: نتجاهله */ }
      return 1;
    }
    off += 2 + len;
  }
  return 1;
}

// فلتر ffmpeg لكل اتجاه EXIF (بدون قص، تدوير/قلب فقط)
const ORIENT_FILTER = {
  1: null,
  2: 'hflip',
  3: 'hflip,vflip',
  4: 'vflip',
  5: 'transpose=0',
  6: 'transpose=1',
  7: 'transpose=3',
  8: 'transpose=2',
};

// ---------------------------------------------------------------- تجهيز الصورة (بدون قص)
// يقبل أي صيغة يفهمها ffmpeg (JPG/PNG/WebP/GIF/BMP/TIFF/HEIC/AVIF...) وأي أبعاد (بانر، خلفية، طولية، صغيرة، ضخمة).
// يرجّع { jpeg: Buffer, width, height }
function targetSize(w, h, side) {
  const long = Math.max(w, h);
  const k = long > side ? side / long : long < MIN_SIDE ? MIN_SIDE / long : 1;
  return { W: Math.max(1, Math.round(w * k)), H: Math.max(1, Math.round(h * k)) };
}

async function prepareFullImage(input, { maxSide = MAX_SIDE, square = false } = {}) {
  if (!input || !input.length) throw new UserError('الصورة فارغة.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setpp-'));
  try {
    const inFile = path.join(dir, `in.${sniffExt(input) || 'img'}`);   // ffmpeg يتعرف على الصيغة من المحتوى
    fs.writeFileSync(inFile, input);
    const orient = readExifOrientation(input);

    let src;
    try { src = await probeSize(inFile); } catch (e) {
      if (e.code === 'ENOENT') throw new UserError('ffmpeg/ffprobe غير مثبّت على السيرفر.');
      throw new UserError('تعذّر قراءة الصورة، جرب صورة ثانية.');
    }
    let { width: w, height: h } = src;
    if (orient >= 5) [w, h] = [h, w];                 // التدوير بـ 90° يبدّل الطول والعرض
    const { W, H } = targetSize(w, h, maxSide);

    let best = null;
    for (const q of [2, 5, 9]) {
      const outFile = path.join(dir, `out_${q}.jpg`);
      const filters = [
        ORIENT_FILTER[orient],
        // وضع التشخيص فقط (.setpp test): قص مربع مركزي 640x640
        square ? "crop='min(iw,ih)':'min(iw,ih)',scale=640:640" : `scale=${W}:${H}:flags=lanczos`,
        'format=yuvj420p',
      ].filter(Boolean).join(',');
      try {
        await run(FFMPEG, ['-v', 'error', '-y', '-noautorotate', '-i', inFile, '-frames:v', '1', '-vf', filters, '-q:v', String(q), outFile]);
      } catch (e) {
        if (e.code === 'ENOENT') throw new UserError('ffmpeg غير مثبّت على السيرفر.');
        throw new UserError('تعذّر معالجة الصورة، جرب صورة ثانية.');
      }
      best = { jpeg: fs.readFileSync(outFile), outFile };
      if (best.jpeg.length <= TARGET_BYTES) break;
    }

    const size = await probeSize(best.outFile);
    return { jpeg: best.jpeg, width: size.width, height: size.height };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function probeSize(file) {
  const out = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ]);
  const [width, height] = out.trim().split(',').map(Number);
  if (!width || !height) throw new Error('probe failed');
  return { width, height };
}

// ---------------------------------------------------------------- الرفع (نفس عقدة Baileys لكن بدون قص)
// يرفع لحساب البوت نفسه (بدون target) — هذا الأمر مخصص للمالك فقط.
async function uploadOwnProfilePicture(sock, jpeg) {
  if (typeof sock.query !== 'function') throw new UserError('نسخة Baileys الحالية لا توفر sock.query.');
  const me = jidNormalizedUser(sock.user.id);
  // الشكل 1: مثل Baileys بالضبط (بدون target للحساب نفسه). الشكل 2: مع target = حسابك (احتياط لو رفض السيرفر الأول).
  const variants = [{ name: 'plain', extra: {} }, { name: 'target-self', extra: { target: me } }];
  let last = null;
  for (const v of variants) {
    try {
      await sock.query({
        tag: 'iq',
        attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture', ...v.extra },
        content: [{ tag: 'picture', attrs: { type: 'image' }, content: jpeg }],
      });
      if (v.name !== 'plain') console.log(`[setpp] نجح الرفع بالشكل: ${v.name}`);
      return;
    } catch (e) {
      const status = e?.data ?? e?.output?.statusCode;
      console.warn(`[setpp] الشكل ${v.name} رُفض: ${e?.message} (${status}) — حجم JPEG ${jpeg.length} بايت`);
      const err = new Error(e?.message || 'upload failed');
      err.rejected = status !== 428;            // 428 = انقطع الاتصال، مو رفض من السيرفر
      err.status = status;
      last = err;
      if (!err.rejected) break;
    }
  }
  throw last;
}

// للتشخيص فقط (.setpp official): الدالة الرسمية في Baileys. تقصّ الصورة لمربع 640، فلا تُستخدم للنتيجة النهائية.
// لو نجحت وحدها بينما طريقتنا ترفض => الفرق في بايتات الصورة أو شكل الطلب. لو رفضت أيضاً => المشكلة من الحساب/واتساب.
async function officialProfilePicture(sock, input) {
  if (typeof sock.updateProfilePicture !== 'function') throw new UserError('نسخة Baileys الحالية لا توفر updateProfilePicture.');
  try {
    await sock.updateProfilePicture(jidNormalizedUser(sock.user.id), input);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/image processing/i.test(msg)) throw new UserError('الدالة الرسمية تحتاج مكتبة معالجة صور. ثبّتها بـ: npm i jimp ثم أعد التشغيل وجرّب .setpp official');
    throw new UserError(`فشلت الدالة الرسمية أيضاً (${msg} ${e?.data ?? e?.output?.statusCode ?? ''}).`.replace(/\s+\)/, ')'));
  }
}

// ---------------------------------------------------------------- التحقق: ماذا خزّن واتساب فعلاً؟
// نجلب رابط صورة حسابنا من السيرفر ونقيس أبعادها ونقارن النسبة بالنسبة اللي رفعناها.
async function fetchServerSize(sock) {
  const me = jidNormalizedUser(sock.user.id);
  const url = await sock.profilePictureUrl(me, 'image');
  if (!url) return null;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setpp-v-'));
  try {
    const f = path.join(dir, `srv.${sniffExt(buf) || 'jpg'}`);
    fs.writeFileSync(f, buf);
    return await probeSize(f);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sameRatio = (a, b, tol = 0.03) => Math.abs(a.width / a.height - b.width / b.height) / (a.width / a.height) <= tol;

// الدالة الرئيسية. ترجّع تقريراً: { sent:{width,height}, server:{width,height}|null, preserved:true|false|null }
async function setFullProfilePicture(sock, input, { square = false } = {}) {
  let prepared = null;
  let lastErr = null;
  for (const side of (square ? [MAX_SIDE] : SIDES)) {
    prepared = await prepareFullImage(input, { maxSide: side, square });
    try {
      await uploadOwnProfilePicture(sock, prepared.jpeg);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      const code = `${e.message || ''} ${e.status || ''}`.trim();
      if (square) throw new UserError(`رفض واتساب حتى الصورة المربعة (${code}) — المشكلة في طريقة الإرسال وليست في الأبعاد.`);
      if (!e.rejected) throw new UserError(`فشل الرفع (${code}).`);
      console.warn(`[setpp] رفض السيرفر مقاس ${prepared.width}x${prepared.height}، أجرّب أصغر:`, code);
    }
  }
  if (lastErr) {
    const code = `${lastErr.message || ''} ${lastErr.status || ''}`.trim();
    throw new UserError(`رفض واتساب الصورة بكل المقاسات (${SIDES.join(' / ')}) (${code}). غالباً نسبة الأبعاد متطرفة جداً ولا يقبلها السيرفر بدون قص.`);
  }

  const sent = { width: prepared.width, height: prepared.height };
  let server = null;
  for (let i = 0; i < 3 && !server; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const s = await fetchServerSize(sock);
      // قد يرجع الرابط القديم لحظياً، فنكرر لو النسبة ما طابقت
      if (s && (sameRatio(s, sent) || i === 2)) server = s;
    } catch { /* التحقق اختياري */ }
  }
  return { sent, server, preserved: server ? sameRatio(server, sent) : null };
}

module.exports = { setFullProfilePicture, officialProfilePicture, prepareFullImage, readExifOrientation, sniffExt };
