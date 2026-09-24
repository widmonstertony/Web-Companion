# Repository operating guide

This repository owns the Web Companion runtime and its administrator-only
publisher for `tonytan.me`. Keep it independent from Personal-Website; the
portfolio may embed `/companion/embed` but must not copy this application.

- Never copy source or binaries from Shijima-Web. Its license prohibits
  redistribution and derivative works.
- Uploaded packs are untrusted input. Accept only the documented ZIP format,
  enforce all archive and image limits before decompression, and repack only
  validated files before publishing.
- Never commit GitHub App keys, OAuth secrets, installation tokens, AWS keys,
  uploaded character packs, or administrator session material.
- Only the configured GitHub account may publish. Public visitors are
  read-only consumers of the active manifest.
- The public asset repository is `widmonstertony/Web-Companion-Assets`; keep
  application code and public uploaded assets in their respective repositories.
- Run `npm run check` before committing. Production changes go through a pull
  request into protected `main`; Tony may merge as repository administrator.
