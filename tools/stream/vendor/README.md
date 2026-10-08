# vendor/

Third-party assets we serve ourselves, so the player works on a LAN or a
tailnet with no internet access — the same reason HLS was chosen over Icecast.

## hls.min.js

- **hls.js 1.7.3** — https://github.com/video-dev/hls.js
- Source: `https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js`
- License: Apache-2.0
- Needed because Chrome and Firefox cannot play HLS natively; Safari can, so
  `hls.html` only loads this when `Hls.isSupported()` is false and falls back to
  the native path otherwise.

To update: re-download the same URL, replace the file, and update the version
above. Nothing else references it.
