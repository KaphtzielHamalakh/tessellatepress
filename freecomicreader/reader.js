import { openMedia } from './media.js';
import { clampPage } from './core.js';

const $ = id => document.getElementById(id);
export class Reader {
  generation = 0;
  turn = 0;
  book = null;
  media = null;
  page = 1;
  ready = false;
  zoom = false;
  rtl = false;
  constructor({ onProgress, onClose }) {
    this.onProgress = onProgress; this.onClose = onClose;
    try { this.rtl = localStorage.getItem('fcr:rtl') === 'true'; } catch {}
    $('rtlBtn').setAttribute('aria-pressed', this.rtl);
    $('rtlBtn').onclick = () => { this.rtl = !this.rtl; $('rtlBtn').setAttribute('aria-pressed', this.rtl); try { localStorage.setItem('fcr:rtl', this.rtl); } catch {} };
    $('zoomBtn').onclick = () => this.setZoom(!this.zoom);
    $('backBtn').onclick = () => this.close();
    $('prevBtn').onclick = () => this.go(this.page - 1); $('nextBtn').onclick = () => this.go(this.page + 1);
    $('slider').oninput = event => this.go(Number(event.target.value));
    $('fullscreenBtn').hidden = !document.fullscreenEnabled;
    $('fullscreenBtn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('reader').requestFullscreen()).catch(() => {});
    document.addEventListener('keydown', event => {
      if (!this.book || event.target.closest('input,select,button,dialog,a')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); this.horizontal(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); this.horizontal(-1); }
      if (event.key === ' ') { event.preventDefault(); this.go(this.page + 1); }
      if (event.key === 'Home') { event.preventDefault(); this.go(1); }
      if (event.key === 'End') { event.preventDefault(); this.go(this.book.pageCount); }
      if (event.key.toLowerCase() === 'z') this.setZoom(!this.zoom);
    });
    document.addEventListener('keydown', event => { if (this.book && event.key === 'Escape') { event.preventDefault(); this.close(); } });
    let pointer = null, multiTouch = false;
    const activePointers = new Set();
    $('stage').addEventListener('pointerdown', event => {
      activePointers.add(event.pointerId);
      if (activePointers.size > 1) multiTouch = true;
      pointer = { x: event.clientX, y: event.clientY, time: Date.now(), scrollX: $('stage').scrollLeft, scrollY: $('stage').scrollTop };
      if (this.zoom && event.pointerType === 'mouse') $('stage').setPointerCapture(event.pointerId);
    });
    $('stage').addEventListener('pointermove', event => {
      if (this.zoom && pointer && event.buttons && event.pointerType === 'mouse') {
        $('stage').scrollLeft = pointer.scrollX + pointer.x - event.clientX;
        $('stage').scrollTop = pointer.scrollY + pointer.y - event.clientY;
      }
    });
    $('stage').addEventListener('pointerup', event => {
      activePointers.delete(event.pointerId);
      if (multiTouch) { if (!activePointers.size) multiTouch = false; pointer = null; return; }
      if (!pointer || !this.book) return;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y, elapsed = Date.now() - pointer.time;
      pointer = null;
      if (window.visualViewport?.scale > 1.05) return;
      if (!this.zoom && elapsed < 700 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.6) { this.horizontal(dx < 0 ? 1 : -1); return; }
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12 || elapsed > 700) return;
      const ratio = event.clientX / innerWidth;
      if (this.zoom || ratio > .38 && ratio < .62) this.chrome($('reader').classList.contains('chrome-hidden'));
      else this.horizontal(ratio < .38 ? -1 : 1);
    });
    $('stage').addEventListener('pointercancel', event => { activePointers.delete(event.pointerId); pointer = null; if (!activePointers.size) multiTouch = false; });
    let resizeTimer;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (this.ready) this.go(this.page, false); }, 180); });
    window.addEventListener('popstate', () => { if (this.book) this.close(false); });
  }
  chrome(show) { $('reader').classList.toggle('chrome-hidden', !show); }
  horizontal(direction) { this.go(this.page + (this.rtl ? -direction : direction)); }
  setZoom(zoom) {
    this.zoom = zoom; $('stage').classList.toggle('zoomed', zoom); $('zoomBtn').setAttribute('aria-pressed', zoom); $('stage').scrollTo(0, 0);
    this.chrome(true); if (this.ready) this.go(this.page, false);
  }
  async open(book, blob) {
    const generation = ++this.generation;
    this.book = book; this.ready = false; this.page = clampPage(book.lastPage, book.pageCount);
    this.returnFocus = document.activeElement;
    $('reader').hidden = false; $('library').inert = true; document.body.classList.add('reading');
    $('rName').textContent = book.name; $('slider').max = book.pageCount; this.chrome(true);
    $('spin').hidden = false; $('pageError').hidden = true; $('pageSurface').replaceChildren();
    $('stage').focus();
    history.pushState({ fcrReader: true }, '', '#reading');
    try {
      const media = await openMedia(blob, book.type);
      if (generation !== this.generation) { await media.destroy(); return; }
      this.media = media; this.book.pageCount = media.count; this.ready = true;
      $('slider').max = media.count;
      await this.go(this.page);
    } catch (error) { if (generation === this.generation) this.error(error); }
  }
  error(error) { $('spin').hidden = true; $('pageError').hidden = false; $('pageError').textContent = error.message || 'This page could not be displayed. Try another page or reimport the file.'; }
  async go(n, save = true) {
    if (!this.ready) return;
    const turn = ++this.turn, generation = this.generation, media = this.media;
    const page = clampPage(n, this.book.pageCount);
    this.page = page; $('slider').value = page;
    $('rCount').textContent = `${page} / ${this.book.pageCount}`;
    $('prevBtn').disabled = page === 1; $('nextBtn').disabled = page === this.book.pageCount;
    $('spin').hidden = false; $('pageError').hidden = true;
    media.cancel();
    try {
      const image = await media.render(page, innerWidth, innerHeight, Math.min(2, devicePixelRatio || 1) * (this.zoom ? 2 : 1));
      if (turn !== this.turn || generation !== this.generation) { image.release?.(); return; }
      for (const old of $('pageSurface').children) old.release?.();
      $('pageSurface').replaceChildren(image); $('spin').hidden = true; $('stage').scrollTo(0, 0);
      if (save) this.onProgress(this.book.id, page);
    } catch (error) { if (turn === this.turn && generation === this.generation && error.name !== 'RenderingCancelledException') this.error(error); }
  }
  close(goBack = true) {
    if (!this.book) return;
    const id = this.book.id;
    ++this.generation; ++this.turn;
    this.media?.destroy()?.catch?.(() => {}); this.media = null; this.book = null; this.ready = false;
    for (const image of $('pageSurface').children) image.release?.();
    $('pageSurface').replaceChildren(); $('reader').hidden = true; $('library').inert = false; document.body.classList.remove('reading');
    this.zoom = false; $('stage').classList.remove('zoomed'); $('zoomBtn').setAttribute('aria-pressed', 'false');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (goBack && history.state?.fcrReader) history.back();
    this.onClose(id);
  }
}
