// عميل loader.to (savenow): احتياط لـ yt-dlp
// بدون كوكيز وبدون كابتشا: ننشئ job، ننتظر الرابط، وننزّل الملف.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const API_KEY = process.env.LOADER_API_KEY || '';
const HOSTS = ['p.lbserver.xyz', 'p.savenow.to', 'loader.to', 'en.loader.to'];
// نجرب من الأعلى جودة للأقل لين يدخل الملف تحت حد الرفع
const QUALITIES = ['720', '480', '360', '240'];

const headers = (extra) => ({
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://loader.to/',
  'Accept-Language': 'en-US,en;q=0.9',
  ...(extra || {}),
});

async function getJson(url) {
  const res = await fetch(url, { headers: headers(), redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(`loader HTTP ${res.status}: ${(json && json.message) || text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (!json) throw new Error(`loader non-JSON: ${text.slice(0, 200)}`);
  return json;
}

async function tryHosts(makeUrl) {
  let last = null;
  for (const host of HOSTS) {
    try {
      return await getJson(makeUrl(host));
    } catch (e) {
      last = e;
      if (e.status && e.status !== 404 && e.status < 500) throw e;
    }
  }
  throw last || new Error('all loader hosts failed');
}

const startJob = (url, format) => tryHosts((h) => `https://${h}/api/v2/download?format=${encodeURIComponent(format)}&url=${encodeURIComponent(url)}&apikey=${encodeURIComponent(API_KEY)}`);
const poll = (id) => tryHosts((h) => `https://${h}/api/progress?id=${encodeURIComponent(id)}`);
const linkOf = (d) => d && (d.download_url || d.url || d.direct_url);

async function waitForLink(id, timeoutSec = 150) {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const d = await poll(id);
    if (linkOf(d)) return d;
    if (Date.now() > deadline) throw new Error('loader timed out');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const tooBig = () => Object.assign(new Error('File is larger than max-filesize'), { stderr: 'File is larger than max-filesize' });

// يرجّع مسار الملف المحمّل داخل dir
async function download(url, limitMB, dir) {
  if (!API_KEY) throw new Error('loader: LOADER_API_KEY غير موجود في .env');
  const limit = limitMB * 1024 * 1024;
  let lastErr = null;
  for (const fmt of QUALITIES) {
    const job = await startJob(url, fmt);
    let link = linkOf(job);
    if (!link) {
      if (!job.id) throw new Error(`loader: no job id (${JSON.stringify(job).slice(0, 150)})`);
      link = linkOf(await waitForLink(job.id));
    }
    const res = await fetch(link, { headers: headers({ Accept: '*/*' }), redirect: 'follow' });
    if (!res.ok) throw new Error(`loader download HTTP ${res.status}`);
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/html')) throw new Error('loader returned html instead of media');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > limit) {
      res.body?.cancel().catch(() => {});
      lastErr = tooBig();
      continue;
    }
    const cd = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
    const ext = cd && cd[1].includes('.') ? cd[1].split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '') : 'mp4';
    const dest = path.join(dir, `video_${Date.now()}.${ext || 'mp4'}`);
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
    const size = fs.statSync(dest).size;
    if (!size) throw new Error('loader: empty file');
    if (size > limit) {
      fs.rmSync(dest, { force: true });
      lastErr = tooBig();
      continue;
    }
    return dest;
  }
  throw lastErr || new Error('loader: no file');
}

module.exports = { download };
