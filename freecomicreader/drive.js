import { progressProperties } from './core.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/';
const fields = 'id,name,size,mimeType,appProperties,createdTime';
const quoted = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const query = values => new URLSearchParams(values).toString();

export class DriveLibrary {
  token = '';
  expires = 0;
  epoch = 0;
  account = null;
  client = null;
  pending = null;
  folder = null;
  constructor(clientId, onChange) { this.clientId = clientId; this.onChange = onChange; }
  async prepare() {
    if (!this.clientId) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://accounts.google.com/gsi/client'; script.async = true;
      script.onload = resolve; script.onerror = () => reject(new Error('Google sign-in could not load. Check your connection or browser content blocker.'));
      document.head.append(script);
    });
    this.client = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId, scope: SCOPE, include_granted_scopes: false,
      callback: response => {
        if (!this.pending) return;
        const pending = this.pending; this.pending = null;
        if (response.error || !response.access_token || !google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) { pending.reject(new Error('Google Drive access was not granted. You can keep reading locally.')); return; }
        this.token = response.access_token; this.expires = Date.now() + Number(response.expires_in) * 1000 - 60000; ++this.epoch;
        pending.resolve();
      },
      error_callback: () => { this.pending?.reject(new Error('Google sign-in was closed or blocked. Try connecting again and allow the popup.')); this.pending = null; }
    });
    this.onChange();
  }
  // Called directly from a click, preserving the user gesture for Google's popup.
  async connect() {
    if (!this.client) throw new Error('Google Drive is not ready. Check the connection and try again.');
    if (this.pending) throw new Error('Finish the open Google sign-in window first.');
    await new Promise((resolve, reject) => { this.pending = { resolve, reject }; this.client.requestAccessToken({ prompt: 'select_account' }); });
    const context = this.context();
    try {
      const { user } = await this.json('about?fields=user(permissionId,emailAddress,displayName)', {}, context);
      if (!user?.permissionId) throw new Error('Google did not return an account identifier. Please reconnect.');
      this.account = { id: user.permissionId, email: user.emailAddress, name: user.displayName };
      this.folder = null; this.onChange();
    } catch (error) { this.disconnect(); throw error; }
  }
  disconnect() {
    ++this.epoch; this.token = ''; this.expires = 0; this.account = null; this.folder = null;
    this.pending?.reject(new Error('Google Drive disconnected.')); this.pending = null; this.onChange();
  }
  context() {
    if (!this.token || Date.now() >= this.expires) {
      this.disconnect(); throw new Error('Reconnect Google Drive to continue. Your local library is safe.');
    }
    return { token: this.token, epoch: this.epoch, accountId: this.account?.id };
  }
  assert(context) { if (context.epoch !== this.epoch) throw new Error('The Google account changed. Please try again.'); }
  async request(url, options = {}, context = this.context()) {
    this.assert(context);
    // Never forward a Drive access token to an arbitrary upload URL.
    const target = new URL(url.startsWith('https://') ? url : API + url);
    if (target.origin !== 'https://www.googleapis.com') throw new Error('Unexpected Google Drive endpoint.');
    const response = await fetch(target, { ...options, redirect: 'error', headers: { ...options.headers, Authorization: `Bearer ${context.token}` } });
    this.assert(context);
    if (response.status === 401) { this.disconnect(); throw new Error('Your Google session expired. Reconnect to continue.'); }
    if (!response.ok && response.status !== 308) {
      let reason = '';
      try { reason = (await response.json()).error?.errors?.[0]?.reason || ''; } catch {}
      if (reason === 'storageQuotaExceeded') throw new Error('Your Google Drive is full. Free up space and try again.');
      if (response.status === 404) throw new Error('This Drive copy was removed or is no longer accessible.');
      if (response.status === 403) throw new Error('Google Drive denied this request. Check permissions, storage space, and that the Drive API is enabled.');
      throw new Error(`Google Drive could not complete the request (${response.status}). Please try again.`);
    }
    return response;
  }
  async json(url, options = {}, context) {
    context ||= this.context();
    const response = await this.request(url, options, context);
    const data = response.status === 204 ? null : await response.json();
    this.assert(context); return data;
  }
  async list(context = this.context(), extra = '') {
    const files = []; let pageToken = '';
    do {
      const data = await this.json('files?' + query({ q: `trashed = false and appProperties has { key='fcr' and value='1' }${extra}`, fields: `nextPageToken,files(${fields})`, pageSize: '100', ...(pageToken ? { pageToken } : {}) }), {}, context);
      files.push(...(data.files || [])); pageToken = data.nextPageToken || '';
    } while (pageToken);
    this.assert(context);
    return files;
  }
  async ensureFolder(context) {
    if (this.folder) return this.folder;
    const folders = await this.json('files?' + query({ q: "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='fcrFolder' and value='1' }", fields: 'files(id)', pageSize: '100' }), {}, context);
    if (folders.files?.length) return this.folder = folders.files[0].id;
    const folder = await this.json('files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Free Comic Reader', mimeType: 'application/vnd.google-apps.folder', appProperties: { fcrFolder: '1' } }) }, context);
    return this.folder = folder.id;
  }
  async save(book, blob, onProgress, onReserved) {
    const context = this.context();
    if (!context.accountId) throw new Error('Connect Google Drive first.');
    // A hash lookup plus a reserved ID makes retries safe after an ambiguous upload.
    const matches = book.hash ? await this.list(context, ` and appProperties has { key='hash' and value='${quoted(book.hash)}' }`) : [];
    if (matches.length) return { file: matches[0], accountId: context.accountId, existing: true };
    const folder = await this.ensureFolder(context);
    let id = book.pendingDrive?.accountId === context.accountId ? book.pendingDrive.id : null;
    if (!id) {
      const result = await this.json('files/generateIds?count=1&space=drive&type=files', {}, context);
      id = result.ids[0]; await onReserved({ id, accountId: context.accountId }); this.assert(context);
    }
    const metadata = { id, name: book.fileName || `${book.name}.${book.type}`, parents: [folder], appProperties: progressProperties(book) };
    const contentType = book.type === 'pdf' ? 'application/pdf' : 'application/zip';
    const session = await this.request('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' + encodeURIComponent(fields), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': contentType, 'X-Upload-Content-Length': String(blob.size) }, body: JSON.stringify(metadata) }, context);
    const url = session.headers.get('Location');
    if (!url) throw new Error('Google did not return an upload session. Please try again.');
    // 8 MB chunks are multiples of Drive's required 256 KB unit.
    const chunkSize = 8 * 1024 * 1024; let offset = 0, failures = 0;
    while (offset < blob.size) {
      this.assert(context);
      const end = Math.min(offset + chunkSize, blob.size);
      let response;
      try {
        response = await this.request(url, { method: 'PUT', headers: { 'Content-Type': contentType, 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` }, body: blob.slice(offset, end) }, context);
      } catch (error) {
        // Probe the server's offset after a transient failure; do not duplicate bytes.
        if (++failures > 2 || !this.token || !navigator.onLine) throw error;
        response = await this.request(url, { method: 'PUT', headers: { 'Content-Range': `bytes */${blob.size}` }, body: new Blob([]) }, context);
      }
      if (response.status === 200 || response.status === 201) {
        const file = await response.json(); this.assert(context); onProgress(100);
        return { file, accountId: context.accountId, existing: false };
      }
      const range = response.headers.get('Range');
      const next = range ? Number(range.match(/(\d+)$/)?.[1]) + 1 : 0;
      if (!Number.isFinite(next) || next <= offset && ++failures > 2) throw new Error('The upload stopped making progress. Please try again.');
      offset = next; onProgress(Math.round(offset / blob.size * 100));
    }
    throw new Error('Google did not confirm the upload. Reconnect and refresh your library before retrying.');
  }
  async download(fileId, context = this.context()) {
    return (await this.request(`files/${encodeURIComponent(fileId)}?alt=media`, {}, context)).blob();
  }
  async updateProgress(book, context = this.context()) {
    if (book.drive?.accountId !== context.accountId) return;
    return this.json(`files/${encodeURIComponent(book.drive.id)}?fields=id,appProperties`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appProperties: progressProperties(book) }) }, context);
  }
}
