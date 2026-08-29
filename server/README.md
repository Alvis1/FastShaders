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

## Checklist

*(Done for alvismisjuns.lv — this is the record of what was set up, and the
recipe if it ever has to be rebuilt or moved to another host.)*

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
4. **Turn the client on**: set `EVAL_UPLOAD_URL = '/fastshaders-eval/upload.php'`
   in `src/eval/evalUpload.ts`, then `npm run deploy:alvismisjuns`.
   (`evalUpload.test.ts` pins the URL empty, so the test suite will fail until
   you update that pin too — deliberate, so nobody enables uploads by accident.)
5. **Extend the consent text** in `src/eval/ConsentModal.tsx`: today it says the
   package is "handed to the researcher". Once it is transmitted automatically,
   the consent must say the data is sent to the university's server.
6. **Run the study from the alvismisjuns URL**, not GitHub Pages: only that
   deploy carries `https://alvismisjuns.lv` in `connect-src`.

Then `https://alvismisjuns.lv/fastshaders-eval/list.php` is the single place
where every participant's package appears. Download them into one folder and
run `npm run eval:analysis -- <folder>` for the paper numbers.

## No PHP?

The endpoint is ~80 lines of "check a key, check the name, write a file", so
any equivalent works: a CGI script, a small Node/Python service behind an
Apache reverse proxy, or Apache's own `mod_dav` limited to PUT on one
directory. Only two things must hold — the URL is same-origin with the app (or
listed in the CSP's `connect-src`), and it accepts a raw `application/zip`
body. `src/eval/evalUpload.ts` needs no changes for any of them.

## What still lands on the study machine

The zip always downloads locally too, and the email step remains as the
fallback. That is deliberate: an upload failure (offline room, server down)
must never lose a session, and the in-person researcher can always collect the
file from the Downloads folder.
