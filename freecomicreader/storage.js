// Metadata and file bytes are separate so browsing a shelf never loads every comic.
export class LibraryStore {
  db = null;
  books = new Map();
  sessionFiles = new Map();
  queue = Promise.resolve();
  constructor(onWarning) { this.onWarning = onWarning; }
  async open() {
    try {
      this.db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('fcr', 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          const books = db.objectStoreNames.contains('books') ? request.transaction.objectStore('books') : db.createObjectStore('books', { keyPath: 'id' });
          const files = db.createObjectStore('files');
          books.openCursor().onsuccess = event => {
            const cursor = event.target.result;
            if (!cursor) return;
            const book = cursor.value;
            if (book.blob) { files.put(book.blob, book.id); book.size = book.blob.size; delete book.blob; book.cached = true; cursor.update(book); }
            cursor.continue();
          };
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => this.onWarning('Close other Free Comic Reader tabs, then reload to finish updating local storage.');
      });
      this.db.onversionchange = () => { this.db.close(); this.db = null; this.onWarning('The reader updated in another tab. Reload before adding more comics.'); };
      const books = await new Promise((resolve, reject) => {
        const request = this.db.transaction('books').objectStore('books').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      books.forEach(book => this.books.set(book.id, book));
    } catch {
      this.db?.close(); this.db = null;
      this.onWarning('Persistent storage is unavailable. Comics added now last only for this session. Keep your original files.');
    }
  }
  all() { return [...this.books.values()]; }
  get(id) { return this.books.get(id); }
  async file(id) {
    if (this.sessionFiles.has(id)) return this.sessionFiles.get(id);
    if (!this.db) return null;
    return new Promise((resolve, reject) => {
      const request = this.db.transaction('files').objectStore('files').get(id);
      request.onsuccess = () => resolve(request.result || null); request.onerror = () => reject(request.error);
    });
  }
  // Serialize local writes, resolving only after commit, including abort/quota errors.
  put(book, blob) {
    this.books.set(book.id, book);
    if (blob) this.sessionFiles.set(book.id, blob);
    const operation = this.queue.then(async () => {
      if (!this.db) return false;
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction(['books', 'files'], 'readwrite');
          tx.objectStore('books').put(book);
          if (blob) tx.objectStore('files').put(blob, book.id);
          tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => {};
        });
        if (blob && this.sessionFiles.get(book.id) === blob) this.sessionFiles.delete(book.id);
        return true;
      } catch {
        this.onWarning('This device could not save your latest changes, possibly because storage is full. They remain available in this tab; keep the original or save to Drive before closing.');
        return false;
      }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  patch(id, changes) {
    const current = this.get(id);
    return current ? this.put({ ...current, ...changes }) : Promise.resolve(false);
  }
  remove(id) {
    const operation = this.queue.then(async () => {
      if (this.db) await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['books', 'files'], 'readwrite');
        tx.objectStore('books').delete(id); tx.objectStore('files').delete(id);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); tx.onerror = () => {};
      });
      this.books.delete(id); this.sessionFiles.delete(id);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
