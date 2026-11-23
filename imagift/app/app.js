'use strict';

// ---------- settings (kept in this browser only) ----------
const DEFAULTS = {
  ghtoken: '', ghrepo: 'thatfatcat/imaproject', ghbranch: 'main', ghpath: 'imagift/index.html',
  mqhost: '', mqport: '8084', mquser: '', mqpass: '', mqfrom: 'phone', device: 'epaper',
};
const KEY = 'dailyPoster.settings';
function load() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULTS); }
}
function store(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
let cfg = load();

const $ = (id) => document.getElementById(id);
function status(el, text, kind) { el.textContent = text; el.className = 'status' + (kind ? ' ' + kind : ''); }

// ---------- tabs ----------
const tabs = document.querySelectorAll('nav button');
function showTab(name) {
  tabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('main section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  $('title').textContent = { page: '[daily]', eink: '[e-ink]', settings: '[settings]' }[name];
  try { localStorage.setItem('dailyPoster.tab', name); } catch (e) {}
  if (name === 'eink') mqttConnect();
}
tabs.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- settings form ----------
const FIELDS = ['ghtoken', 'ghrepo', 'ghbranch', 'ghpath', 'mqhost', 'mqport', 'mquser', 'mqpass'];
FIELDS.forEach((f) => { $(f).value = cfg[f]; });
$('save').addEventListener('click', () => {
  FIELDS.forEach((f) => { cfg[f] = $(f).value.trim(); });
  cfg.mqhost = cfg.mqhost.replace(/^[a-z]+:\/\//i, '').replace(/[:/].*$/, '');
  $('mqhost').value = cfg.mqhost;
  store(cfg);
  mqttReset();
  status($('setstatus'), 'Saved on this phone.', 'ok');
  loadPage();
});

// ---------- GitHub ----------
async function gh(path, opts = {}) {
  const res = await fetch('https://api.github.com/repos/' + cfg.ghrepo + path, Object.assign({}, opts, {
    cache: 'no-store',
    headers: Object.assign({
      Authorization: 'Bearer ' + cfg.ghtoken,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, opts.headers || {}),
  }));
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { msg = (await res.json()).message || msg; } catch (e) {}
    if (res.status === 401) msg = 'GitHub rejected the token. Check it in Settings.';
    if (res.status === 404) msg = 'Repository or file not found. Check the token has access to ' + cfg.ghrepo + '.';
    throw new Error(msg);
  }
  return opts.raw ? res.text() : res.json();
}

const P_RE = /(<p id="motd">)([\s\S]*?)(<\/p>)/;
const IMG_RE = /<!--image-->[\s\S]*?<!--\/image-->/;

let currentImage = null;   // src of the image on the live page, or null
let newImage = null;       // { blob, url } picked on the phone
let removeImage = false;
let justPublished = null;  // { src, url }: keeps showing the local copy while Pages rebuilds

function htmlToText(html) {
  const d = document.createElement('div');
  d.innerHTML = html.replace(/<br\s*\/?>\s*/gi, '\n');
  return d.textContent.replace(/^\s+|\s+$/g, '');
}
function textToHtml(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return ' ' + esc.split(/\r?\n/).join('<br>\n        ');
}

async function readPageFile(ref) {
  return gh('/contents/' + encodeURI(cfg.ghpath) + '?ref=' + encodeURIComponent(ref), {
    raw: true, headers: { Accept: 'application/vnd.github.raw' },
  });
}

async function loadPage() {
  const st = $('pagestatus');
  if (!cfg.ghtoken) {
    $('msg').placeholder = 'Type today\'s message';
    status(st, 'Add your GitHub token in Settings first.', 'err');
    renderImage();
    return;
  }
  try {
    status(st, 'Loading the current page…');
    const html = await readPageFile(cfg.ghbranch);
    const m = html.match(P_RE);
    if (!m) throw new Error('Could not find <p id="motd"> in ' + cfg.ghpath + '.');
    if (!$('msg').dataset.edited) $('msg').value = htmlToText(m[2]);
    const im = (html.match(IMG_RE) || [''])[0].match(/src="([^"]+)"/);
    currentImage = im ? im[1] : null;
    renderImage();
    status(st, '');
  } catch (e) {
    status(st, e.message, 'err');
  }
}
$('msg').addEventListener('input', () => { $('msg').dataset.edited = '1'; });

function pageDir() { return cfg.ghpath.replace(/[^/]*$/, ''); }
function liveUrl(src) { return new URL(src, new URL('../', location.href)).href; }

function renderImage() {
  const box = $('imgbox');
  box.innerHTML = '';
  let src = null, note = '';
  if (newImage) { src = newImage.url; note = 'New photo, not published yet'; }
  else if (currentImage && !removeImage) {
    src = (justPublished && justPublished.src === currentImage) ? justPublished.url : liveUrl(currentImage);
    note = 'On the page now';
  }
  if (src) {
    const wrap = document.createElement('div');
    const img = document.createElement('img');
    img.src = src; img.alt = '';
    const s = document.createElement('small'); s.textContent = note;
    wrap.append(img, s); box.append(wrap);
  } else {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<div class="clock">' + new Date().toTimeString().slice(0, 5) + '</div><small></small>';
    wrap.querySelector('small').textContent = (currentImage && removeImage)
      ? 'Photo will be removed; the clock comes back' : 'No photo: the page shows the clock';
    box.append(wrap);
  }
  $('clearimg').disabled = !src;
}

$('pick').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', async () => {
  const f = $('file').files[0];
  $('file').value = '';
  if (!f) return;
  try {
    status($('pagestatus'), 'Preparing photo…');
    const blob = await shrink(f, 1600, 0.85);
    if (newImage) URL.revokeObjectURL(newImage.url);
    newImage = { blob, url: URL.createObjectURL(blob) };
    removeImage = false;
    renderImage();
    status($('pagestatus'), 'Photo ready (' + Math.round(blob.size / 1024) + ' KB).');
  } catch (e) {
    status($('pagestatus'), 'Could not read that photo: ' + e.message, 'err');
  }
});
$('clearimg').addEventListener('click', () => {
  if (newImage) { URL.revokeObjectURL(newImage.url); newImage = null; }
  else removeImage = true;
  renderImage();
});

// Resize to at most `max` px on the long side and re-encode as JPEG.
async function shrink(file, max, quality) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    src = await new Promise((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i); i.onerror = () => bad(new Error('unsupported image'));
      i.src = URL.createObjectURL(file);
    });
  }
  const w = src.width, h = src.height;
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise((ok, bad) => c.toBlob((b) => b ? ok(b) : bad(new Error('encode failed')), 'image/jpeg', quality));
}

function blobToBase64(blob) {
  return new Promise((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => bad(r.error);
    r.readAsDataURL(blob);
  });
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

$('publish').addEventListener('click', async () => {
  const st = $('pagestatus');
  if (!cfg.ghtoken) { status(st, 'Add your GitHub token in Settings first.', 'err'); return; }
  const text = $('msg').value.trim();
  if (!text) { status(st, 'Write a message first.', 'err'); return; }
  $('publish').disabled = true;
  try {
    status(st, 'Publishing…');
    // One commit with the page (and the photo, if any), on top of the latest branch tip.
    const ref = await gh('/git/ref/heads/' + encodeURIComponent(cfg.ghbranch));
    const head = ref.object.sha;
    const commit = await gh('/git/commits/' + head);
    let html = await readPageFile(head);
    if (!P_RE.test(html)) throw new Error('Could not find <p id="motd"> in ' + cfg.ghpath + '.');
    html = html.replace(P_RE, (_, a, __, c) => a + textToHtml(text) + c);

    const tree = [];
    let imgTag = '';
    if (newImage) {
      const name = 'images/' + stamp() + '.jpg';
      status(st, 'Uploading photo…');
      const blob = await gh('/git/blobs', { method: 'POST', body: JSON.stringify({ content: await blobToBase64(newImage.blob), encoding: 'base64' }) });
      tree.push({ path: pageDir() + name, mode: '100644', type: 'blob', sha: blob.sha });
      imgTag = '<img id="daily-image" src="' + name + '" alt="">';
    } else if (currentImage && !removeImage) {
      imgTag = '<img id="daily-image" src="' + currentImage + '" alt="">';
    }
    if (IMG_RE.test(html)) html = html.replace(IMG_RE, '<!--image-->' + imgTag + '<!--/image-->');
    else if (imgTag) throw new Error('The page has no <!--image--> slot, so a photo can\'t be added.');
    tree.push({ path: cfg.ghpath, mode: '100644', type: 'blob', content: html });

    status(st, 'Saving…');
    const newTree = await gh('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree }) });
    const msg = 'motd' + (newImage ? ' + photo' : (removeImage && currentImage ? ' (clock)' : ''));
    const nc = await gh('/git/commits', { method: 'POST', body: JSON.stringify({ message: msg, tree: newTree.sha, parents: [head] }) });
    await gh('/git/refs/heads/' + encodeURIComponent(cfg.ghbranch), { method: 'PATCH', body: JSON.stringify({ sha: nc.sha }) });

    currentImage = imgTag ? imgTag.match(/src="([^"]+)"/)[1] : null;
    if (newImage) {
      if (justPublished) URL.revokeObjectURL(justPublished.url);
      justPublished = { src: currentImage, url: newImage.url };
      newImage = null;
    }
    removeImage = false;
    delete $('msg').dataset.edited;
    renderImage();
    status(st, 'Published. The page updates in about a minute.', 'ok');
  } catch (e) {
    status(st, 'Not published: ' + e.message, 'err');
  } finally {
    $('publish').disabled = false;
  }
});

// ---------- MQTT ----------
let client = null;
function mqttState(text, kind) {
  $('mqtttext').textContent = text;
  $('mqttdot').className = 'dot' + (kind ? ' ' + kind : '');
}
function mqttReset() { if (client) { client.end(true); client = null; } mqttState('Not connected'); }
function mqttConnect() {
  if (client) return client;
  if (!cfg.mqhost || !cfg.mquser) { mqttState('Add the broker in Settings first.', 'err'); return null; }
  mqttState('Connecting…');
  client = mqtt.connect('wss://' + cfg.mqhost + ':' + (cfg.mqport || 8084) + '/mqtt', {
    username: cfg.mquser, password: cfg.mqpass,
    clientId: 'daily-' + Math.random().toString(16).slice(2, 10),
    clean: true, reconnectPeriod: 4000, connectTimeout: 10000, keepalive: 45,
  });
  client.on('connect', () => mqttState('Connected', 'on'));
  client.on('reconnect', () => mqttState('Reconnecting…'));
  client.on('offline', () => mqttState('Offline', 'err'));
  client.on('error', (e) => mqttState('Broker error: ' + e.message, 'err'));
  return client;
}
function topicFor(dev) { return 'nonamer/' + (dev || 'epaper') + '/inbox'; }
$('device').value = cfg.device;
$('topic').textContent = topicFor(cfg.device);
$('device').addEventListener('input', () => {
  cfg.device = $('device').value.trim(); store(cfg);
  $('topic').textContent = topicFor(cfg.device);
});

function sentList() { try { return JSON.parse(localStorage.getItem('dailyPoster.sent') || '[]'); } catch (e) { return []; } }
function renderSent() {
  const ul = $('sent'); ul.innerHTML = '';
  sentList().forEach((s) => {
    const li = document.createElement('li');
    li.textContent = s.text;
    const sp = document.createElement('span');
    sp.textContent = s.to + ' · ' + new Date(s.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    li.append(sp); ul.append(li);
  });
}
renderSent();

$('send').addEventListener('click', () => {
  const text = $('note').value.trim();
  if (!text) return;
  const c = mqttConnect();
  if (!c) return;
  const dev = cfg.device || 'epaper';
  // Plain text: the e-paper board shows the payload as-is, and the C6 accepts plain text too.
  const payload = text;
  $('send').disabled = true;
  mqttState(c.connected ? 'Sending…' : 'Waiting for broker…', c.connected ? 'on' : '');
  // QoS 1: the callback fires once the broker has the message; the board gets it even if it's asleep.
  c.publish(topicFor(dev), payload, { qos: 1 }, (err) => {
    $('send').disabled = false;
    if (err) { mqttState('Not sent: ' + err.message, 'err'); return; }
    mqttState('Sent to ' + dev, 'on');
    $('note').value = '';
    const list = sentList(); list.unshift({ text, to: dev, ts: Date.now() });
    try { localStorage.setItem('dailyPoster.sent', JSON.stringify(list.slice(0, 15))); } catch (e) {}
    renderSent();
  });
});

// ---------- start ----------
let startTab = 'page';
try { startTab = localStorage.getItem('dailyPoster.tab') || 'page'; } catch (e) {}
if (!cfg.ghtoken && !cfg.mqhost) startTab = 'settings';
showTab(startTab);
loadPage();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
