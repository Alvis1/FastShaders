# Collecting study results in one place

**Live since 2026-11-09** at `https://imgame.va.lv/fastshaders-eval/list.php`
(user `researcher`), on the server of **Vidzeme University of Applied Sciences
(ViA)** — the data controller the consent names, which since consent-16 also
holds the data. Every submitted study package is POSTed there automatically,
and the page lists them with download links.

Until 2026-11-09 the endpoint ran on the researcher's own
`https://alvismisjuns.lv/fastshaders-eval/` (live from 2026-08-29). The packages
of the waves collected there (consent-14 and earlier) are still in that inbox;
nothing was moved. **During the change-over, collect from BOTH listings**: a
host still serving a build from before the switch (0.3.43) posts there, and so
does a study tab opened before a host was redeployed. Honour a deletion request
in both inboxes and in any downloaded copy. Once every host serves a
consent-16 build and no session from before can still be open, retire the old
upload by hand: over SFTP, rename `/var/www/alvis/src/public/fastshaders-eval/upload.php`
(the alvismisjuns docroot) to something unserved and keep its `list.php` for the
old packages. That `list.php` still answers to the OLD 4-digit login
(`_retiredAlvismisjuns` in `.vscode/eval-endpoint.json`): rotate it there.

| file | role |
|---|---|
| `fastshaders-eval-upload.php` | receives a package POSTed by the app |
| `fastshaders-eval-list.php` | password-protected page listing/downloading what arrived |
| `htaccess` | uploaded as the endpoint folder's `.htaccess`: raises `post_max_size`, serves only the two scripts |

The two PHP files are **templates**: this repo is public, so the real secrets
live in the gitignored `.vscode/eval-endpoint.json` and are rendered in at
deploy time by `bash scripts/deploy-eval-endpoint.sh` (run it after editing any
of the three files). The server's SSH login is not copied there: `sftpConfig` +
`sftpName` name the entry in the ImGame project's own gitignored
`.vscode/sftp.json`.

## How the live install is wired

imgame.va.lv is the ImGame project's site: Cloudflare in front, then a Debian
machine running Docker (SSH host 87.110.220.209:51022; its kernel is a Proxmox
`-pve` build and its root a ZFS subvolume, i.e. an LXC container; the IP block
is registered to LR IZM). What sits between Cloudflare and that machine is not
visible from here. The site
is the container `imgame_dev_php` — the stock `php:8-apache` image (PHP 8.3,
`mod_php`, `AllowOverride All` on `/var/www/`), whose **only** mount is its
docroot:

| | path |
|---|---|
| host | `/var/www/imgame_dev_lite/src/fastshaders-eval/` (`remoteDir`) |
| container | `/var/www/html/fastshaders-eval/` (what PHP sees) |
| web | `https://imgame.va.lv/fastshaders-eval/` (`publicBase`) |

Consequences, all load-bearing:

* **The inbox is inside the web root, behind two deny rules.** The container
  has no writable mount outside its docroot, so the inbox (`inboxDir`, a
  CONTAINER path: `/var/www/html/fastshaders-eval/inbox-<token>`) is a
  random-named folder beside the scripts, owned by `www-data` (uid 33) with mode
  `0700`. Its own `.htaccess` says `Require all denied`, and the endpoint
  folder's `.htaccess` (this repo's `htaccess`) denies every file except
  `upload.php` and `list.php`. Both rules work only because `AllowOverride All`
  is on there — the opposite of alvismisjuns, where `AllowOverride None` made
  such a guard dead and an inbox under the docroot was downloadable by URL.
  **Verified on every deploy, from outside**: a stored package answers 403 by
  direct URL, the folder answers 403, and `list.php` streaming it is the only
  way in.
* **`post_max_size` is raised per folder.** A package is the raw request body
  (`php://input`), so `post_max_size` is the limit that applies, and the image
  leaves it at its default `8M`: anything bigger was refused before
  `upload.php` ran. The folder's `.htaccess` sets `72M` (above `$MAX_BYTES`, the
  real cap, 64 MiB) and `memory_limit 256M`. **Measured 2026-11-09**: a 63 MB
  package went through Cloudflare and whatever sits behind it, and was stored.
* **The store step is checked, not assumed.** `list.php?health` (behind the
  inbox login) makes a real write in the inbox and removes it, answering
  `200 inbox ok: writable, … MB free` or `503 inbox FAILING: …`. The listing page
  shows the same failure as a red banner, and every deploy script stops unless
  the answer is `inbox ok`. (On alvismisjuns a container rebuild left the inbox
  read-only, and every real package answered 500 from 2026-10-08 to 10-20 while
  every other check stayed green.)
* **The endpoint shares a docroot with the ImGame site**, which is uploaded by
  hand over SFTP. An upload never deletes, but a "sync with delete" of the
  ImGame folder would remove `fastshaders-eval/` and **the packages in it**; a
  warning was added to the ImGame README on 2026-11-09 (it must be committed
  THERE, on the branch ImGame deploys from, to protect anything).
* **Before ANY change to that server's web stack** (ImGame's pages need no PHP
  since 2026-11-05, so a move to a static server is plausible): download every
  package and remove `fastshaders-eval/` FIRST. A server that does not run PHP
  serves `upload.php`/`list.php` as text, and one that ignores `.htaccess`
  (nginx does) serves the inbox to anyone who knows its folder name. Then give
  the endpoint a new home (checklist below); every host deploy stops at its
  `inbox ok` check until then.
* **The listing password is long and stored hashed**: `list.php` holds only the
  SHA-256 of `viewPassword`, which `render-eval-endpoint.mjs` refuses below 20
  characters or equal to the (public) upload key. Until 2026-11-09 it was a
  4-digit number in plain text behind the documented username, and nothing
  slowed a guesser down.
* **PHP never displays an error here**: the image has no `php.ini`, so PHP's
  built-in `display_errors=1` applied, and a warning printed before a
  refusal's `http_response_code(500)` sent the headers as 200 — a lost package
  the participant was told had uploaded. Both scripts and the folder's
  `.htaccess` switch it off, and the app counts an upload only when the body is
  exactly `ok`.
* **A full disk refuses rather than fills**: the key is public and the disk is
  ImGame's too, so `upload.php` answers 507 when a package would leave less than
  1 GiB free.
* **No ext-zip in the image**, so the listing's session-id column reads "—"
  (best-effort, see `peek()`); download the packages and read them with
  `npm run eval:analysis`.
* **Packages are mode 0644 inside the 0700 folder.** Only `www-data` (and root)
  can enter it.

## Posting from every app host (CORS)

No app host has an endpoint of its own any more, so **every** build posts here
cross-origin: `DEFAULT_EVAL_UPLOAD_URL` in `vite.config.ts`, which also adds its
origin to the build's CSP `connect-src`. `upload.php` admits exactly the app
origins through `$ALLOWED_ORIGINS` — `https://fs.sferas.lv` (the study host),
`https://alvismisjuns.lv`, `https://www.alvismisjuns.lv` and
`https://alvis1.github.io` (GitHub Pages, which could not upload at all while the
endpoint was relative):

* the OPTIONS **preflight** is answered `204` with `Access-Control-Allow-Origin`,
  `-Methods: POST`, `-Headers: Content-Type, X-FS-Eval-Name, X-FS-Eval-Key`;
* **every POST response** — `200` and the refusals alike — carries the same
  `Access-Control-Allow-Origin`. Without it the browser hides the answer from
  `fetch()`, so a package the server STORED would still read "Upload failed.";
* any other origin gets no `Access-Control-Allow-Origin` at all, which is the
  refusal. It is an exact-match list, never `*`.

`src/eval/evalUpload.test.ts` holds `$ALLOWED_ORIGINS` to the hosts the deploy
scripts and `vite.config.ts` name, so a new app host is a deliberate edit in
both places, followed by `bash scripts/deploy-eval-endpoint.sh`. **Verified
2026-11-09 in Chrome**: a `fetch()` POST from an `https://alvismisjuns.lv`
document passed the preflight and read the endpoint's `200 ok`.

## The deploy checks

`bash scripts/deploy-eval-endpoint.sh` renders the templates, prepares the
inbox (`mkdir`, `chown 33:33`, `chmod 700`, its `.htaccess`), uploads the three
files, and then checks: `upload.php` GET → 405, `list.php` anonymous → 401 and
authenticated → 200, the folder's `.htaccess` → 403, `list.php?health` →
`inbox ok`, the preflight from EVERY origin in `$ALLOWED_ORIGINS` (a 2xx, the
origin echoed, every header the template lists allowed) and none for
`https://example.com` — and finally the whole path: a real **16 MB** package
POSTed from the study origin must answer `200 ok` with the origin, lie on the
server's disk at full size, come back byte-identical through
`list.php?get=…`, answer 403/404 by direct URL (the file and the folder), and is
then deleted again.

Both host deploys (`npm run deploy:sferas`, `npm run deploy:alvismisjuns`) run
`scripts/check-eval-upload.sh` for their origins BEFORE they build or upload
anything — the live preflight judged the way a browser judges it, and
`list.php?health` — so a lagging or broken endpoint stops the deploy with the
host still on its previous build. After the upload they also check that the
served page's `connect-src` names this endpoint's origin.

## Checklist (if it ever has to move again)

`deploy-eval-endpoint.sh` is written for the ViA layout (password SSH, an inbox
directly inside the endpoint folder, owner uid 33). A host with an inbox
OUTSIDE its docroot, or a key login, needs those lines adapted first.

1. **A host that runs PHP** and can WRITE a directory the web never serves.
   Upload a one-line `t.php` containing `<?php echo 'php ok';` and open it; if it
   downloads as text, PHP is not enabled — see *No PHP?* below.
2. **Two different secrets.**
   - `$SECRET` in `upload.php` — also `EVAL_UPLOAD_KEY` in
     `src/eval/evalUpload.ts`. **This one is public**: it ships inside the app's
     JavaScript bundle and only deters drive-by posting.
   - `$VIEW_USER` / `$VIEW_PASSWORD` in `list.php` — **private**, never reused
     from the upload key: this page exposes participant data.
3. **Point `inboxDir`, `remoteDir`, `publicBase`, `sftpConfig` and `sftpName`**
   in `.vscode/eval-endpoint.json` at the new place and run
   `bash scripts/deploy-eval-endpoint.sh`. If the host does not honour
   `.htaccess`, the inbox must be OUTSIDE the docroot (adapt the script, above):
   its direct-URL check fails otherwise.
4. **Point the client at it**: `DEFAULT_EVAL_UPLOAD_URL` in `vite.config.ts` and
   the same literal in `src/eval/evalUpload.ts` (the suite pins the two). Never
   replace `evalUpload.ts`'s expression with a bare literal: that drops the
   build-time override.
5. **Keep the consent text true.** It names the host (`EVAL_UPLOAD_HOST` in
   `src/eval/evalMode.ts`; `evalDisclosure.test.ts` ties the text, its Latvian
   and the URL's host together), so moving the endpoint is a consent change:
   new wording in `ConsentModal.tsx` and `DataDisclosureModal.tsx`, their
   `lv.json` entries, and a `CONSENT_TEXT_VERSION` bump with its history line in
   `docs/dev/eval-mode.md`.
6. **Deploy every host** (the release, then `npm run deploy:alvismisjuns` and
   `npm run deploy:sferas`): a build still running the old URL keeps posting to
   the old endpoint, which therefore stays up until every host serves the new
   build.

Then `https://imgame.va.lv/fastshaders-eval/list.php` is where every new
participant's package appears (during a change-over, the old listing too — see
the top of this file). Download them into one folder
and run `npm run eval:analysis -- <folder>` for the paper numbers.

## No PHP?

The endpoint is ~80 lines of "check a key, check the name, write a file", so
any equivalent works: a CGI script or a small Node/Python service behind a
reverse proxy, as long as it answers a POST to a fixed URL with the file name
in `X-FS-Eval-Name` and the key in `X-FS-Eval-Key` (the client sends nothing
else — a PUT-only store such as `mod_dav` would need a client change and would
skip the key, name and zip checks). Three things must hold:

1. its origin is in every build's `connect-src` — `DEFAULT_EVAL_UPLOAD_URL`
   (or a build's `FS_EVAL_UPLOAD_URL`), and vite adds it;
2. it answers CORS for every app origin: the OPTIONS preflight with a 2xx,
   `Access-Control-Allow-Origin`, `-Methods: POST` and `-Headers: Content-Type,
   X-FS-Eval-Name, X-FS-Eval-Key`, plus `Access-Control-Allow-Origin` on every
   POST response, refusals included — without that last one a STORED package
   still reads "Upload failed.";
3. it accepts a raw `application/zip` body of up to 64 MiB.

A different endpoint is `DEFAULT_EVAL_UPLOAD_URL` plus the same literal in
`src/eval/evalUpload.ts` (checklist item 4), and the consent (item 5).

## What still lands on the study machine

The zip always downloads locally too, and the email step remains as the
fallback. That is deliberate: an upload failure (offline room, server down)
must never lose a session, and the in-person researcher can always collect the
file from the Downloads folder.
