# Free Comic Reader

Static app at **https://tessellatepress.com/freecomicreader/**. The existing repository's GitHub Pages deployment serves this folder. There is no production build or backend. Links are added to the home page and comics page; the existing CNAME stays unchanged.

## What works

- Import CBZ / ZIP / PDF, natural page order, cover thumbnails, duplicate detection, search and sorting.
- Local library and reading progress; migration of the original prototype's `fcr` IndexedDB database.
- Touch/swipe/keyboard navigation, manga direction, zoom with pan, fullscreen, scrubber, browser Back.
- Installable PWA; local PDF.js 6.4.299 and JSZip 3.10.1, PDF worker, fonts, character maps and codecs cached for offline reading.
- Optional Google Drive upload, list, download and progress sync. The integration ships **disabled until a public OAuth client ID is added**.

Limits: 250 MB per file, 5,000 pages per issue, 80 MB per extracted image. Very large/high-resolution files can still exceed a mobile device's memory. Unsupported or password-protected files show an error. Local storage is best effort, with a visible warning on failed persistence. Keep originals.

## Enable Google Drive

No client secret or server is needed for the browser token flow. Do not reuse another application's OAuth client unless its branding, permissions, and authorized origins are appropriate for this app.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and create/select a project for Free Comic Reader.
2. Enable **Google Drive API** in APIs & Services → Library.
3. In **Google Auth Platform**, configure branding: Free Comic Reader, a support email you control, homepage `https://tessellatepress.com/freecomicreader/`, and privacy URL `https://tessellatepress.com/freecomicreader/privacy.html`. Add `tessellatepress.com` as an authorized domain and complete Google's ownership checks if requested.
4. Configure an **External** audience. Start in **Testing** and add the Google accounts that will test the reader. Configure only the scope `https://www.googleapis.com/auth/drive.file` under Data Access. This per-file permission is non-sensitive; Google's branding/publishing requirements may still apply.
5. Under Clients, create an **OAuth client ID → Web application**. Add the JavaScript origin `https://tessellatepress.com`. If you serve the app at `www`, also add `https://www.tessellatepress.com`. For local testing add `http://localhost:4173`. Origins have **no path or trailing slash**. This popup token flow does not need a redirect URI.
6. Copy the public client ID (ending in `.apps.googleusercontent.com`) into `freecomicreader/config.js` as `GOOGLE_CLIENT_ID`. Never add a client secret, refresh token or service-account key.
7. Run `node scripts/build-reader-cache.cjs` to update the offline cache version after changing app files. Commit and deploy both `config.js` and the generated `sw.js` / `asset-manifest.json`. Close existing reader tabs and reopen after deployment so an older offline version does not hide the new configuration.
8. Test with an allowed account: Connect Google Drive → import a small issue → Save to Drive → confirm the private file in the Free Comic Reader Drive folder. On a second browser/device, connect the same account, download the issue, change page, return to the first device and Refresh cloud library. Test denying consent, popup blocking, expired sessions, disconnecting, and switching accounts.
9. When ready for general readers, move the Google app to **In production** and complete any checks Google requests. Google account creation/consent and any verification must be completed by the project owner. A client ID alone does not prove the project is configured correctly.

The initial release deliberately does not provide a Google Picker or arbitrary folder browsing. It saves locally imported files and restores files this same OAuth application created. `drive.file` does not automatically grant access to every file within a selected folder.

## Sync and storage behavior

Files upload only after an explicit per-issue “Save to Drive” action. Imports never upload automatically. Uploads use 8 MB resumable chunks, a file fingerprint and a reserved Drive ID to make retries safer. Google OAuth access tokens remain in memory and expire; reconnecting requires a user click. Reloading the page does not silently sign in.

Cloud records are associated with Google's account identifier. Cached cloud issues for the last selected account can be read offline after reload; explicit Disconnect hides those records and clears the remembered account. Locally imported issues remain visible. To remove sensitive cached bytes completely, use Remove or clear the site's data. Disconnecting does not revoke the Google grant; use Google Account connections for that.

Reading positions are written locally after successful rendering and sync while connected. The most recently timestamped position wins on refresh (device clocks should be accurate). A newer remote position is not replaced by an older local one. There is no cross-device transaction or real-time collaboration; reconnect/refresh when moving between devices. Offline reading changes sync after connecting. The last few seconds of cloud progress can remain unsynced if a tab closes abruptly; local progress stays saved.

Removing an issue only removes its local entry and bytes. A later cloud refresh can restore it. Delete cloud files in Google Drive. A cloud file deleted outside the app may remain as a cached local copy; missing downloads report an error.

## Development and validation

From the repository root: `npm install`, then `npx playwright install chromium`, then `npm test`. The tests start a local server, create synthetic CBZ/PDF fixtures and exercise the browser. Google endpoints are mocked for cloud tests; an actual OAuth client and real Google account are required for live acceptance testing.

For manual preview: `node scripts/serve.cjs`, then visit `http://localhost:4173/freecomicreader/`. Use HTTP(S), not `file://`.

Run `node scripts/build-reader-cache.cjs` whenever app code, dependencies or icons change. The generated service worker precaches only this app's same-origin static assets. It does not intercept the main Tessellate Press site, cache Google API responses, or cache tokens. Updates wait until old reader tabs close.

Dependencies are vendored under `vendor/` with their licenses. To upgrade PDF.js, obtain the official `pdfjs-dist` package, replace the core/worker and matching `cmaps`, `standard_fonts`, `wasm` directories together, regenerate the asset manifest and rerun tests. Keep test dependencies out of the deployed app.

## References

- [Google's browser token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Drive per-file scope](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Resumable uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)
- [Custom file properties](https://developers.google.com/workspace/drive/api/guides/properties)
- [PDF.js releases](https://github.com/mozilla/pdf.js/releases)
