const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const JSZip = require('jszip');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { createServer } = require('../scripts/serve.cjs');

const results = path.join(__dirname, '../test-results');
fs.mkdirSync(results, { recursive: true });
const server = createServer();
const errors = [];
const check = name => console.log('PASS ' + name);
let browser;
function monitor(page) { page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000); return page; }
async function count(page, number) { try { await page.waitForFunction(n => document.querySelectorAll('.card').length === n, number); } catch (error) { console.error(await page.locator('body').innerText(), errors); throw error; } }
async function rendered(page, pageNumber) {
  await page.waitForFunction(n => document.querySelector('#rCount').textContent.startsWith(n + ' /') && document.querySelector('#spin').hidden && document.querySelector('#pageSurface').children.length > 0, pageNumber);
}
async function importFile(page, name, buffer, mimeType = 'application/zip') {
  await page.locator('#file').setInputFiles({ name, buffer, mimeType });
  await page.waitForFunction(() => !document.querySelector('#addBtn').disabled);
}
async function closeReader(page) { await page.locator('#backBtn').click(); await page.waitForFunction(() => document.querySelector('#reader').hidden); await page.waitForURL(url => !url.hash); }
async function connect(page) { await page.locator('#cloudBtn').click(); await page.locator('#connectBtn').click(); await page.waitForFunction(() => !document.querySelector('#syncBtn').hidden && !document.querySelector('#syncBtn').disabled); await page.locator('#cloudDialog [data-close]').click(); }
async function mockGoogle(context, backend) {
  await context.route('**/freecomicreader/config.js', route => route.fulfill({ contentType: 'text/javascript', body: "export const GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';" }));
  await context.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'text/javascript', body: `window.google={accounts:{oauth2:{hasGrantedAllScopes:r=>!window.denyScope,initTokenClient:options=>({requestAccessToken:()=>setTimeout(()=>options.callback({access_token:'fake-token-'+(window.testAccount||'a'),expires_in:3600}),0)})}}};` }));
  await context.route('https://www.googleapis.com/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const account = request.headers().authorization?.split('-').at(-1) || 'a';
    const send = (data, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Expose-Headers': 'Location, Range', ...headers }, body: JSON.stringify(data) });
    if (backend.unauthorized) return send({ error: {} }, 401);
    if (url.pathname.endsWith('/about')) return send({ user: { permissionId: account, emailAddress: `${account}@example.test`, displayName: 'Test Reader' } });
    if (url.pathname.endsWith('/generateIds')) return send({ ids: ['comic-' + (++backend.id)] });
    if (url.pathname === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      if (q.includes('fcrFolder')) return send({ files: [{ id: 'folder-' + account }] });
      let files = [...backend.files.values()].filter(file => file.account === account);
      if (q.includes("key='hash'")) files = files.filter(file => q.includes(file.appProperties.hash));
      return send({ files: files.map(({ bytes, account, ...file }) => file) });
    }
    if (url.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const metadata = request.postDataJSON(); backend.uploads++;
      backend.sessions.set(metadata.id, { ...metadata, account, size: request.headers()['x-upload-content-length'], createdTime: new Date().toISOString(), chunks: [] });
      return send({}, 200, { Location: 'https://www.googleapis.com/test-upload/' + metadata.id });
    }
    if (url.pathname.startsWith('/test-upload/')) {
      backend.chunks++;
      const id = url.pathname.split('/').at(-1), session = backend.sessions.get(id);
      session.chunks.push(request.postDataBuffer());
      const bytes = Buffer.concat(session.chunks);
      if (bytes.length < Number(session.size)) return send({}, 308, { Range: `bytes=0-${bytes.length - 1}` });
      const { chunks, ...file } = session; backend.files.set(id, { ...file, bytes });
      return send(file);
    }
    const id = url.pathname.split('/').at(-1), file = backend.files.get(id);
    if (!file || file.account !== account) return send({ error: {} }, 404);
    if (url.searchParams.get('alt') === 'media') return route.fulfill({ body: file.bytes, contentType: 'application/zip' });
    if (method === 'PATCH') { file.appProperties = { ...file.appProperties, ...request.postDataJSON().appProperties }; backend.progressWrites++; }
    return send({ id, appProperties: file.appProperties });
  });
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = origin + '/freecomicreader/';
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = monitor(await context.newPage()); await page.goto(url); await page.locator('#empty').waitFor();
  await page.screenshot({ path: path.join(results, 'desktop-empty.png'), fullPage: true });
  await page.locator('#cloudBtn').click(); assert.match(await page.locator('#cloudState').innerText(), /coming soon/); assert.equal(await page.locator('#connectBtn').isVisible(), false); await page.locator('#cloudDialog [data-close]').click();
  check('unconfigured Google Drive has an honest, usable local-only state');
  const images = await page.evaluate(() => ['#255f70', '#b94731', '#b58c27'].map((color, i) => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 900; const ctx = canvas.getContext('2d');
    ctx.fillStyle = color; ctx.fillRect(0, 0, 600, 900); ctx.fillStyle = '#f3efe4'; ctx.font = 'bold 25px sans-serif'; ctx.fillText('SYNTHETIC TEST COMIC', 45, 65); ctx.font = 'bold 65px sans-serif'; ctx.fillText('ORBIT', 45, 145); ctx.strokeStyle = '#ffd050'; ctx.lineWidth = 12; ctx.beginPath(); ctx.arc(300, 440, 175, 0, Math.PI * 2); ctx.stroke(); ctx.font = 'bold 90px sans-serif'; ctx.fillText(String(i + 1), 270, 475); ctx.font = '20px sans-serif'; ctx.fillText('BROWSER TEST FIXTURE · NOT A PUBLICATION', 45, 840); return canvas.toDataURL('image/png').split(',')[1];
  }));
  const zip = new JSZip(); zip.file('page10.png', Buffer.from(images[2], 'base64')); zip.file('page2.png', Buffer.from(images[1], 'base64')); zip.file('page1.png', Buffer.from(images[0], 'base64')); zip.file('__MACOSX/._page1.png', 'not an image');
  const cbz = await zip.generateAsync({ type: 'nodebuffer' });
  const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) { const p = pdf.addPage([600, 900]); p.drawRectangle({ x: 0, y: 0, width: 600, height: 900, color: rgb(.08, .1, .18) }); p.drawText('NIGHT FLIGHT', { x: 45, y: 790, size: 45, font, color: rgb(1, .8, .3) }); p.drawText('PDF test page ' + i, { x: 45, y: 700, size: 25, font, color: rgb(1, 1, 1) }); }
  const pdfBytes = Buffer.from(await pdf.save());
  await importFile(page, 'Orbit_01.cbz', cbz); await importFile(page, 'Night_Flight.pdf', pdfBytes, 'application/pdf'); await count(page, 2);
  assert.match(await page.locator('.card').first().innerText(), /Night Flight/);
  await importFile(page, 'Orbit_01.cbz', cbz); await count(page, 2); assert.match(await page.locator('#status').innerText(), /already on your shelf/);
  await importFile(page, 'Broken.cbz', Buffer.from('not a zip')); assert.match(await page.locator('#status').innerText(), /Broken.cbz/); await count(page, 2);
  check('CBZ and PDF imports, thumbnail generation, duplicate detection and visible invalid-file errors');
  await page.locator('#search').fill('orbit'); await count(page, 1); await page.locator('#search').fill('nothing'); await count(page, 0); assert.equal(await page.locator('#noResults').isVisible(), true); await page.locator('#search').fill(''); await page.locator('#sort').selectOption('title'); await count(page, 2);
  check('library search, no-results state and title sorting');
  await page.getByRole('button', { name: 'Read Orbit 01', exact: true }).click(); await rendered(page, 1);
  assert.equal(await page.locator('#rCount').innerText(), '1 / 3');
  await page.locator('#nextBtn').click(); await rendered(page, 2);
  const pixel = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; canvas.getContext('2d').drawImage(document.querySelector('#pageSurface img'), 0, 0, 1, 1, 0, 0, 1, 1); return [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data]; });
  assert.deepEqual(pixel.slice(0, 3), [185, 71, 49]);
  await page.locator('#stage').focus(); await page.keyboard.press('ArrowRight'); await rendered(page, 3); await closeReader(page); await page.reload(); await count(page, 2);
  await page.getByRole('button', { name: 'Read Orbit 01', exact: true }).click(); await rendered(page, 3);
  await page.locator('#rtlBtn').click(); await page.locator('#stage').focus(); await page.keyboard.press('ArrowRight'); await rendered(page, 2);
  await page.locator('#zoomBtn').click(); assert.equal(await page.locator('#stage').evaluate(el => el.classList.contains('zoomed')), true); await page.locator('#zoomBtn').click();
  await page.goBack(); await page.waitForFunction(() => document.querySelector('#reader').hidden);
  check('natural page order, immediate progress persistence, RTL, zoom and browser Back');
  await page.getByRole('button', { name: 'Read Night Flight', exact: true }).click(); await rendered(page, 1);
  await page.locator('#slider').evaluate(el => { for (const n of [2, 3, 1, 2, 3]) { el.value = n; el.dispatchEvent(new Event('input', { bubbles: true })); } }); await rendered(page, 3);
  assert.equal(await page.locator('#pageSurface canvas').count(), 1); assert.equal(await page.locator('#pageError').isVisible(), false); await closeReader(page);
  check('PDF worker rendering and rapid page turns without overlapping canvas errors');
  await page.evaluate(() => navigator.serviceWorker.ready); await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true); await page.reload(); await count(page, 2); await page.getByRole('button', { name: 'Read Night Flight', exact: true }).click(); await rendered(page, 3); await closeReader(page); await context.setOffline(false);
  check('offline app reload and PDF reading with cached worker and font assets');
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(results, 'mobile-library.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Remove Orbit 01 from this device', exact: true }).click(); await page.locator('#removeConfirm').click(); await count(page, 1);
  await page.reload(); await count(page, 1); check('mobile layout and persistent, explicit local removal');
  await context.close();

  const fallback = await browser.newContext({ serviceWorkers: 'block' });
  await fallback.addInitScript(() => Object.defineProperty(window, 'indexedDB', { get() { throw new Error('Blocked'); } }));
  const fallbackPage = monitor(await fallback.newPage()); await fallbackPage.goto(url); await fallbackPage.locator('#storageWarning').waitFor(); await importFile(fallbackPage, 'Session.cbz', cbz); await count(fallbackPage, 1); await fallbackPage.getByRole('button', { name: 'Read Session', exact: true }).click(); await rendered(fallbackPage, 1); await fallback.close();
  check('blocked IndexedDB still permits reading with a clear session-only warning');

  const migration = await browser.newContext({ serviceWorkers: 'block' }); const migrationPage = monitor(await migration.newPage());
  await migrationPage.goto(origin + '/');
  await migrationPage.evaluate(async b64 => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    await new Promise((resolve, reject) => { const request = indexedDB.open('fcr', 1); request.onupgradeneeded = () => request.result.createObjectStore('books', { keyPath: 'id' }); request.onerror = reject; request.onsuccess = () => { const db = request.result; const tx = db.transaction('books', 'readwrite'); tx.objectStore('books').put({ id: 'legacy', name: 'Legacy Issue', type: 'cbz', blob: new Blob([bytes]), pageCount: 3, lastPage: 2, addedAt: 1 }); tx.oncomplete = () => { db.close(); resolve(); }; }; });
  }, cbz.toString('base64'));
  await migrationPage.goto(url); await count(migrationPage, 1); await migrationPage.getByRole('button', { name: 'Read Legacy Issue', exact: true }).click(); await rendered(migrationPage, 2);
  const quota = await migrationPage.evaluate(async () => {
    const { LibraryStore } = await import('./storage.js'); let warning = ''; const store = new LibraryStore(message => warning = message);
    store.db = { transaction() { const tx = { objectStore() { return { put() {} }; } }; setTimeout(() => tx.onabort(), 0); return tx; } };
    const blob = new Blob(['saved in memory']); const saved = await store.put({ id: 'quota', name: 'Quota test' }, blob);
    return { saved, warning, bytes: await (await store.file('quota')).text(), count: store.all().length };
  });
  assert.equal(quota.saved, false); assert.equal(quota.count, 1); assert.equal(quota.bytes, 'saved in memory'); assert.match(quota.warning, /could not save/); await migration.close();
  check('prototype database migration preserves files and position; aborted writes keep a session copy');

  const backend = { files: new Map(), sessions: new Map(), id: 0, uploads: 0, progressWrites: 0, chunks: 0 };
  const cloud = await browser.newContext({ serviceWorkers: 'block' }); await mockGoogle(cloud, backend); const cloudPage = monitor(await cloud.newPage()); await cloudPage.goto(url); await cloudPage.locator('#empty').waitFor(); await connect(cloudPage);
  await importFile(cloudPage, 'Orbit.cbz', cbz); assert.equal(backend.uploads, 0);
  await cloudPage.getByRole('button', { name: 'Save to Drive: Orbit', exact: true }).click();
  try { await cloudPage.waitForFunction(() => document.querySelector('.card-actions button').textContent === 'Saved to Drive'); } catch (error) { console.error(await cloudPage.locator('#status').textContent(), errors, { uploads: backend.uploads, files: backend.files.size }); throw error; }
  assert.equal(backend.files.size, 1); assert.equal(backend.uploads, 1); assert.equal([...backend.files.values()][0].bytes.equals(cbz), true);
  await cloudPage.getByRole('button', { name: 'Read Orbit', exact: true }).click(); await rendered(cloudPage, 1); await cloudPage.locator('#nextBtn').click(); await rendered(cloudPage, 2); await closeReader(cloudPage);
  for (let n = 0; n < 40 && [...backend.files.values()][0].appProperties.lastPage !== '2'; n++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal([...backend.files.values()][0].appProperties.lastPage, '2');
  check('mock Google consent, explicit upload, matching bytes and reading progress sync');

  const second = await browser.newContext({ serviceWorkers: 'block' }); await mockGoogle(second, backend); const secondPage = monitor(await second.newPage()); await secondPage.goto(url); await connect(secondPage); await count(secondPage, 1);
  await secondPage.getByRole('button', { name: 'Read Orbit', exact: true }).click(); await rendered(secondPage, 2); await closeReader(secondPage); await secondPage.reload(); await count(secondPage, 1); await secondPage.getByRole('button', { name: 'Read Orbit', exact: true }).click(); await rendered(secondPage, 2); await closeReader(secondPage);
  await connect(secondPage); await secondPage.locator('#cloudBtn').click(); await secondPage.locator('#disconnectBtn').click(); await secondPage.locator('#cloudDialog [data-close]').click(); await count(secondPage, 0);
  await secondPage.evaluate(() => window.testAccount = 'b'); await connect(secondPage); await count(secondPage, 0); assert.equal(backend.uploads, 1);
  check('second-device restore and cached reads; disconnect/account switch isolates cloud entries');
  backend.unauthorized = true; await secondPage.locator('#cloudBtn').click(); await secondPage.locator('#syncBtn').click(); await secondPage.waitForFunction(() => document.querySelector('#status').textContent.includes('expired')); assert.equal(await secondPage.locator('#connectBtn').isVisible(), true); backend.unauthorized = false;
  check('expired Google token prompts reconnection without deleting local data');
  await secondPage.evaluate(() => window.denyScope = true); await secondPage.locator('#connectBtn').click(); await secondPage.waitForFunction(() => document.querySelector('#status').textContent.includes('not granted')); assert.equal(await secondPage.locator('#syncBtn').isVisible(), false);
  check('declined granular permission keeps the cloud disconnected');
  await cloudPage.locator('#cloudBtn').click(); await cloudPage.locator('#syncBtn').click(); await cloudPage.waitForFunction(() => !document.querySelector('#syncBtn').disabled); await cloudPage.locator('#cloudDialog [data-close]').click();
  const bigZip = new JSZip(); bigZip.file('page.png', Buffer.from(images[0], 'base64')); bigZip.file('padding.bin', Buffer.alloc(9 * 1024 * 1024, 1));
  const large = await bigZip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  await importFile(cloudPage, 'Large.cbz', large); await cloudPage.getByRole('button', { name: 'Save to Drive: Large', exact: true }).click(); await cloudPage.getByRole('button', { name: 'Saved to Drive: Large', exact: true }).waitFor();
  assert.equal(backend.chunks, 3); assert.equal([...backend.files.values()].find(file => file.name === 'Large.cbz').bytes.equals(large), true);
  check('multi-chunk resumable upload preserves every byte and handles 308 offsets');
  await second.close(); await cloud.close();
  const blockedGoogle = await browser.newContext({ serviceWorkers: 'block' });
  await blockedGoogle.route('**/freecomicreader/config.js', route => route.fulfill({ contentType: 'text/javascript', body: "export const GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';" }));
  await blockedGoogle.route('https://accounts.google.com/gsi/client', route => route.abort());
  const blockedPage = monitor(await blockedGoogle.newPage()); await blockedPage.goto(url); await blockedPage.locator('#empty').waitFor(); await blockedPage.locator('#cloudBtn').click();
  await blockedPage.waitForFunction(() => document.querySelector('#cloudState').textContent.includes('could not load')); assert.equal(await blockedPage.locator('#connectBtn').isDisabled(), true); await blockedGoogle.close();
  check('blocked Google script shows a recoverable error in the cloud dialog');
  assert.deepEqual(errors, []); check('no uncaught browser errors across the suite');
  console.log('All Free Comic Reader checks passed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); server.close(); });
