# Collecting study results in one place

**Live since 2026-08-29** at `https://alvismisjuns.lv/fastshaders-eval/list.php`
(user `researcher`). Every submitted study package is POSTed there
automatically, and the page lists them with download links.

| file | role |
|---|---|
| `fastshaders-eval-upload.php` | receives a package POSTed by the app |
| `fastshaders-eval-list.php` | password-protected page listing/downloading what arrived |

Both are **templates**: this repo is public, so the real secrets live in the
gitignored `.vscode/eval-endpoint.json` and are rendered in at deploy time by
`bash scripts/deploy-eval-endpoint.sh` (run it after editing either file).

## How the live install is wired

The site runs as a Docker container (`php:8.5-apache` behind Traefik), with the
host directory `/var/www/alvis/src` mounted at `/app` and `DocumentRoot
/app/public`. Two consequences, both learned the hard way and both load-bearing:

* **The inbox must be addressed by its CONTAINER path** (`/app/eval-inbox-…`).
  A host-absolute path is invisible to PHP — only the mount exists inside the
  container.
* **The inbox must sit OUTSIDE `/app/public`.** With it under the docroot the
  packages were downloadable by URL with no password: `AllowOverride` is `None`
  in that image, so the `.htaccess` guard is ignored, and Apache runs as the
  same `www-data` that owns the files, so `chmod 0700` does not stop it either.
  Outside the docroot, `list.php` streaming it is the only way in. **Verified**:
  a direct URL to a stored package returns 404, an anonymous `list.php?get=`
  returns 401, and an authenticated download is byte-identical to the file the
  participant's browser produced.

## Posting from the study host (CORS)

Participants are sent to **fs.sferas.lv**, a static nginx container with no
PHP, so the app's relative `/fastshaders-eval/upload.php` 404ed there and every
package read "Upload failed." (reported 2026-10-02). That build now posts to
`https://alvismisjuns.lv/fastshaders-eval/upload.php` ABSOLUTELY
(`FS_EVAL_UPLOAD_URL` in `scripts/deploy-sferas.sh`, which also lands in its
CSP `connect-src`), and `upload.php` admits exactly that origin through
`$ALLOWED_ORIGINS`:

* the OPTIONS **preflight** is answered `204` with `Access-Control-Allow-Origin`,
  `-Methods: POST`, `-Headers: Content-Type, X-FS-Eval-Name, X-FS-Eval-Key`;
* **every POST response** — `200` and the refusals alike — carries the same
  `Access-Control-Allow-Origin`. Without it the browser hides the answer from
  `fetch()`, so a package the server STORED would still read "Upload failed.";
* any other origin gets no `Access-Control-Allow-Origin` at all, which is the
  refusal. It is an exact-match list, never `*`.

A new host that must post here goes into `$ALLOWED_ORIGINS` (and into the pin
in `src/eval/evalUpload.test.ts`, which ties that list to `deploy-sferas.sh`'s
`ORIGIN` on purpose — widening it should be a deliberate edit), its build gets
`FS_EVAL_UPLOAD_URL`, and the endpoint is redeployed. Both deploy scripts judge
the live preflight the way a browser does — a 2xx status, the study origin
echoed back, and every header the upload sends allowed (asked for as this
template lists them) — and `deploy-eval-endpoint.sh` also checks that a foreign
origin gets none. `deploy-sferas.sh` runs the same check from the app side
BEFORE it builds or uploads anything, so a lagging endpoint stops that deploy
with the study host untouched: deploy the endpoint first. Only the CORS answer
is checked — any other template change (`$MAX_BYTES`, the name pattern, the
key) goes live only when this endpoint is redeployed by hand.

## Checklist

*(Done for alvismisjuns.lv — this is the record of what was set up, and the
recipe if it ever has to be rebuilt or moved to another host. Items 4–6 are
written for today's layout: the endpoint here, the study on fs.sferas.lv.)*

1. **Confirm the host runs PHP.** Upload a one-line `t.php` containing
   `<?php echo 'php ok';` and open it. If it downloads as text instead of
   printing, PHP is not enabled — see *No PHP?* below. Delete it afterwards.
   (alvismisjuns.lv: PHP 8.5.9, `apache2handler`, running as `www-data`.)
2. **Pick two different secrets.**
   - `$SECRET` in `upload.php` — also set `EVAL_UPLOAD_KEY` in
     `src/eval/evalUpload.ts` to the same string. **This one is public**: it
     ships inside the app's JavaScript bundle and only deters drive-by posting.
   - `$VIEW_USER` / `$VIEW_PASSWORD` in `list.php` — **private**, never reused
     from the upload key: this page exposes participant data.
3. **Upload both files** to `…/fastshaders-eval/` (a sibling of the app's
   `/fastshaders/` directory, so the app's CSP already allows the POST as
   same-origin). Optionally point `$INBOX` in BOTH files at a directory
   outside the web root.
4. **Point the client at it.** `EVAL_UPLOAD_URL` in `src/eval/evalUpload.ts` is
   the build's `FS_EVAL_UPLOAD_URL` when one is set, else the relative
   `/fastshaders-eval/upload.php` (which `evalUpload.test.ts` pins). A build
   served beside the endpoint needs nothing (`npm run deploy:alvismisjuns`);
   a build on another host sets `FS_EVAL_UPLOAD_URL` to the absolute URL, as
   `scripts/deploy-sferas.sh` does, and its origin goes into `$ALLOWED_ORIGINS`.
   Never replace the expression with a literal: that drops the override and
   sends the study host back to "Upload failed.".
5. **Keep the consent text true** (`src/eval/ConsentModal.tsx` and
   `DataDisclosureModal.tsx`): since consent-3 it names alvismisjuns.lv as the
   study server "operated by the researcher", and `evalDisclosure.test.ts`
   forbids calling it "the university's server". Moving the endpoint to
   another host is a consent change — new wording and a `CONSENT_TEXT_VERSION`
   bump.
6. **Run the study from fs.sferas.lv** (`npm run deploy:sferas`): its build
   posts here absolutely and carries `https://alvismisjuns.lv` in
   `connect-src`, as described under *Posting from the study host* above. The
   alvismisjuns build posts same-origin; GitHub Pages cannot upload (it answers
   405), so a session there relies on the download and the email.

Then `https://alvismisjuns.lv/fastshaders-eval/list.php` is the single place
where every participant's package appears. Download them into one folder and
run `npm run eval:analysis -- <folder>` for the paper numbers.

## No PHP?

The endpoint is ~80 lines of "check a key, check the name, write a file", so
any equivalent works: a CGI script or a small Node/Python service behind an
Apache reverse proxy, as long as it answers a POST to a fixed URL with the
file name in `X-FS-Eval-Name` and the key in `X-FS-Eval-Key` (the client sends
nothing else — a PUT-only store such as `mod_dav` would need a client change
and would skip the key, name and zip checks). Three things must hold:

1. the URL is same-origin with the app, or its origin is in the build's
   `connect-src` — set `FS_EVAL_UPLOAD_URL` and vite adds it;
2. a CROSS-origin endpoint (the fs.sferas.lv build's case) answers CORS for
   the posting origin: the OPTIONS preflight with a 2xx,
   `Access-Control-Allow-Origin`, `-Methods: POST` and `-Headers: Content-Type,
   X-FS-Eval-Name, X-FS-Eval-Key`, plus `Access-Control-Allow-Origin` on every
   POST response, refusals included — without that last one a STORED package
   still reads "Upload failed.";
3. it accepts a raw `application/zip` body.

`src/eval/evalUpload.ts` needs no changes for any of them: a different
endpoint is a build-time `FS_EVAL_UPLOAD_URL`.

## What still lands on the study machine

The zip always downloads locally too, and the email step remains as the
fallback. That is deliberate: an upload failure (offline room, server down)
must never lose a session, and the in-person researcher can always collect the
file from the Downloads folder.
