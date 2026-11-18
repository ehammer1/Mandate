# Testimonia Verify

A single web page that checks recordings from the capture app. Files are checked in the
browser with WebCrypto and never uploaded.

- `page.src.html` is the source. `npm run build:verify` inlines `src/capture-web.mjs` and the
  brand lockup into `index.html`, and writes the two example videos to `samples/`.
- `index.html` is self-contained apart from `samples/`; host it anywhere static.
- `test/capture-web.test.mjs` checks that the browser verifier gives the same result as the
  Node verifier on sealed, edited, truncated, crashed and forged files.

It checks the seal, the signing key, every second of video and the whole file. Device
registration and the on-chain record come with phase 2.
