# Web Companion

An original, browser-native animated companion runtime and administrator-only
publisher for `tonytan.me`.

Tony uploads a validated Companion ZIP or native Shijima export from
`/companion/manage`. Native XML is converted locally in the administrator's
browser. The service then sanitizes the generated collection and atomically
publishes an immutable pack plus the active `manifest.json` to the public
`Web-Companion-Assets` repository. Every portfolio visitor sees the configured
cast through the sandboxed `/companion/embed` runtime. Uploaded files are not
retained on AWS.

## Boundaries

- `Web-Companion`: runtime, publisher, validation, tests, deployment source.
- `Web-Companion-Assets`: public immutable packs and active manifest only.
- `Personal-Website`: a small sandboxed iframe host; no companion engine code.

This is a clean, original implementation. It does not include or derive from
Shijima-Web source. The independent importer reads common Shimeji mascot data
files for interoperability, converts only referenced PNG/WAV assets, and never
executes expressions or scripts from imported XML. Character assets are never
committed to this repository.

Collection packs support up to 12 character types, eight visible desktop
instances and four visible mobile instances. Each character has independent
count, mobile count, scale and automatic/click-only behavior controls. The
runtime supports weighted animations, native frame timing, basic movement,
dragging, mirroring and user-gesture-gated sound.

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

To convert a local Shijima export without opening the administrator UI:

```text
npm run convert:shijima -- input.zip output.zip
```

The output is server-validated and defaults to one active character. Conversion
does not grant publication rights; the administrator UI requires an explicit
rights confirmation before publishing.
