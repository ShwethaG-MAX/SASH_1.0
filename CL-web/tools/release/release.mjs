#!/usr/bin/env node
/**
 * Cse Hub web release tool - builds, signs and publishes offline-installable website releases.
 * No npm dependencies (Node 18+). Run from anywhere:  node tools/release/release.mjs <command>
 *
 *   init    [--android <CSEHUB dir>]          create the signing key (once) and put its PUBLIC half into the Android app
 *   build   <version> [options]               build + verify public/app-releases/<version>.zip locally (no deploy)
 *   publish <version> [options]               build, deploy ZIP, verify it LIVE, then sign + deploy version.json
 *   rollback <version>                        point all devices at an older, already published version
 *   verify  [--base-url URL]                  check what is live right now (manifest signature, ZIP hash, contents)
 *
 * options: --base-url <https://cse-c-hub.web.app>  --min-app <APK versionCode, default 8>  --keep <ZIPs to keep, default 8>
 *          --no-vendor (skip bundling the Firebase SDK)  --seed <android assets dir>  --dry-run  --force
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PUBLIC = path.join(REPO, 'public');
const RELEASES = path.join(PUBLIC, 'app-releases');
const MANIFEST = path.join(PUBLIC, 'version.json');
const KEYS = process.env.CSEHUB_KEYS_DIR || path.join(REPO, '.release-keys');
const PRIV = path.join(KEYS, 'release-private.pem');
const PUBB64 = path.join(KEYS, 'release-public.b64');
const CACHE = path.join(HERE, '.cache');
const DEFAULT_BASE = 'https://cse-c-hub.web.app';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const MAX_ZIP = 150 * 1024 * 1024;

const die = (m) => { console.error('\n✖ ' + m + '\n'); process.exit(1); };
const log = (m) => console.log(m);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

// ------------------------------------------------------------------ semver (same rules as the app)
function cmpSemver(a, b) {
  const pa = SEMVER.exec(a), pb = SEMVER.exec(b);
  for (let i = 1; i <= 3; i++) { const d = Number(pa[i]) - Number(pb[i]); if (d) return Math.sign(d); }
  const ra = pa[4] ? pa[4].split('.') : [], rb = pb[4] ? pb[4].split('.') : [];
  if (!ra.length && !rb.length) return 0; if (!ra.length) return 1; if (!rb.length) return -1;
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i], xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const d = BigInt(x) - BigInt(y); if (d) return d < 0n ? -1 : 1; }
    else if (xn) return -1; else if (yn) return 1; else if (x !== y) return x < y ? -1 : 1;
  }
  return Math.sign(ra.length - rb.length);
}

// ------------------------------------------------------------------ path safety (mirror of PathRules.kt)
function safeName(n) {
  if (!n || n.length > 240 || n.startsWith('/') || n.includes('\\') || n.includes(':')) return false;
  if ([...n].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
  const t = n.replace(/\/$/, ''); if (!t) return false;
  return t.split('/').every((s) => s && s !== '.' && s !== '..' && !s.endsWith('.') && !s.endsWith(' '));
}

// ------------------------------------------------------------------ ZIP (deterministic writer + strict reader)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function writeZip(entries) {
  const out = [], cd = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), crc = crc32(e.data);
    let method = 8, comp = zlib.deflateRawSync(e.data, { level: 9 });
    if (comp.length >= e.data.length) { method = 0; comp = e.data; }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);                       // fixed 1980-01-01 => reproducible ZIPs
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    out.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cd), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...out, cdBuf, end]);
}

function readZip(buf) {            // strict: used to verify our own output exactly like the app will unpack it
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a ZIP');
  const n = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const files = new Map();
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csz = buf.readUInt32LE(p + 20), usz = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    if (!safeName(name)) throw new Error('unsafe path in ZIP: ' + name);
    if (files.has(name.toLowerCase())) throw new Error('duplicate path: ' + name);
    const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(start, start + csz);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    if (data.length !== usz || crc32(data) !== crc) throw new Error('CRC/size mismatch: ' + name);
    files.set(name.toLowerCase(), { name, data });
    p += 46 + nl + xl + cl;
  }
  return [...files.values()];
}

// ------------------------------------------------------------------ signing (ECDSA P-256 / SHA-256, DER - what Android's SHA256withECDSA expects)
function payload(m) { return ['cse-hub-release-v1', m.version, m.releaseUrl, m.sha256, String(m.size), String(m.minimumAppVersion), String(!!m.rollback)].join('\n'); }
const loadPriv = () => { if (!fs.existsSync(PRIV)) die(`No signing key at ${PRIV}.\nRun once:  node tools/release/release.mjs init --android "<path to CSEHUB>"`); return createPrivateKey(fs.readFileSync(PRIV)); };
const signManifest = (m) => edSign('sha256', Buffer.from(payload(m)), loadPriv()).toString('base64');
const pubKeyObj = () => createPublicKey(loadPriv());
const verifyManifest = (m) => edVerify('sha256', Buffer.from(payload(m)), pubKeyObj(), Buffer.from(m.signature, 'base64'));

function makeManifest(version, zip, base, minApp, rollback) {
  const m = { schema: 1, version, releaseUrl: `${base}/app-releases/${version}.zip`, sha256: sha256(zip), size: zip.length,
              minimumAppVersion: minApp, rollback: !!rollback, publishedAt: new Date().toISOString() };
  m.signature = signManifest(m); return m;
}

// ------------------------------------------------------------------ helpers
function walk(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (d.name.startsWith('.') || d.name === 'node_modules') continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...walk(dir, r)); else if (d.isFile()) out.push(r);
  }
  return out;
}
const publishedVersions = () => fs.existsSync(RELEASES) ? fs.readdirSync(RELEASES).filter((f) => f.endsWith('.zip') && SEMVER.test(f.slice(0, -4))).map((f) => f.slice(0, -4)).sort(cmpSemver) : [];

function args() {
  const a = process.argv.slice(2), o = { _: [] };
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); const f = ['no-vendor', 'dry-run', 'force'].includes(k); o[k] = f ? true : a[++i]; } else o._.push(a[i]);
  }
  return o;
}

async function vendorFirebase(html, files) {
  const re = /https:\/\/www\.gstatic\.com\/firebasejs\/(\d+\.\d+\.\d+)\/(firebase-[a-z-]+\.js)/g;
  const need = new Map(); for (const m of html.matchAll(re)) need.set(`${m[1]}/${m[2]}`, [m[1], m[2]]);
  // the app also builds URLs from "<base>/" + file names; make sure the standard compat set is bundled for every version in use
  for (const v of new Set([...need.values()].map((x) => x[0]))) for (const f of ['app', 'auth', 'firestore', 'storage', 'functions', 'analytics']) need.set(`${v}/firebase-${f}-compat.js`, [v, `firebase-${f}-compat.js`]);
  for (const [key, [v, f]] of need) {
    const cached = path.join(CACHE, v, f);
    if (!fs.existsSync(cached)) {
      log(`  ↓ downloading ${key}`);
      const r = await fetch(`https://www.gstatic.com/firebasejs/${v}/${f}`);
      if (!r.ok) die(`Could not download ${key} (HTTP ${r.status}). Check your internet connection, or use --no-vendor.`);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length < 1000 || b.toString('utf8', 0, 200).toLowerCase().includes('<html')) die(`Downloaded ${key} does not look like JavaScript.`);
      fs.mkdirSync(path.dirname(cached), { recursive: true }); fs.writeFileSync(cached, b);
    }
    files.set(`vendor/firebase/${v}/${f}`, fs.readFileSync(cached));
  }
  const out = html.replace(/https:\/\/www\.gstatic\.com\/firebasejs\/(\d+\.\d+\.\d+)\//g, 'vendor/firebase/$1/');
  if (out.includes('gstatic.com/firebasejs')) die('Some Firebase SDK URLs could not be rewritten.');
  return out;
}

// ------------------------------------------------------------------ commands
async function build(version, o) {
  if (!SEMVER.test(version || '')) die('Give a semantic version, e.g.  1.0.0  (no "v" prefix, no +build part).');
  const zipPath = path.join(RELEASES, `${version}.zip`);
  if (fs.existsSync(zipPath) && !o.force) die(`${version} already exists. Published versions are never overwritten (use a new version, or --force).`);
  const existing = publishedVersions().filter((v) => v !== version);
  if (existing.length && cmpSemver(version, existing[existing.length - 1]) <= 0 && !o.force) die(`${version} is not newer than ${existing[existing.length - 1]}. Devices never downgrade; pick a higher version (or use the rollback command).`);
  if (!fs.existsSync(path.join(PUBLIC, 'index.html'))) die('public/index.html not found.');

  log(`\n▶ Building release ${version}`);
  const files = new Map();
  for (const rel of walk(PUBLIC)) { if (rel.startsWith('app-releases/') || rel === 'version.json') continue; files.set(rel, fs.readFileSync(path.join(PUBLIC, rel))); }
  if (!o['no-vendor']) files.set('index.html', Buffer.from(await vendorFirebase(files.get('index.html').toString('utf8'), files), 'utf8'));
  else log('  (Firebase SDK NOT bundled: --no-vendor)');

  const list = [...files.keys()].sort().map((p) => ({ path: p, size: files.get(p).length, sha256: sha256(files.get(p)) }));
  files.set('release.json', Buffer.from(JSON.stringify({ schema: 1, version, entry: 'index.html', builtAt: new Date().toISOString(), files: list }, null, 1)));
  const zip = writeZip([...files.keys()].sort().map((n) => ({ name: n, data: files.get(n) })));
  if (zip.length > MAX_ZIP) die('Release ZIP is larger than the app allows (150 MB).');

  // self-check: read the ZIP back with the same strict rules the app applies, compare to release.json
  const back = new Map(readZip(zip).map((f) => [f.name, f.data]));
  for (const f of list) if (!back.has(f.path) || sha256(back.get(f.path)) !== f.sha256) die('Self-check failed for ' + f.path);
  if (back.size !== list.length + 1) die('Self-check: unexpected file count');

  fs.mkdirSync(RELEASES, { recursive: true }); fs.writeFileSync(zipPath, zip);
  log(`  ✔ ${list.length} files → public/app-releases/${version}.zip  (${(zip.length / 1024).toFixed(0)} KB, sha256 ${sha256(zip).slice(0, 16)}…)`);

  if (o.seed) {          // refresh the website that ships INSIDE the APK so a fresh install starts with this version
    const dir = path.resolve(o.seed); fs.mkdirSync(dir, { recursive: true });
    const oldMeta = path.join(dir, 'release.json');
    if (fs.existsSync(oldMeta)) { try { for (const f of JSON.parse(fs.readFileSync(oldMeta, 'utf8')).files) if (!files.has(f.path) && safeName(f.path)) fs.rmSync(path.join(dir, f.path), { force: true }); } catch {} }
    for (const [n, d] of files) { const t = path.join(dir, n); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, d); }
    log(`  ✔ seeded Android assets: ${dir}`);
  }
  return { zip, zipPath, version };
}

function baseOf(o) { const b = (o['base-url'] || DEFAULT_BASE).replace(/\/+$/, ''); if (!b.startsWith('https://')) die('--base-url must be https://'); return b; }
function firebaseDeploy() {
  let project = 'cse-c-hub'; try { project = JSON.parse(fs.readFileSync(path.join(REPO, '.firebaserc'), 'utf8')).projects.default || project; } catch {}
  log(`\n▶ firebase deploy --only hosting --project ${project}`);
  const r = spawnSync('firebase', ['deploy', '--only', 'hosting', '--project', project], { cwd: REPO, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error || r.status !== 0) die('Deploy failed. Is the Firebase CLI installed and are you logged in (firebase login)?');
}
async function getLive(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { headers: { 'cache-control': 'no-cache' } }); if (r.ok) return Buffer.from(await r.arrayBuffer()); } catch {}
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

async function publish(version, o) {
  const base = baseOf(o), minApp = Number(o['min-app'] || 8);
  const { zip } = await build(version, o);
  if (o['dry-run']) { log('\n(dry run: nothing deployed, version.json untouched)'); return; }
  firebaseDeploy();                                    // phase 1: ZIP goes live, version.json still points at the old release
  log('\n▶ Checking the ZIP is live and intact…');
  const live = await getLive(`${base}/app-releases/${version}.zip`);
  if (!live || sha256(live) !== sha256(zip)) die('The live ZIP is missing or differs from the local build. version.json was NOT changed, so no device is affected. Re-run publish with --force.');
  log('  ✔ live ZIP matches');
  const m = makeManifest(version, zip, base, minApp, false);
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  firebaseDeploy();                                    // phase 2: switch devices to the new release
  await verify(o);
  prune(Number(o.keep || 8), version);
  log(`\n✔ ${version} is live. Devices pick it up on their next check.\n  IMPORTANT: commit public/app-releases/ and public/version.json to git, or the GitHub deploy workflow will delete them from the live site.`);
}

async function rollback(version, o) {
  if (!SEMVER.test(version || '')) die('Give the version to roll back to.');
  const zp = path.join(RELEASES, `${version}.zip`); if (!fs.existsSync(zp)) die(`public/app-releases/${version}.zip is not on disk (pruned?). Rebuild it with a NEW version number instead.`);
  const m = makeManifest(version, fs.readFileSync(zp), baseOf(o), Number(o['min-app'] || 8), true);
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n');
  if (o['dry-run']) return log('(dry run) manifest written locally only');
  firebaseDeploy(); await verify(o);
  log(`\n✔ Devices will switch to ${version} even though it is older than what they run. Publish a fixed, higher version afterwards.`);
}

async function verify(o) {
  const base = baseOf(o); log('\n▶ Verifying what is live…');
  const mb = await getLive(`${base}/version.json`); if (!mb) die('Could not fetch the live version.json.');
  const m = JSON.parse(mb.toString('utf8'));
  if (!verifyManifest(m)) die('LIVE version.json has an INVALID signature for your key!');
  const zb = await getLive(m.releaseUrl); if (!zb) die('Could not fetch ' + m.releaseUrl);
  if (sha256(zb) !== m.sha256 || zb.length !== m.size) die('Live ZIP does not match the manifest.');
  const meta = JSON.parse(readZip(zb).find((f) => f.name === 'release.json').data.toString('utf8'));
  if (meta.version !== m.version) die('release.json inside the ZIP has a different version.');
  log(`  ✔ live version ${m.version}: signature valid, ZIP hash valid, ${meta.files.length} files, min app versionCode ${m.minimumAppVersion}${m.rollback ? ' (ROLLBACK)' : ''}`);
}

function prune(keep, current) {
  const all = publishedVersions(); const del = all.slice(0, Math.max(0, all.length - keep)).filter((v) => v !== current);
  for (const v of del) { fs.rmSync(path.join(RELEASES, `${v}.zip`)); log(`  🧹 removed old ZIP ${v}`); }
}

function init(o) {
  fs.mkdirSync(KEYS, { recursive: true });
  if (!fs.existsSync(PRIV) || o.force) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    fs.writeFileSync(PRIV, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    log(`✔ Created signing key: ${PRIV}\n  KEEP IT PRIVATE and BACK IT UP. Anyone with this file can push code into your app. It is git-ignored.`);
  } else log('Signing key already exists (kept).');
  const pub = createPublicKey(loadPriv()).export({ type: 'spki', format: 'der' }).toString('base64');
  fs.writeFileSync(PUBB64, pub + '\n');
  if (o.android) {
    const cfg = path.join(path.resolve(o.android), 'app/src/main/java/com/study/csehub/update/UpdateConfig.kt');
    if (!fs.existsSync(cfg)) die('UpdateConfig.kt not found under ' + o.android);
    let t = fs.readFileSync(cfg, 'utf8');
    const re = /(\/\/ BEGIN-TRUSTED-KEYS)[\s\S]*?(\/\/ END-TRUSTED-KEYS)/;
    if (!re.test(t)) die('BEGIN/END-TRUSTED-KEYS markers missing in UpdateConfig.kt');
    fs.writeFileSync(cfg, t.replace(re, `$1\n        "${pub}",\n        $2`));
    log(`✔ Public key written into ${cfg}\n  Rebuild and install the APK ONE more time so the app trusts your key.`);
  } else log('Public key (add to UpdateConfig.TRUSTED_PUBLIC_KEYS):\n' + pub);
}

const o = args(), [cmd, arg] = o._;
const run = { init: () => init(o), build: () => build(arg, o), publish: () => publish(arg, o), rollback: () => rollback(arg, o), verify: () => verify(o) }[cmd];
if (!run) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace('#!/usr/bin/env node\n/**', '')); process.exit(cmd ? 1 : 0); }
Promise.resolve(run()).catch((e) => die(e.stack || String(e)));
