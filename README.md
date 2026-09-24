# Web Companion

An original, browser-native animated companion runtime and administrator-only
publisher for `tonytan.me`.

Tony uploads one validated Companion ZIP from `/companion/manage`. The service
sanitizes the archive and atomically publishes an immutable pack plus the
active `manifest.json` to the public `Web-Companion-Assets` repository. Every
portfolio visitor then sees the same active companion through the sandboxed
`/companion/embed` runtime. Uploaded files are not retained on AWS.

## Boundaries

- `Web-Companion`: runtime, publisher, validation, tests, deployment source.
- `Web-Companion-Assets`: public immutable packs and active manifest only.
- `Personal-Website`: a small sandboxed iframe host; no companion engine code.

This is a clean, original implementation. It does not include or derive from
Shijima-Web, whose source license forbids redistribution and derivative work.
The first release supports the documented Companion ZIP format. Compatibility
with common Shimeji directory layouts may be added later through an independent
implementation.

## Development

Node.js 24 or newer is required.

```text
npm install
npm run check
npm start
```

Open `http://127.0.0.1:4040/companion/embed` for the runtime and
`http://127.0.0.1:4040/companion/manage` for the publisher.

See [`docs/PACK_FORMAT.md`](docs/PACK_FORMAT.md) and
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).
