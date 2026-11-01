// بوت واتساب: تحميل فيديوهات + إزالة خلفية + رفع صور + محادثة Gemini. ترسل رابط (تيك توك / انستا / تويتر / يوتيوب ...) والبوت يرسل الفيديو.
// الربط بكود (Pairing Code) بدون QR. التحميل: yt-dlp أولاً، ولو فشل يستخدم loader.to كاحتياط.
// تحميل ملف .env (PHONE=..., LOADER_API_KEY=...) بدون مكتبات
try {
  for (const line of require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const readline = require('readline');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState, DisconnectReason,
  fetchLatestBaileysVersion, Browsers, downloadMediaMessage, normalizeMessageContent,
} = require('@whiskeysockets/baileys');
const loader = require('./lib/loader');
const { removeBackground } = require('./lib/removebg');
const { uploadImage } = require('./lib/imghost');
const gemini = require('./lib/gemini');
const { UserError } = require('./lib/errors');

// ------------------------------------------------------------ الإعدادات
const PHONE = (process.env.PHONE || '').replace(/\D/g, '');   // رقمك بصيغة دولية بدون + (مثال 9665XXXXXXXX)
const MAX_MB = Number(process.env.MAX_MB) || 60;              // أكبر حجم نرسله
const VIDEO_LIMIT_MB = 15;                                    // فوق هذا يرسله كملف (document)
const MAX_SECONDS = Number(process.env.MAX_SECONDS) || 900;   // أطول فيديو (15 دقيقة)
const ALLOW_GROUPS = process.env.ALLOW_GROUPS === '1';        // يشتغل في القروبات؟ (افتراضي لا)
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

const SITES = /(^|\.)(tiktok\.com|instagram\.com|twitter\.com|x\.com|fixupx\.com|vxtwitter\.com|fxtwitter\.com|youtube\.com|youtu\.be|facebook\.com|fb\.watch|reddit\.com|redd\.it|snapchat\.com|threads\.net|threads\.com|pinterest\.com|pin\.it|twitch\.tv|streamable\.com|vimeo\.com)$/i;

function pickUrl(text) {
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s<>|]+/gi)) {
    const raw = m[0].replace(/[)\],.!?؟،]+$/, '');
    try {
      const u = new URL(raw);
      if (SITES.test(u.hostname)) return u.toString();
    } catch { /* ignore */ }
  }
  return null;
}

const textOf = (msg) => {
  const m = msg.message || {};
  return m.conversation || m.extendedTextMessage?.text
    || m.imageMessage?.caption || m.videoMessage?.caption || '';
};

// ------------------------------------------------------------ التحميل
function runYtdlp(url, dir) {
  const args = [
    '--no-playlist', '--no-warnings', '-q', '--no-progress', '--restrict-filenames',
    '--socket-timeout', '10', '--retries', '2',
    '--max-filesize', `${MAX_MB}M`,
    '--match-filter', `!is_live & duration<=?${MAX_SECONDS}`,
    '-f', 'b[ext=mp4][height<=720]/b[height<=720]/b',
    '-o', path.join(dir, '%(id)s.%(ext)s'),
    '--', url,
  ];
  return new Promise((resolve, reject) => {
    execFile(YTDLP, args, { timeout: 120000, maxBuffer: 20 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) { err.stderr = stderr; return reject(err); }
      const files = fs.readdirSync(dir).map((f) => path.join(dir, f)).filter((f) => !f.endsWith('.part'));
      const file = files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
      file ? resolve(file) : reject(new Error('no file'));
    });
  });
}

async function fetchVideo(url, dir) {
  try {
    return await runYtdlp(url, dir);
  } catch (e) {
    console.warn('[yt-dlp]', (e.stderr || e.message || '').toString().split('\n')[0].slice(0, 200));
  }
  return loader.download(url, MAX_MB, dir); // احتياط
}

// سؤال في الكونسول
const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, (a) => { rl.close(); resolve(a.trim()); });
});
let phoneAsked = PHONE;

// ------------------------------------------------------------ الأوامر
// الأمر يبدأ بـ . أو ! أو /  مثال: .rmbg  .رفع  .ai مرحبا
const COMMANDS = {
  rmbg: 'rmbg', removebg: 'rmbg', bg: 'rmbg', 'ازالة': 'rmbg', 'إزالة': 'rmbg', 'خلفية': 'rmbg', 'ازالة_الخلفية': 'rmbg',
  upload: 'upload', up: 'upload', 'رفع': 'upload', 'رابط': 'upload',
  ai: 'ai', gemini: 'ai', 'ذكاء': 'ai', 'اسأل': 'ai',
  help: 'help', start: 'help', menu: 'help', 'اوامر': 'help', 'الاوامر': 'help', 'أوامر': 'help',
};

function parseCommand(text) {
  const m = /^\s*[.!/]\s*(\S+)\s*([\s\S]*)$/.exec(String(text || ''));
  if (!m) return null;
  const name = COMMANDS[m[1].toLowerCase()];
  return name ? { name, arg: m[2].trim() } : null;
}

const HELP = [
  '📋 الأوامر:',
  '',
  '🖼️ .rmbg  ← إزالة الخلفية (أرسل صورة مع الأمر أو رد على صورة)',
  '☁️ .رفع  ← رفع الصورة على هوست دائم وإرجاع الرابط',
  '🤖 .ai <رسالتك>  ← محادثة مع Gemini (تقدر ترفق صورة)',
  '      .ai مسح  ← مسح ذاكرة المحادثة',
  '🎬 أرسل رابط فيديو ← أحمّله لك',
].join('\n');

// يدوّر على صورة: في الرسالة نفسها أو في الرسالة اللي تم الرد عليها
function findImage(msg) {
  const jid = msg.key.remoteJid;
  const content = normalizeMessageContent(msg.message) || {};
  const isImg = (c) => c && (c.imageMessage || (c.documentMessage && /^image\//.test(c.documentMessage.mimetype || '')));
  const mimeOf = (c) => (c.imageMessage || c.documentMessage).mimetype || 'image/jpeg';

  if (isImg(content)) return { target: msg, mime: mimeOf(content) };

  const ctx = content.extendedTextMessage?.contextInfo || content.imageMessage?.contextInfo;
  const quoted = ctx?.quotedMessage && normalizeMessageContent(ctx.quotedMessage);
  if (isImg(quoted)) {
    return {
      target: { key: { remoteJid: jid, id: ctx.stanzaId, participant: ctx.participant }, message: quoted },
      mime: mimeOf(quoted),
    };
  }
  return null;
}

async function getImage(sock, msg) {
  const found = findImage(msg);
  if (!found) return null;
  const buffer = await downloadMediaMessage(
    found.target, 'buffer', {},
    { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage },
  );
  return { buffer, mime: found.mime.split(';')[0] };
}

const quotedText = (msg) => {
  const q = normalizeMessageContent(msg.message)?.extendedTextMessage?.contextInfo?.quotedMessage;
  const c = q && normalizeMessageContent(q);
  return (c && (c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption)) || '';
};

async function runCommand(sock, msg, cmd) {
  const jid = msg.key.remoteJid;
  const say = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  if (cmd.name === 'help') return say(HELP);

  if (cmd.name === 'ai') {
    if (/^(مسح|reset|clear)$/i.test(cmd.arg)) { gemini.reset(jid); return say('🧹 تم مسح ذاكرة المحادثة.'); }
    const image = await getImage(sock, msg);
    const prompt = cmd.arg || quotedText(msg);
    if (!prompt && !image) return say('اكتب رسالتك بعد الأمر، مثال:\n.ai وش أفضل لغة برمجة للمبتدئين؟');
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    const reply = await gemini.ask(jid, prompt, image);
    return say(`🤖 ${reply.slice(0, 6000)}`);
  }

  // بقية الأوامر تحتاج صورة
  const image = await getImage(sock, msg);
  if (!image) return say('📷 أرسل صورة مع الأمر في الكابشن، أو رد على صورة بالأمر.');

  if (cmd.name === 'rmbg') {
    const out = await removeBackground(image.buffer, image.mime);
    // نرسلها كملف عشان تبقى الخلفية شفافة (واتساب يحوّل الصور العادية)
    return sock.sendMessage(jid, { document: out, mimetype: 'image/png', fileName: `no-bg_${Date.now()}.png`, caption: '✅ تمت إزالة الخلفية' }, { quoted: msg });
  }

  if (cmd.name === 'upload') {
    const link = await uploadImage(image.buffer, { mime: image.mime });
    return say(`☁️ تم الرفع:\n${link}`);
  }
}

// ------------------------------------------------------------ الترحيب (مرة واحدة لكل شخص، يُحفظ في welcomed.json)
const WELCOME_FILE = path.join(__dirname, 'welcomed.json');
let welcomed = new Set();
try { welcomed = new Set(JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8'))); } catch { /* أول تشغيل */ }
const saveWelcomed = () => { try { fs.writeFileSync(WELCOME_FILE, JSON.stringify([...welcomed])); } catch { /* ignore */ } };

// ------------------------------------------------------------ البوت
const busy = new Set();

async function handleMessage(sock, msg) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  if (jid.endsWith('@g.us') && !ALLOW_GROUPS) return;
  const text = textOf(msg);

  // أوامر الصور والذكاء الاصطناعي
  const cmd = parseCommand(text);

  // أول رسالة من شخص جديد في الخاص: نرسل له قائمة الأوامر مرة واحدة
  if (!jid.endsWith('@g.us') && !msg.key.fromMe && !welcomed.has(jid)) {
    welcomed.add(jid);
    saveWelcomed();
    if (cmd?.name !== 'help') await sock.sendMessage(jid, { text: `👋 أهلاً فيك!\n\n${HELP}` }).catch(() => {});
  }

  if (cmd) {
    const who = (msg.key.participant || jid) + ':cmd';
    if (busy.has(who)) return;
    busy.add(who);
    const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
    try {
      if (cmd.name !== 'help') await react('⏳');
      await runCommand(sock, msg, cmd);
      if (cmd.name !== 'help') await react('✅');
    } catch (e) {
      console.warn('[command failed]', cmd.name, '->', (e.message || e).toString().slice(0, 200));
      const text = e instanceof UserError || e.safe ? e.message : 'صار خطأ غير متوقع، جرب مرة ثانية.';
      await sock.sendMessage(jid, { text: `❌ ${text}` }, { quoted: msg }).catch(() => {});
      await react('❌');
    } finally {
      busy.delete(who);
    }
    return;
  }

  const url = pickUrl(text);
  if (!url) return;

  const who = msg.key.participant || jid;
  if (busy.has(who)) return;
  busy.add(who);

  const react = (emoji) => sock.sendMessage(jid, { react: { text: emoji, key: msg.key } }).catch(() => {});
  let dir = null;
  try {
    await react('⏳');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wadl-'));
    const file = await fetchVideo(url, dir);
    const mb = fs.statSync(file).size / 1024 / 1024;
    if (mb > MAX_MB) throw new Error('too big');

    const stream = { stream: fs.createReadStream(file) };
    if (mb <= VIDEO_LIMIT_MB) {
      await sock.sendMessage(jid, { video: stream, mimetype: 'video/mp4', caption: url }, { quoted: msg });
    } else {
      await sock.sendMessage(jid, {
        document: stream, mimetype: 'video/mp4',
        fileName: path.basename(file), caption: url,
      }, { quoted: msg });
    }
    await react('✅');
  } catch (e) {
    console.warn('[download failed]', url, '->', (e.stderr || e.message || e).toString().split('\n')[0].slice(0, 200));
    await sock.sendMessage(jid, { text: '❌ ما قدرت أحمّل هذا الرابط (يمكن خاص، أو فيديو طويل/كبير، أو الصور مو مدعومة).' }, { quoted: msg }).catch(() => {});
    await react('❌');
  } finally {
    busy.delete(who);
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') console.log('✅ البوت شغال، أرسل له رابط فيديو');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.log('تم تسجيل الخروج. احذف مجلد auth وشغّل من جديد.');
        process.exit(0);
      }
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) handleMessage(sock, msg).catch((e) => console.error(e));
  });

  // لو الجهاز مو مربوط: نسأل عن الرقم في الكونسول ونطلع كود الربط
  if (!sock.authState.creds.registered) {
    if (!phoneAsked) {
      phoneAsked = (await ask('\n📱 اكتب رقمك بصيغة دولية بدون + (مثال 9665XXXXXXXX): ')).replace(/\D/g, '');
    }
    if (!phoneAsked) { console.error('ما كتبت رقم.'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const code = await sock.requestPairingCode(phoneAsked);
      console.log(`\n🔑 كود الربط: ${code.match(/.{1,4}/g).join('-')}`);
      console.log('واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف، وأدخل الكود\n');
    } catch (e) {
      console.error('فشل طلب الكود:', e.message);
      phoneAsked = '';
    }
  }
}

start();
