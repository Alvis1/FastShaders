#!/usr/bin/env node
/**
 * Check the study inboxes for packages not yet on disk, download them, and summarise each.
 *
 *   node .claude/skills/eval-results/fetch.mjs            # check + download new
 *   node .claude/skills/eval-results/fetch.mjs --list     # check only, download nothing
 *
 * Inboxes and logins come from the GITIGNORED .vscode/eval-endpoint.json (the top-level
 * imgame.va.lv login and the `_retiredAlvismisjuns` block — since 2026-11-10 the live
 * staging inbox). Nothing secret is in this file.
 *
 * "Already have it" = a file of the same name (ignoring a browser's " (1)" suffix) anywhere
 * under private/evalTests/, or a name listed in private/evalTests/ignored.txt (the owner's
 * own test runs). New packages land in private/evalTests/new/<YYYY-MM-DD>/ for the owner
 * to file into a group folder.
 *
 * Packages are participant-made, i.e. untrusted: they are read with `unzip -p` (nothing is
 * extracted or executed) and only parsed as JSON.
 */
import { readFileSync, readdirSync, statSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

const ROOT = process.cwd();
const ARCHIVE = join(ROOT, 'private/evalTests');
const LIST_ONLY = process.argv.includes('--list');

const cfgPath = join(ROOT, '.vscode/eval-endpoint.json');
if (!existsSync(cfgPath)) {
  console.error(`missing ${cfgPath} — run from the repo root on the owner's machine`);
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const inboxes = [
  cfg._retiredAlvismisjuns && { ...cfg._retiredAlvismisjuns, label: 'alvismisjuns.lv (staging)' },
  { ...cfg, label: 'imgame.va.lv (ViA)' },
].filter((b) => b && b.publicBase && b.viewUser && b.viewPassword);

const stem = (n) => n.replace(/ ?\(\d+\)(?=\.zip$)/, '');

function walk(dir, out = new Set()) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (e.startsWith('fastshaders-eval-') && e.endsWith('.zip')) out.add(stem(e));
  }
  return out;
}
const have = walk(ARCHIVE);
const ignoredPath = join(ARCHIVE, 'ignored.txt');
const ignored = new Set(
  existsSync(ignoredPath)
    ? readFileSync(ignoredPath, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    : [],
);

function curl(args) {
  return execFileSync('curl', ['-sS', '--fail', '--max-time', '60', '--retry', '2', ...args], {
    maxBuffer: 64 << 20,
  });
}

function listInbox(b) {
  const html = curl(['-u', `${b.viewUser}:${b.viewPassword}`, `${b.publicBase}/list.php`]).toString();
  const names = [...html.matchAll(/\?get=(fastshaders-eval-[A-Za-z0-9._-]+\.zip)/g)].map((m) => m[1]);
  return [...new Set(names)];
}

function readEntry(zip, name) {
  try {
    return JSON.parse(execFileSync('unzip', ['-p', zip, name], { maxBuffer: 64 << 20 }).toString());
  } catch {
    return null;
  }
}

function summarise(zip) {
  const s = readEntry(zip, 'session.json');
  if (!s) return { ok: false, line: 'unreadable: no session.json' };
  const sus = readEntry(zip, 'sus.json');
  const tel = readEntry(zip, 'telemetry-summary.json')?.summary;
  const who = s.session?.participant ?? '?';
  const flags = [];
  if (!/^[A-Za-z]\d{4}$/.test(who) || /^.0000$/.test(who)) flags.push('code looks like a test');
  const answers = (sus?.items ?? []).map((i) => i.response);
  if (answers.length && answers.every((a) => a === answers[0])) flags.push(`every SUS answer = ${answers[0]}`);
  if (tel && tel.activeMs < 5 * 60e3) flags.push(`only ${Math.round(tel.activeMs / 1000)} s active`);
  const ua = s.env?.userAgent ?? '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '?';
  return {
    ok: true,
    line: [
      who,
      `/${s.task?.arm ?? '?'}`,
      `v${s.app?.version ?? '?'}`,
      s.app?.address ?? '',
      s.consent?.textVersion ?? '',
      (s.session?.startedIso ?? '').replace('T', ' ').slice(0, 16) + 'Z',
      tel ? `${(tel.activeMs / 60e3).toFixed(1)} min active` : 'no telemetry',
      `SUS ${sus?.score ?? '—'}`,
      sus?.professional ? 'pro block' : '',
      browser,
    ].filter(Boolean).join(' · '),
    flags,
  };
}

const day = new Date().toISOString().slice(0, 10);
const dest = join(ARCHIVE, 'new', day);
let fresh = 0;
let failed = 0;

for (const b of inboxes) {
  let names;
  try {
    names = listInbox(b);
  } catch (e) {
    console.log(`\n## ${b.label}: LISTING FAILED — ${String(e.message).split('\n')[0]}`);
    failed++;
    continue;
  }
  const todo = names.filter((n) => !have.has(stem(n)) && !ignored.has(n));
  console.log(`\n## ${b.label}: ${names.length} in inbox, ${todo.length} new`);
  for (const n of todo) {
    if (LIST_ONLY) {
      console.log(`- ${n}`);
      continue;
    }
    mkdirSync(dest, { recursive: true });
    const tmp = join(dest, n + '.part');
    const out = join(dest, n);
    try {
      curl(['-u', `${b.viewUser}:${b.viewPassword}`, '-o', tmp, `${b.publicBase}/list.php?get=${encodeURIComponent(n)}`]);
      execFileSync('unzip', ['-tq', tmp], { stdio: 'ignore' }); // whole + valid, or throw
      renameSync(tmp, out);
    } catch (e) {
      rmSync(tmp, { force: true });
      console.log(`- ${n}: DOWNLOAD FAILED (${String(e.message).split('\n')[0]}) — re-run to retry`);
      failed++;
      continue;
    }
    fresh++;
    const sum = summarise(out);
    console.log(`- ${basename(out)}\n    ${sum.line}${sum.flags?.length ? `\n    ⚠ ${sum.flags.join('; ')}` : ''}`);
  }
}

if (!LIST_ONLY) console.log(`\n${fresh} downloaded${fresh ? ` to ${dest}` : ''}${failed ? `, ${failed} FAILED` : ''}.`);
process.exit(failed ? 1 : 0);
