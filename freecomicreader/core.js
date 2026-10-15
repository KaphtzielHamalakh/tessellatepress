export const MAX_FILE_BYTES = 250 * 1024 * 1024;
export const cleanName = name => name.replace(/\.(cbz|zip|pdf)$/i, '').replace(/_+/g, ' ').trim() || 'Untitled issue';
export const naturalCompare = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
export function imageNames(zip) {
  return Object.keys(zip.files).filter(name => !zip.files[name].dir && /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name) && !name.split('/').some(part => part.startsWith('.') || part === '__MACOSX')).sort(naturalCompare);
}
export const clampPage = (page, total) => Math.max(1, Math.min(Math.max(1, Number(total) || 1), Math.floor(Number(page) || 1)));
export function visibleBooks(books, accountId) {
  return books.filter(book => !book.cloudOnly || book.drive?.accountId === accountId);
}
export function sortedBooks(books, query, order) {
  return books.filter(book => book.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim())).sort((a, b) => order === 'title' ? naturalCompare(a.name, b.name) : order === 'reading' ? (b.readAt || 0) - (a.readAt || 0) || b.addedAt - a.addedAt : b.addedAt - a.addedAt);
}
export function progressProperties(book) {
  return { fcr: '1', pageCount: String(book.pageCount), lastPage: String(clampPage(book.lastPage, book.pageCount)), progressAt: String(book.progressAt || 0), type: book.type, hash: book.hash || '' };
}
