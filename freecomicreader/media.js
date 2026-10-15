import * as pdfjs from './vendor/pdf/pdf.mjs';
import { imageNames, MAX_FILE_BYTES } from './core.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf/pdf.worker.mjs', import.meta.url).href;
const assets = new URL('./vendor/pdf/', import.meta.url).href;
export async function fileHash(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function openMedia(blob, type) {
  if (!blob?.size) throw new Error('This file is empty or is no longer stored on this device.');
  if (blob.size > MAX_FILE_BYTES) throw new Error('Choose a file smaller than 250 MB.');
  if (type === 'pdf') {
    const task = pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), isEvalSupported: false, cMapUrl: assets + 'cmaps/', cMapPacked: true, standardFontDataUrl: assets + 'standard_fonts/', wasmUrl: assets + 'wasm/' });
    let doc;
    try { doc = await task.promise; } catch (error) { await task.destroy(); throw new Error(error.name === 'PasswordException' ? 'This PDF is password protected. Import an unlocked copy.' : 'This PDF could not be opened. Try exporting it again.'); }
    if (doc.numPages > 5000) { await task.destroy(); throw new Error('This PDF has more than 5,000 pages. Split it into smaller issues.'); }
    const tasks = new Set();
    return {
      count: doc.numPages,
      async render(n, width, height, density = 1) {
        const page = await doc.getPage(n);
        const unit = page.getViewport({ scale: 1 });
        const fit = Math.min(width / unit.width, height / unit.height) * density;
        const scale = Math.min(fit, 8192 / unit.width, 8192 / unit.height, Math.sqrt(12000000 / (unit.width * unit.height)));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
        canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', `Page ${n}`);
        const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
        tasks.add(renderTask);
        try { await renderTask.promise; } finally { tasks.delete(renderTask); }
        return canvas;
      },
      cancel() { for (const task of tasks) task.cancel(); },
      destroy() { for (const renderTask of tasks) renderTask.cancel(); return task.destroy(); }
    };
  }
  const zip = await window.JSZip.loadAsync(blob);
  const names = imageNames(zip);
  if (!names.length) throw new Error('This archive contains no supported page images.');
  if (names.length > 5000) throw new Error('This archive has more than 5,000 pages. Split it into smaller issues.');
  const urls = new Set();
  let destroyed = false;
  return {
    count: names.length,
    async render(n) {
      const entry = zip.file(names[n - 1]);
      if (entry._data?.uncompressedSize > 80 * 1024 * 1024) throw new Error('This page is too large to open safely. Export a smaller image.');
      const bytes = await entry.async('blob');
      if (destroyed) throw new Error('Reader closed.');
      const url = URL.createObjectURL(bytes); urls.add(url);
      const img = new Image(); img.alt = `Page ${n}`; img.draggable = false;
      img.release = () => { URL.revokeObjectURL(url); urls.delete(url); };
      img.src = url;
      try { await img.decode(); } catch { img.release(); throw new Error(`Page ${n} is not a readable image.`); }
      return img;
    },
    cancel() {},
    destroy() { destroyed = true; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); }
  };
}
export async function inspectComic(blob, type) {
  const media = await openMedia(blob, type);
  let cover = '';
  try {
    const image = await media.render(1, 320, 480);
    try {
      const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
      const scale = Math.min(320 / width, 480 / height);
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      cover = canvas.toDataURL('image/jpeg', .78);
    } finally { image.release?.(); }
    return { cover, pageCount: media.count };
  } finally { await media.destroy(); }
}
