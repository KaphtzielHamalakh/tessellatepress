import { GOOGLE_CLIENT_ID } from './config.js';
import { MAX_FILE_BYTES, cleanName, clampPage, visibleBooks, sortedBooks } from './core.js';
import { LibraryStore } from './storage.js';
import { inspectComic, fileHash } from './media.js';
import { Reader } from './reader.js';
import { DriveLibrary } from './drive.js';

const $ = id => document.getElementById(id);
let statusTimer, importing = false, cloudBusy = false, opening = false, removeId = null, cloudLoadError = '';
let displayAccount = '';
try { displayAccount = localStorage.getItem('fcr:displayAccount') || ''; } catch {}
function rememberAccount(id) { displayAccount = id; try { id ? localStorage.setItem('fcr:displayAccount', id) : localStorage.removeItem('fcr:displayAccount'); } catch {} }
function status(message, persistent = false) { clearTimeout(statusTimer); $('status').textContent = message; $('status').hidden = false; if (!persistent) statusTimer = setTimeout(() => $('status').hidden = true, 7000); }
function fail(error) { status(error.message || 'Something went wrong. Please try again.'); }
const store = new LibraryStore(message => { $('storageWarning').textContent = message; $('storageWarning').hidden = false; });
const drive = new DriveLibrary(GOOGLE_CLIENT_ID, () => { if (drive.account) rememberAccount(drive.account.id); renderCloud(); render(); });
const progressTimers = new Map();
// Cloud writes are serialized so an older in-flight update cannot finish last.
let cloudQueue = Promise.resolve();
function queueProgress(id) {
  clearTimeout(progressTimers.get(id));
  progressTimers.set(id, setTimeout(() => {
    progressTimers.delete(id);
    cloudQueue = cloudQueue.catch(() => {}).then(async () => {
      const book = store.get(id);
      if (!book?.drive || !drive.account || book.drive.accountId !== drive.account.id || !navigator.onLine) return;
      const context = drive.context();
      const latest = await drive.json(`files/${encodeURIComponent(book.drive.id)}?fields=appProperties`, {}, context);
      const current = store.get(id);
      if (!current) return;
      // A newer remote position is retained; refresh imports it into the local shelf.
      if (Number(latest.appProperties?.progressAt || 0) > (current.progressAt || 0)) return;
      await drive.updateProgress(current, context);
    }).catch(fail);
  }, 1200));
}
const reader = new Reader({
  onProgress(id, page) {
    store.patch(id, { lastPage: page, progressAt: Date.now(), readAt: Date.now() });
    queueProgress(id);
  },
  onClose(id) { render(); document.querySelector(`[data-id="${CSS.escape(id)}"] .read-book`)?.focus(); }
});

function render() {
  const all = visibleBooks(store.all(), displayAccount);
  const list = sortedBooks(all, $('search').value, $('sort').value);
  $('libraryCount').textContent = `${all.length} ${all.length === 1 ? 'issue' : 'issues'}`;
  $('empty').hidden = all.length > 0;
  $('noResults').hidden = !all.length || list.length > 0;
  const fragment = document.createDocumentFragment();
  for (const book of list) {
    const card = document.createElement('article'); card.className = 'card'; card.dataset.id = book.id;
    const read = document.createElement('button'); read.className = 'read-book'; read.setAttribute('aria-label', `Read ${book.name}`);
    const cover = document.createElement('div'); cover.className = 'cover';
    if (book.cover?.startsWith('data:image/jpeg')) { const img = document.createElement('img'); img.src = book.cover; img.alt = ''; img.loading = 'lazy'; cover.append(img); }
    else { const placeholder = document.createElement('span'); placeholder.className = 'placeholder'; placeholder.textContent = 'FCR'; cover.append(placeholder); }
    if (book.drive) { const tag = document.createElement('span'); tag.className = 'cloud-tag'; tag.textContent = book.cached ? '☁ SAVED · ON DEVICE' : '☁ DOWNLOAD TO READ'; cover.append(tag); }
    const meta = document.createElement('div'); meta.className = 'meta';
    const title = document.createElement('div'); title.className = 'title'; title.textContent = book.name;
    const subtitle = document.createElement('div'); subtitle.className = 'subtitle'; subtitle.textContent = `${book.type.toUpperCase()} · ${book.pageCount} pages${book.readAt || book.progressAt ? ` · p. ${book.lastPage}` : ''}`;
    const progress = document.createElement('div'); progress.className = 'progress'; const bar = document.createElement('i'); bar.style.width = `${book.readAt || book.progressAt ? clampPage(book.lastPage, book.pageCount) / book.pageCount * 100 : 0}%`; progress.append(bar);
    meta.append(title, subtitle, progress); read.append(cover, meta); read.onclick = () => openBook(book.id).catch(fail);
    const actions = document.createElement('div'); actions.className = 'card-actions';
    const save = document.createElement('button');
    const savedHere = book.drive?.accountId === displayAccount;
    save.textContent = savedHere ? 'Saved to Drive' : 'Save to Drive'; save.disabled = cloudBusy || savedHere;
    save.setAttribute('aria-label', `${save.textContent}: ${book.name}`); save.onclick = () => saveBook(book.id).catch(fail);
    const remove = document.createElement('button'); remove.textContent = 'Remove'; remove.disabled = cloudBusy || importing;
    remove.setAttribute('aria-label', `Remove ${book.name} from this device`); remove.onclick = () => { removeId = book.id; $('removeName').textContent = book.name; $('removeDialog').showModal(); };
    actions.append(save, remove); card.append(read, actions); fragment.append(card);
  }
  $('grid').replaceChildren(fragment);
}

async function addFiles(files) {
  if (importing) { status('Please wait for the current import to finish.'); return; }
  importing = true; $('addBtn').disabled = $('addBtn2').disabled = true; render();
  const failures = []; let added = 0, duplicates = 0;
  try {
    for (const file of files) {
      try {
        if (!/\.(cbz|zip|pdf)$/i.test(file.name)) throw new Error('Use a CBZ, ZIP, or PDF file.');
        if (!file.size || file.size > MAX_FILE_BYTES) throw new Error('Files must be between 1 byte and 250 MB.');
        status(`Importing ${file.name}…`, true);
        const hash = await fileHash(file);
        if (visibleBooks(store.all(), displayAccount).some(book => book.hash === hash && book.cached)) { duplicates++; continue; }
        const type = /\.pdf$/i.test(file.name) ? 'pdf' : 'cbz';
        const metadata = await inspectComic(file, type);
        await store.put({ id: crypto.randomUUID(), name: cleanName(file.name), fileName: file.name, type, hash, ...metadata, size: file.size, lastPage: 1, addedAt: Date.now(), cached: true }, file);
        added++; render();
      } catch (error) { failures.push(`${file.name}: ${error.message || 'This file could not be imported.'}`); }
    }
    if (added && navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } finally { importing = false; $('addBtn').disabled = $('addBtn2').disabled = false; render(); }
  const summary = `${added} ${added === 1 ? 'issue' : 'issues'} added${duplicates ? ` · ${duplicates} already on your shelf` : ''}.`;
  status(summary + (failures.length ? ' ' + failures.join(' ') : ''), failures.length > 0);
}

async function openBook(id) {
  if (opening || reader.book) return;
  opening = true;
  try {
    let book = store.get(id), blob = await store.file(id);
    if (!book) return;
    if (!blob) {
      if (!book.drive || book.drive.accountId !== drive.account?.id) { $('cloudDialog').showModal(); status('Connect the Google account that owns this issue to download it.'); return; }
      if (book.size > MAX_FILE_BYTES) throw new Error('This Drive file is larger than the 250 MB reading limit.');
      status(`Downloading ${book.name}…`, true);
      const context = drive.context(); blob = await drive.download(book.drive.id, context);
      drive.assert(context);
      const metadata = await inspectComic(blob, book.type); drive.assert(context);
      book = { ...book, ...metadata, cached: true, lastPage: clampPage(book.lastPage, metadata.pageCount) };
      await store.put(book, blob); status('Downloaded for offline reading.');
    }
    await reader.open(book, blob);
  } finally { opening = false; }
}

function renderCloud() {
  const connected = !!drive.account;
  $('connectBtn').hidden = connected || !GOOGLE_CLIENT_ID;
  $('connectBtn').disabled = cloudBusy || !drive.client;
  $('syncBtn').hidden = $('disconnectBtn').hidden = !connected;
  $('syncBtn').disabled = cloudBusy;
  $('cloudState').textContent = !GOOGLE_CLIENT_ID ? 'Cloud saving is coming soon. You can read and keep your library on this device now.' : connected ? `Connected to ${drive.account.email || drive.account.name}. Save an issue from its library card. Reading positions sync while connected.` : cloudLoadError || 'Connect your Google account to find your saved issues. Local reading always works without an account.';
  $('cloudBtn').querySelector('span:last-child').textContent = connected ? 'Drive connected' : 'Cloud library';
}
async function withCloud(work) {
  if (cloudBusy) return;
  cloudBusy = true; renderCloud(); render();
  try { return await work(); } finally { cloudBusy = false; renderCloud(); render(); }
}
async function mergeRemote(file, accountId) {
  const props = file.appProperties || {};
  const type = props.type === 'pdf' ? 'pdf' : props.type === 'cbz' ? 'cbz' : null;
  if (!type || !Number.isFinite(Number(props.pageCount)) || Number(props.pageCount) < 1) return;
  const existing = store.all().find(book => book.drive?.id === file.id && book.drive.accountId === accountId);
  const lastPage = clampPage(props.lastPage, props.pageCount), progressAt = Number(props.progressAt) || 0;
  if (existing) {
    if (progressAt > (existing.progressAt || 0) && reader.book?.id !== existing.id) await store.patch(existing.id, { lastPage, progressAt, readAt: progressAt });
    else if ((existing.progressAt || 0) > progressAt) await drive.updateProgress(existing);
    return;
  }
  await store.put({ id: `drive:${accountId}:${file.id}`, name: cleanName(file.name), fileName: file.name, type, size: Number(file.size || 0), pageCount: Number(props.pageCount), lastPage, progressAt, readAt: progressAt, hash: props.hash || '', addedAt: Date.parse(file.createdTime) || Date.now(), cached: false, cloudOnly: true, drive: { id: file.id, accountId } });
}
async function refreshCloud() {
  await cloudQueue;
  const context = drive.context();
  status('Refreshing your Google Drive library…', true);
  const files = await drive.list(context);
  for (const file of files) { drive.assert(context); await mergeRemote(file, context.accountId); }
  drive.assert(context);
  status(`${files.length} saved ${files.length === 1 ? 'issue' : 'issues'} found. Choose an issue to read.`);
}
async function saveBook(id) {
  if (!drive.account) { renderCloud(); $('cloudDialog').showModal(); return; }
  await withCloud(async () => {
    let book = store.get(id); const blob = await store.file(id);
    if (!blob) throw new Error('Download this issue before saving it.');
    if (!book.hash) { await store.patch(id, { hash: await fileHash(blob) }); book = store.get(id); }
    status(`Saving ${book.name} to Google Drive…`, true);
    const saved = await drive.save(book, blob, pct => status(`Saving ${book.name}… ${pct}%`, true), pendingDrive => store.patch(id, { pendingDrive }));
    if (drive.account?.id !== saved.accountId) throw new Error('The Google account changed. Refresh your cloud library.');
    await store.patch(id, { drive: { id: saved.file.id, accountId: saved.accountId }, pendingDrive: null });
    // Consolidate a cloud placeholder if the same issue was imported locally.
    const duplicate = store.all().find(other => other.id !== id && other.cloudOnly && other.drive?.id === saved.file.id && other.drive.accountId === saved.accountId);
    if (duplicate) await store.remove(duplicate.id);
    await mergeRemote(saved.file, saved.accountId);
    status(`${book.name} is saved to your Google Drive.`);
  });
}

$('addBtn').onclick = $('addBtn2').onclick = () => $('file').click();
$('file').onchange = event => { const files = [...event.target.files]; event.target.value = ''; addFiles(files).catch(fail); };
$('search').oninput = $('sort').onchange = render;
$('helpBtn').onclick = () => $('helpDialog').showModal();
$('cloudBtn').onclick = () => { renderCloud(); $('cloudDialog').showModal(); };
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } }));
$('removeConfirm').onclick = async () => {
  $('removeConfirm').disabled = true;
  try { if (removeId) await store.remove(removeId); $('removeDialog').close(); render(); status('Removed from this device.'); } catch (error) { fail(error); } finally { $('removeConfirm').disabled = false; }
};
$('connectBtn').onclick = () => {
  // Start the popup synchronously from the button's user gesture.
  const connection = drive.connect();
  withCloud(async () => { await connection; await refreshCloud(); }).catch(fail);
};
$('syncBtn').onclick = () => withCloud(refreshCloud).catch(fail);
$('disconnectBtn').onclick = () => { rememberAccount(''); drive.disconnect(); status('Disconnected. Google Drive copies are unchanged.'); };
let dragDepth = 0;
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => event.preventDefault());
$('library').addEventListener('dragenter', event => { if (event.dataTransfer?.types.includes('Files')) { dragDepth++; $('library').classList.add('dragging'); } });
$('library').addEventListener('dragleave', () => { if (--dragDepth <= 0) $('library').classList.remove('dragging'); });
$('library').addEventListener('drop', event => { dragDepth = 0; $('library').classList.remove('dragging'); if (event.dataTransfer?.files.length) addFiles([...event.dataTransfer.files]).catch(fail); });

let installPrompt;
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('installBtn').hidden = false; });
$('installBtn').onclick = async () => { if (!installPrompt) return; await installPrompt.prompt(); installPrompt = null; $('installBtn').hidden = true; };
window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; status('Free Comic Reader is installed.'); });
let offlineReady = false;
function connectionLabel() { $('offlineStatus').textContent = offlineReady ? navigator.onLine ? 'Ready for offline reading.' : 'Offline · Your downloaded issues are ready.' : navigator.onLine ? 'Preparing offline reading…' : 'Offline · Reading stored issues.'; }
window.addEventListener('online', connectionLabel); window.addEventListener('offline', connectionLabel);
async function setupOffline() {
  if (!('serviceWorker' in navigator)) { $('offlineStatus').textContent = 'Local library ready. Offline installation is unavailable in this browser.'; return; }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready; offlineReady = true; connectionLabel();
    registration.addEventListener('updatefound', () => { const worker = registration.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) status('An update is ready. Close all reader tabs and reopen to use it.'); }); });
  } catch { $('offlineStatus').textContent = 'Offline setup failed. Reconnect and reload to try again.'; }
}
await store.open(); render(); renderCloud();
drive.prepare().catch(error => { cloudLoadError = error.message + ' Reconnect to the internet or allow Google, then reload.'; renderCloud(); });
setupOffline();
