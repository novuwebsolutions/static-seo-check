import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  blockedBy,
  check,
  decodeEntities,
  loadPlaywright,
  makeResolver,
  parseArgs,
  parseRedirects,
  parseRobots,
  listFiles,
  readHtml,
  readSitemaps,
  sitemapLocs,
} from '../static-seo-check.mjs';

const fixture = (name) => fileURLToPath(new URL(`./fixture/${name}`, import.meta.url));
const cli = fileURLToPath(new URL('../static-seo-check.mjs', import.meta.url));
const runCli = (args, options = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });

/** A throwaway site from { 'path/file': 'content' }, with the share picture doc() names. */
function site(files) {
  const root = mkdtempSync(join(tmpdir(), 'static-seo-check-'));
  for (const [file, content] of Object.entries({ 'og.png': '', ...files })) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

let pages = 0;
/** A page that passes every check unless told otherwise; titles and descriptions differ per call. */
const doc = ({ head = '', body = '<h1>Pealkiri</h1>' } = {}) => {
  pages++;
  return `<!doctype html><html><head><title>Leht ${pages}</title><meta name="description" content="Leht number ${pages}: kirjeldus, mis on piisavalt pikk, et otsingutulemustes midagi öelda."><meta property="og:image" content="https://example.ee/og.png">${head}</head><body>${body}</body></html>`;
};

// --- Reading HTML -----------------------------------------------------------

test('reads attributes in any order, quoted with " or \' or not at all', () => {
  const page = readHtml(`<!doctype html><head>
    <META CONTENT='Tere &amp; head' NAME=description>
    <link href=https://example.ee/a/ rel=canonical>
    <link hreflang="en" href='https://example.ee/en/' rel="alternate">
    <meta content="https://example.ee/og.png" property="og:image">
    </head><body><a title="a > b" href=/teenused/>x</a><area alt=x href="/kaart">`);
  assert.equal(page.description, 'Tere & head');
  assert.deepEqual(page.canonicals, ['https://example.ee/a/']);
  assert.deepEqual(page.alternates, [{ lang: 'en', href: 'https://example.ee/en/' }]);
  assert.equal(page.ogImage, 'https://example.ee/og.png');
  assert.deepEqual(page.links, [
    { tag: 'a', href: '/teenused/' },
    { tag: 'area', href: '/kaart' },
  ]);
});

test('skips comments, scripts, styles and templates, and keeps JSON-LD', () => {
  const page = readHtml(`<!doctype html><html><head><title>T</title>
    <script>document.write("<h1>no</h1><a href='/script/'>")</script>
    <style>h1 > a[href="/style/"] { color: red }</style>
    <script type="application/ld+json">{"@type":"Thing","name":"</h1>"}</script>
    </head><body>
    <!-- <h1>old</h1> <a href="/comment/">old</a> -->
    <!--> <h1>Real</h1>
    <template><h1>later</h1><a href="/template/">x</a><template><h1>nested</h1></template></template>
    <textarea><a href="/textarea/"></textarea>
    <a href="/real/">real</a></body></html>`);
  assert.equal(page.h1, 1);
  assert.deepEqual(page.links, [{ tag: 'a', href: '/real/' }]);
  assert.deepEqual(page.jsonld, ['{"@type":"Thing","name":"</h1>"}']);
});

test("an SVG icon's title is not the page's title", () => {
  const page = readHtml('<!doctype html><body><svg><title>Ikoon</title><use href="#i"/></svg><h1>X</h1></body>');
  assert.equal(page.title, null);
  assert.equal(page.h1, 1);
  assert.equal(readHtml('<html><head><title>Leht</title></head><svg><title>Ikoon</title></svg>').title, 'Leht');
});

test('decodes entities in titles and descriptions and collapses their spaces', () => {
  const page = readHtml('<title>\n  Teenused &amp; hinnad &ndash; N&auml;idis\n</title><meta name="description" content="V&otilde;ta &#8222;ühendust&#8220; &#x2014; kohe&#150;praegu &bogus;">');
  assert.equal(page.title, 'Teenused & hinnad – Näidis');
  assert.equal(page.description, 'Võta „ühendust“ — kohe–praegu &bogus;');
  assert.equal(decodeEntities('&Otilde;&Uuml;&szlig;&yuml;&scaron;&nbsp;&#0;'), 'ÕÜßÿš �');
});

test('reads noindex, meta refresh and <base>, and tells pages from fragments', () => {
  assert.equal(readHtml('<meta name="robots" content="max-image-preview:large, NOINDEX">').noindex, true);
  assert.equal(readHtml('<meta name=robots content=none>').noindex, true);
  assert.equal(readHtml('<meta name="robots" content="index, follow">').noindex, false);
  assert.equal(readHtml('<!doctype html><meta http-equiv="refresh" content="0;url=/uus/">').refresh, '/uus/');
  assert.equal(readHtml("<meta http-equiv=Refresh content=\"2; URL='https://example.ee/x'\">").refresh, 'https://example.ee/x');
  assert.equal(readHtml('<head><base href="/docs/"></head>').base, '/docs/');
  assert.equal(readHtml('google-site-verification: google0123456789abcdef.html').document, false);
  assert.equal(readHtml('<p>Fragment</p>').document, false);
  assert.equal(readHtml('﻿<!-- built --><!DOCTYPE html><p>x').document, true);
});

test('reads canonical, language links, robots and description only in <head>, as browsers end it', () => {
  // An <img> ends the head where it stands, even before </head>.
  const early = readHtml('<!doctype html><head><title>T</title><img src="/p.gif"><meta name="description" content="D"><link rel="canonical" href="/a/"><link rel="alternate" hreflang="en" href="/en/"><meta name="robots" content="noindex"></head><body><h1>X</h1>');
  assert.equal(early.headEnd, 'img');
  assert.deepEqual([early.description, early.canonicals, early.alternates, early.noindex], [null, [], [], false]);
  assert.deepEqual(early.outside, { canonical: 1, alternates: 1, robots: true, description: true });
  assert.equal(early.title, 'T');
  // After </head> but before <body> a <link> is still put in the head; in <body> it is not.
  const late = readHtml('<!doctype html><head><title>T</title></head><link rel="canonical" href="/a/"><body><link rel="canonical" href="/b/"></body>');
  assert.deepEqual([late.canonicals, late.outside.canonical, late.headEnd], [['/a/'], 1, null]);
  // A <noscript> in the head is text to a browser that runs scripts.
  const pixel = readHtml('<!doctype html><head><noscript><img src="/p.gif"></noscript><link rel="canonical" href="/a/"></head>');
  assert.deepEqual([pixel.canonicals, pixel.headEnd], [['/a/'], null]);
});

test('reads old entity names without a semicolon, and old document.write scripts, as browsers do', () => {
  assert.equal(readHtml('<title>Hind &amp 100 &copy 2026</title>').title, 'Hind & 100 © 2026');
  assert.equal(decodeEntities('&notit; &ampx', 'text'), '¬it; &x');
  assert.equal(decodeEntities('?a=1&copy=2&amp 3', 'attribute'), '?a=1&copy=2& 3', 'not in an attribute before a letter or "="');
  assert.equal(decodeEntities('a&amp b&amp;c', 'xml'), 'a&amp b&c');
  const page = readHtml(`<!doctype html><script><!-- document.write('<script src="x.js"></script><h1>Hi</h1>'); --></script><h1>Real</h1>`);
  assert.equal(page.h1, 1);
});

// --- Addresses ----------------------------------------------------------------

test('finds the file for an address the way static hosts do', () => {
  const files = new Set(['index.html', 'teenused/index.html', 'kontakt.html', 'files/hind.pdf', 'õpe/index.html']);
  const { resolve } = makeResolver(files);
  assert.deepEqual(resolve('/'), { file: 'index.html', via: 'index', chain: [] });
  assert.equal(resolve('/teenused/').file, 'teenused/index.html');
  assert.equal(resolve('/teenused').via, 'dir');
  assert.equal(resolve('/kontakt').file, 'kontakt.html');
  assert.equal(resolve('/kontakt.html').via, 'file');
  assert.equal(resolve('/files/hind.pdf').file, 'files/hind.pdf');
  assert.equal(resolve('/õpe/').file, 'õpe/index.html');
  assert.equal(resolve('/kontakt/').file, null, '/x/ is only x/index.html');
  assert.equal(resolve('/Teenused/').file, null, 'hosts are case-sensitive even when this disk is not');
  assert.equal(resolve('/puudub/').file, null);
  // .htm pages, as some hand-written sites have them.
  const htm = makeResolver(new Set(['index.htm', 'meist/index.htm', 'kontakt.htm'])).resolve;
  assert.deepEqual([htm('/').file, htm('/meist/').file, htm('/meist').via, htm('/kontakt').file], ['index.htm', 'meist/index.htm', 'dir', 'kontakt.htm']);
});

test('a catch-all rewrite (/* /index.html 200) does not make every address a page', () => {
  const rules = parseRedirects('/blog/*  /news/:splat  200\n/*  /index.html  200');
  assert.deepEqual(rules.map((rule) => rule.catchAll), [false, true]);
  const { resolve } = makeResolver(new Set(['index.html', 'news/a/index.html']), rules);
  assert.equal(resolve('/blog/a/').catchAll, undefined);
  assert.equal(resolve('/puudub/').catchAll.from, '/*');
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">', body: '<h1>X</h1><a href="/puudub/">x</a>' }),
    _redirects: '/*  /index.html  200',
    'sitemap.xml': '<urlset><url><loc>https://example.ee/</loc></url><url><loc>https://example.ee/vana/</loc></url></urlset>',
  });
  const found = check({ dist: root }).findings.map((f) => [f.where, f.level, f.message]);
  assert.deepEqual(found, [
    ['/', 'error', 'link to /puudub/ is not in the build; only the catch-all rewrite /* → /index.html (200) answers it, the same page for any address, which search engines read as a missing page'],
    ['sitemap.xml', 'error', 'lists https://example.ee/vana/, which is not in the build; only the catch-all rewrite /* → /index.html (200) answers it, the same page for any address, which search engines read as a missing page'],
  ]);
});

test('file names stored decomposed (NFD) are found by their composed name', () => {
  const root = site({ 'o\u0303pe/index.html': doc() });
  const real = new Map();
  assert.deepEqual([...listFiles(root, real)], ['og.png', 'õpe/index.html']);
  assert.equal(real.get('õpe/index.html'), 'o\u0303pe/index.html');
});

test('follows _redirects rules: splats, placeholders, chains and gone pages', () => {
  const rules = parseRedirects(`
    # comment
    /vana/          /teenused/          301
    /artiklid/*     /uudised/:splat     301
    /pood/:id       /tooted/:id/        302
    /ring/          /ring2/
    /ring2/         /ring/
    /kadunud/       /puudub/            301
    /eemaldatud/*   /404.html           404
    /mujale/        https://other.example/x 301
    /store id=:id   /tooted/:id/        301
    https://old.example/* /teenused/  301`);
  assert.equal(rules.length, 9);
  const { resolve } = makeResolver(new Set(['teenused/index.html', 'uudised/uus/index.html', 'tooted/7/index.html', '404.html']), rules);
  assert.deepEqual(resolve('/vana/'), { file: 'teenused/index.html', via: 'redirect', chain: ['/teenused/'] });
  assert.equal(resolve('/vana').file, 'teenused/index.html', '/old and /old/ match the same rule');
  assert.equal(resolve('/artiklid/uus/').file, 'uudised/uus/index.html');
  assert.equal(resolve('/pood/7').file, 'tooted/7/index.html');
  assert.equal(resolve('/ring/').file, null);
  assert.deepEqual(resolve('/kadunud/'), { file: null, chain: ['/puudub/'] });
  assert.equal(resolve('/eemaldatud/x').file, null, 'a 404 rule is no page');
  assert.equal(resolve('/mujale/').external, true);
  assert.equal(resolve('/vana/', { follow: false }).file, null);
});

// --- Sitemaps and robots.txt ----------------------------------------------------

test('follows robots.txt, redirects, nested sitemap indexes and gzip to the page addresses', () => {
  const root = site({
    'robots.txt': 'User-agent: *\nAllow: /\nSitemap: https://example.ee/sitemap.xml\n',
    _redirects: '/sitemap.xml /sitemap-index.xml 301\n',
    'sitemap-index.xml': '<sitemapindex><sitemap><loc>https://example.ee/kaardid/index.xml</loc></sitemap></sitemapindex>',
    'kaardid/index.xml': '<?xml version="1.0"?><sitemapindex><!-- <sitemap><loc>https://example.ee/vana.xml</loc></sitemap> --><sitemap><loc>https://example.ee/sitemap-a.xml</loc></sitemap><sitemap><loc> https://example.ee/sitemap-b.xml.gz </loc></sitemap><sitemap><loc>https://example.ee/puudub.xml</loc></sitemap></sitemapindex>',
    'sitemap-a.xml': '<urlset><url><loc>https://example.ee/</loc><image:image><image:loc>https://example.ee/pilt.jpg</image:loc></image:image></url><url><loc><![CDATA[https://example.ee/a?x=1&y=2]]></loc></url></urlset>',
    'sitemap-b.xml.gz': gzipSync('<urlset><url><loc>https://example.ee/b/?x=1&amp;y=2</loc></url></urlset>'),
  });
  const files = new Set(['robots.txt', '_redirects', 'sitemap-index.xml', 'kaardid/index.xml', 'sitemap-a.xml', 'sitemap-b.xml.gz']);
  const resolver = makeResolver(files, parseRedirects('/sitemap.xml /sitemap-index.xml 301'));
  const robots = parseRobots('Sitemap: https://example.ee/sitemap.xml');
  const result = readSitemaps({ root, resolver, robots });
  assert.deepEqual(result.files, ['sitemap-index.xml', 'kaardid/index.xml', 'sitemap-a.xml', 'sitemap-b.xml.gz']);
  assert.deepEqual(
    result.entries.map((entry) => entry.url),
    ['https://example.ee/', 'https://example.ee/a?x=1&y=2', 'https://example.ee/b/?x=1&y=2'],
  );
  assert.deepEqual(result.problems, [{ where: 'kaardid/index.xml', message: 'lists the sitemap https://example.ee/puudub.xml, which is not in the build' }]);
  assert.deepEqual(sitemapLocs('<urlset><url><loc>https://example.ee/</loc></url></urlset>'), { index: false, locs: ['https://example.ee/'] });
  // A prefix on the tags, as Python's ElementTree writes them.
  assert.deepEqual(
    sitemapLocs('<ns0:urlset xmlns:ns0="http://www.sitemaps.org/schemas/sitemap/0.9"><ns0:url><ns0:loc>https://example.ee/</ns0:loc><image:loc>https://example.ee/p.jpg</image:loc></ns0:url></ns0:urlset>'),
    { index: false, locs: ['https://example.ee/'] },
  );
});

test('a sitemap that redirects to a full address on the site is followed', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">' }),
    'robots.txt': 'Sitemap: https://example.ee/sitemap.xml\n',
    _redirects: '/sitemap.xml  https://example.ee/sitemap-index.xml  301',
    'sitemap-index.xml': '<sitemapindex><sitemap><loc>https://example.ee/sitemap-0.xml</loc></sitemap></sitemapindex>',
    'sitemap-0.xml': '<urlset><url><loc>https://example.ee/</loc></url></urlset>',
  });
  for (const opts of [{ site: 'https://example.ee' }, {}]) assert.deepEqual(check({ dist: root, ...opts }).findings, []);
});

test('reads robots.txt groups and rules the way crawlers match them', () => {
  const robots = parseRobots(`# comment
User-agent: Googlebot
Disallow: /

User-agent: Bingbot
User-agent: *
Disallow: /admin/
Allow: /admin/avalik/
Disallow: /*.pdf$
Disallow:
Sitemap: https://example.ee/sitemap-index.xml`);
  assert.deepEqual(robots.sitemaps, ['https://example.ee/sitemap-index.xml']);
  assert.equal(robots.rules.length, 3, 'only the group for every crawler, without the empty Disallow');
  assert.equal(blockedBy(robots.rules, '/admin/x/').path, '/admin/');
  assert.equal(blockedBy(robots.rules, '/admin/avalik/x/'), null, 'the longer Allow wins');
  assert.equal(blockedBy(robots.rules, '/hind.pdf').path, '/*.pdf$');
  assert.equal(blockedBy(robots.rules, '/hind.pdf/'), null);
  assert.equal(blockedBy(robots.rules, '/'), null);
});

// --- Whole sites --------------------------------------------------------------

test('the good site passes clean', () => {
  const human = runCli(['--dist', fixture('good')]);
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /^7 pages read, 4 indexable, 4 in the sitemap\. All clear\.$/m);
  const json = runCli(['--dist', fixture('good'), '--json']);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(report.site, 'https://example.ee');
});

test('the bad site fires every check, each with its message', () => {
  const result = runCli(['--dist', fixture('bad'), '--json']);
  assert.equal(result.status, 1);
  const { findings, errors, warnings } = JSON.parse(result.stdout);
  const expected = [
    ['/', 'link', 'error', /^link to \/puudub\/, which is not in the build$/],
    ['/', 'link', 'error', /^link to \/vana-hinnad\/ redirects to \/hinnad\/, which is not in the build$/],
    ['/', 'json-ld', 'error', /^JSON-LD block 1 does not parse: /],
    ['/', 'hreflang', 'error', /^https:\/\/example\.ee\/en\/ \(en\) does not link back to this page$/],
    ['/', 'og-image', 'warning', /^no og:image/],
    ['/en/', 'sitemap', 'warning', /^the sitemap lists it as https:\/\/example\.ee\/en, its canonical is https:\/\/example\.ee\/en\/$/],
    ['/kontakt/', 'h1', 'error', /^2 h1 headings, should be 1$/],
    ['/kontakt/', 'canonical', 'warning', /^no canonical link; search engines then choose the address themselves$/],
    ['/kontakt/', 'link', 'warning', /^linked as \/kontakt from 1 page \(\/\); its address is https:\/\/example\.ee\/kontakt\/$/],
    ['/pikk/', 'hreflang', 'error', /^language link \(fi\) https:\/\/example\.ee\/tanud\/ asks to stay out of search \(noindex\)$/],
    ['/pikk/', 'hreflang', 'error', /^hreflang "en_US" is not a language code/],
    ['/pikk/', 'hreflang', 'error', /^https:\/\/example\.ee\/en\/ \(en_US\) does not link back to this page$/],
    ['/pikk/', 'robots', 'error', /^robots\.txt keeps crawlers out \(Disallow: \/pikk\/\)$/],
    ['/pikk/', 'title', 'warning', /^title is 78 characters/],
    ['/pikk/', 'description', 'warning', /^description is 184 characters/],
    ['/pikk/', 'sitemap', 'error', /^not in the sitemap$/],
    ['/tanud/', 'link', 'warning', /^link to \/kadunud\/, which is not in the build$/],
    ['/teenused/', 'h1', 'error', /^no h1 heading$/],
    ['/teenused/', 'description', 'error', /^no meta description$/],
    ['/teenused/', 'title', 'error', /^same title as \/kontakt\/$/],
    ['/teenused/', 'canonical', 'error', /^canonical https:\/\/example\.ee\/tanud\/ is another page \(\/tanud\/\), which asks to stay out of search \(noindex\)$/],
    ['/teenused/', 'og-image', 'error', /^og:image \/og\/puudub\.png is not in the build$/],
    ['/teenused/', 'og-image', 'warning', /^og:image \/og\/puudub\.png is relative/],
    ['/vana/', 'link', 'error', /^redirects \(meta refresh\) to \/olematu-siht\/, which is not in the build$/],
    ['robots.txt', 'robots', 'warning', /^does not name the sitemap; add "Sitemap: https:\/\/example\.ee\/sitemap-index\.xml"/],
    ['sitemap-0.xml', 'sitemap', 'error', /^lists https:\/\/example\.ee\/tanud\/, which asks to stay out of search \(noindex\)$/],
    ['sitemap-0.xml', 'sitemap', 'error', /^lists https:\/\/example\.ee\/olematu\/, which is not in the build$/],
    ['sitemap-0.xml', 'sitemap', 'error', /^lists 1 address on http:\/\/example\.ee, not https:\/\/example\.ee \(http:\/\/example\.ee\/kontakt\/\)$/],
    ['sitemap-index.xml', 'sitemap', 'error', /^lists the sitemap https:\/\/example\.ee\/sitemap-1\.xml, which is not in the build$/],
  ];
  for (const [where, check, level, message] of expected) {
    const hits = findings.filter((f) => f.where === where && f.check === check && f.level === level && message.test(f.message));
    assert.equal(hits.length, 1, `${level} ${where} ${check} ${message}\nfound:\n${findings.map((f) => `${f.level} ${f.where} ${f.check} ${f.message}`).join('\n')}`);
  }
  // Nothing else: the error page, the noindex page's missing description and
  // the redirect page are not findings, and /kontakt/, which the sitemap lists
  // on http://, is not also "not in the sitemap".
  assert.equal(findings.length, expected.length);
  assert.equal(errors, expected.filter((e) => e[2] === 'error').length);
  assert.equal(warnings, expected.filter((e) => e[2] === 'warning').length);

  const human = runCli(['--dist', fixture('bad')]);
  assert.match(human.stdout, /^\/teenused\/\n {2}✗ no h1 heading$/m);
  assert.match(human.stdout, /^8 pages read, 5 indexable, 6 in the sitemap: 20 errors, 9 warnings\.$/m);
});

test('--ignore leaves out pages, links and sitemap entries under a path', () => {
  const { findings } = check({ dist: fixture('bad'), ignore: ['/pikk/', '/puudub/', '/olematu/'] });
  assert.ok(!findings.some((f) => f.where === '/pikk/'));
  assert.ok(!findings.some((f) => /puudub\/|olematu\//.test(f.message)));
  assert.ok(findings.some((f) => f.where === '/teenused/'));
});

test('no sitemap and no site address are one warning each', () => {
  const root = site({ 'index.html': doc(), 'a/index.html': doc() });
  const { findings, errors } = check({ dist: root });
  assert.deepEqual(
    findings.filter((f) => f.where === 'site').map((f) => f.check),
    ['site', 'sitemap'],
  );
  const canonical = findings.filter((f) => f.check === 'canonical');
  assert.deepEqual(canonical.map((f) => f.level), ['warning', 'warning'], 'a missing canonical is a hint, not an error');
  assert.equal(errors, 0);
});

test('an empty folder, or a server build instead of its pages, is a clear message', () => {
  const empty = runCli(['--dist', site({ 'assets/app.js': '' })]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /^static-seo-check: no HTML pages in /);
  const astro = site({ 'client/index.html': doc(), 'server/entry.mjs': '' });
  const nested = runCli(['--dist', astro]);
  assert.equal(nested.status, 1);
  assert.match(nested.stderr, /has no index\.html, but .*client has one: give --dist .*client$/m);
});

test('error pages are named by the host, not every numbered folder', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">', body: '<h1>X</h1><a href="/tooted/450/">a</a><a href="/mudelid/404/">b</a>' }),
    'tooted/450/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/tooted/450/">' }),
    'mudelid/404/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/mudelid/404/">', body: '<p>Mudel 404</p>' }),
    '404.html': '<!doctype html><title>Ei leitud</title>',
    'en/404.html': '<!doctype html><title>Not found</title>',
    'sitemap.xml': `<urlset>${['', 'tooted/450/', 'mudelid/404/'].map((p) => `<url><loc>https://example.ee/${p}</loc></url>`).join('')}</urlset>`,
  });
  const found = check({ dist: root }).findings.map((f) => [f.where, f.message]);
  assert.deepEqual(found, [['/mudelid/404/', 'no h1 heading']]);
});

test('search engine verification files are not pages', () => {
  const root = site({
    'index.html': doc(),
    'google0123456789abcdef.html': 'google-site-verification: google0123456789abcdef.html',
    'yandex_0123456789abcdef.html': '<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>Verification: 0123456789abcdef</body></html>',
  });
  assert.equal(check({ dist: root }).pages, 1);
});

test('a page whose canonical names another page is a duplicate, kept out of the sitemap', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">' }),
    'hinnad/index.html': '<!doctype html><title>Hinnad</title><meta name="description" content="Kõik hinnad ühel lehel: saunad, terrassid ja hooldus, koos paigaldusega üle Eesti."><link rel="canonical" href="https://example.ee/hinnad/"><h1>Hinnad</h1>',
    'hinnad/print/index.html': '<!doctype html><title>Hinnad</title><meta name="description" content="Kõik hinnad ühel lehel: saunad, terrassid ja hooldus, koos paigaldusega üle Eesti."><link rel="canonical" href="https://example.ee/hinnad/"><h1>Hinnad</h1>',
    'kampaania/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">' }),
    'sitemap.xml': '<urlset><url><loc>https://example.ee/</loc></url><url><loc>https://example.ee/hinnad/</loc></url><url><loc>https://example.ee/kampaania/</loc></url></urlset>',
  });
  const report = check({ dist: root });
  assert.deepEqual(
    report.findings.filter((f) => f.check !== 'og-image').map((f) => [f.where, f.level, f.message]),
    [
      ['/hinnad/print/', 'warning', 'canonical https://example.ee/hinnad/ is another page, so search engines show /hinnad/ instead of this one'],
      ['/kampaania/', 'warning', 'canonical https://example.ee/ is another page, so search engines show / instead of this one'],
      ['sitemap.xml', 'error', 'lists https://example.ee/kampaania/, whose canonical is another page (/)'],
    ],
  );
  assert.equal(report.indexable, 2);
});

test('canonical: a file name or a query instead of the address', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/index.html">' }),
    'teenused/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/teenused/?ref=menu">' }),
  });
  const found = check({ dist: root, site: 'https://example.ee' }).findings.filter((f) => f.check === 'canonical');
  assert.deepEqual(
    found.map((f) => [f.where, f.level, f.message]),
    [
      ['/', 'warning', "canonical https://example.ee/index.html names the file; the page's address is https://example.ee/, and many hosts redirect the one to the other"],
      ['/teenused/', 'warning', 'canonical https://example.ee/teenused/?ref=menu carries a query (?ref=menu); give the address without it'],
    ],
  );
});

test('the site address comes from the pages first, so a wrong sitemap is one error', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">' }),
    'meist/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/meist/">' }),
    'sitemap.xml': '<urlset><url><loc>http://example.ee/</loc></url><url><loc>http://example.ee/meist/</loc></url></urlset>',
  });
  const errors = check({ dist: root }).findings.filter((f) => f.level === 'error');
  assert.deepEqual(
    errors.map((f) => [f.where, f.message]),
    [['sitemap.xml', 'lists 2 addresses on http://example.ee, not https://example.ee (http://example.ee/)']],
    'no canonical errors, and no "not in the sitemap" on each page',
  );
});

test('the same address in other spellings (%C3%B5, %c3%b5, õ) is the same', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">', body: '<h1>X</h1><a href="/k%C3%B5ik/">a</a><a href="/kõik/">b</a>' }),
    'kõik/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/k%c3%b5ik/">' }),
    'sitemap.xml': '<urlset><url><loc>https://example.ee/</loc></url><url><loc>https://example.ee/k%C3%B5ik/</loc></url></urlset>',
  });
  assert.deepEqual(check({ dist: root }).findings, []);
});

test('tags that only count in <head> are errors when they stand after it', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">' }),
    'a/index.html': '<!doctype html><title>Leht A</title><img src="/p.gif"><meta name="description" content="Leht A: kirjeldus, mis on piisavalt pikk, et otsingutulemustes midagi öelda."><link rel="canonical" href="https://example.ee/a/"><meta name="robots" content="noindex"><body><h1>A</h1>',
    'b/index.html': doc({ body: '<h1>B</h1><link rel="canonical" href="https://example.ee/b/"><link rel="alternate" hreflang="et" href="https://example.ee/b/">' }),
    'sitemap.xml': `<urlset>${['', 'a/', 'b/'].map((p) => `<url><loc>https://example.ee/${p}</loc></url>`).join('')}</urlset>`,
  });
  const found = check({ dist: root }).findings.filter((f) => f.check !== 'og-image');
  assert.deepEqual(
    found.map((f) => [f.where, f.check, f.level, f.message]),
    [
      ['/a/', 'robots', 'error', 'meta robots noindex is after <img>, which ends <head>; search engines read it only in <head>, so the page can be indexed'],
      ['/a/', 'canonical', 'error', 'canonical link is after <img>, which ends <head>; search engines read it only in <head>'],
      ['/a/', 'description', 'error', 'meta description is after <img>, which ends <head>; search engines read it only in <head>'],
      ['/b/', 'hreflang', 'error', '1 language link is in <body>; search engines read them only in <head>'],
      ['/b/', 'canonical', 'error', 'canonical link is in <body>; search engines read it only in <head>'],
    ],
  );
});

test('language links: relative addresses, and versions that share a title', () => {
  const alternates = '<link rel="alternate" hreflang="et" href="/"><link rel="alternate" hreflang="en" href="https://example.ee/en/">';
  const root = site({
    'index.html': '<!doctype html><title>Näidis</title><meta name="description" content="Näidis OÜ ehitab saunu ja terrasse üle Eesti; vaata töid ja hindu ning võta ühendust.">' + `<link rel="canonical" href="https://example.ee/">${alternates}<h1>X</h1>`,
    'en/index.html': '<!doctype html><title>Näidis</title><meta name="description" content="Näidis builds saunas and terraces all over Estonia; see our work and prices and get in touch.">' + `<link rel="canonical" href="https://example.ee/en/">${alternates}<h1>X</h1>`,
    'sitemap.xml': '<urlset><url><loc>https://example.ee/</loc></url><url><loc>https://example.ee/en/</loc></url></urlset>',
  });
  const found = check({ dist: root }).findings.filter((f) => f.check !== 'og-image');
  assert.deepEqual(
    found.map((f) => [f.where, f.check, f.level, f.message]),
    [
      ['/', 'hreflang', 'error', 'language link (et) / is relative; search engines need the full https:// address'],
      ['/', 'title', 'warning', 'same title as /en/, its other language version'],
      ['/en/', 'hreflang', 'error', 'language link (et) / is relative; search engines need the full https:// address'],
    ],
  );
});

test('links that reach a page by another address than its own are one warning per address', () => {
  const nav = '<a href="meist.html">a</a><a href="/teenused">b</a><a href="/en/index.html">c</a><a href="/kontakt/">d</a>';
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">', body: `<h1>X</h1>${nav}` }),
    'meist.html': doc({ head: '<link rel="canonical" href="https://example.ee/meist">', body: `<h1>X</h1>${nav}` }),
    'teenused/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/teenused/">' }),
    'en/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/en/">' }),
    'kontakt.html': doc({ head: '<link rel="canonical" href="https://example.ee/kontakt">' }),
    'sitemap.xml': `<urlset>${['', 'meist', 'teenused/', 'en/', 'kontakt'].map((p) => `<url><loc>https://example.ee/${p}</loc></url>`).join('')}</urlset>`,
  });
  const found = check({ dist: root }).findings.filter((f) => f.check === 'link');
  assert.deepEqual(
    found.map((f) => [f.where, f.level, f.message]),
    [
      ['/', 'error', 'link to /kontakt/, but the page is kontakt.html, at /kontakt without the closing slash; some hosts redirect, others answer 404'],
      ['/en/', 'warning', 'linked as /en/index.html from 2 pages (/, /meist.html); its address is https://example.ee/en/'],
      ['/meist.html', 'error', 'link to /kontakt/, but the page is kontakt.html, at /kontakt without the closing slash; some hosts redirect, others answer 404'],
      ['/meist.html', 'warning', 'linked as /meist.html from 2 pages (/, /meist.html); its address is https://example.ee/meist'],
      ['/teenused/', 'warning', 'linked as /teenused from 2 pages (/, /meist.html); its address is https://example.ee/teenused/'],
    ],
  );
});

test('a meta refresh that only reloads the page is no redirect', () => {
  const root = site({
    'index.html': doc({ head: '<meta http-equiv="refresh" content="300; url=/"><link rel="canonical" href="https://example.ee/">' }),
    'sitemap.xml': '<urlset><url><loc>https://example.ee/</loc></url></urlset>',
  });
  assert.deepEqual(check({ dist: root }).findings, []);
});

test('canonical: relative, without its slash, disagreeing, elsewhere and redirected', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/">' }),
    'a/index.html': doc({ head: '<link rel="canonical" href="/a/">' }),
    'b/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/b">' }),
    'c/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/c/"><link rel="canonical" href="https://example.ee/x/">' }),
    'd/index.html': doc({ head: '<link rel="canonical" href="https://www.example.ee/d/">' }),
    'e/index.html': doc({ head: '<link rel="canonical" href="https://example.ee/vana-e/">' }),
    _redirects: '/vana-e/ /e/ 301',
  });
  const found = check({ dist: root, site: 'https://example.ee' }).findings.filter((f) => f.check === 'canonical');
  assert.deepEqual(
    found.map((f) => [f.where, f.level, f.message]),
    [
      ['/a/', 'warning', 'canonical /a/ is relative; give the full address'],
      ['/b/', 'warning', 'canonical https://example.ee/b has no closing slash; hosts answer it with a redirect to https://example.ee/b/'],
      ['/c/', 'error', '2 canonical links that disagree (https://example.ee/c/, https://example.ee/x/); search engines then ignore them all'],
      ['/d/', 'error', 'canonical https://www.example.ee/d/ is not on https://example.ee'],
      ['/e/', 'error', 'canonical https://example.ee/vana-e/ redirects to /e/'],
    ],
  );
});

test('links resolve against <base href>, and a site under a path keeps to it', () => {
  const root = site({
    'index.html': doc({ head: '<link rel="canonical" href="https://example.ee/docs/">', body: '<h1>X</h1><a href="/docs/teenused/">a</a><a href="teenused/">b</a><a href="/teenused/">c</a>' }),
    'teenused/index.html': doc({ head: '<base href="/docs/"><link rel="canonical" href="https://example.ee/docs/teenused/">', body: '<h1>X</h1><a href="teenused/">d</a><a href="puudub/">e</a>' }),
  });
  const links = check({ dist: root, site: 'https://example.ee/docs/' }).findings.filter((f) => f.check === 'link' || f.check === 'canonical');
  assert.deepEqual(
    links.map((f) => [f.where, f.message]),
    [
      ['/', 'link to /teenused/, which is outside the site (/docs/)'],
      ['/teenused/', 'link to puudub/, which is not in the build'],
    ],
  );
});

test('reads the options', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.dist, 'dist');
  assert.equal(defaults.words, false);
  assert.deepEqual(defaults.widths, [320, 375, 414, 768, 1280]);
  const opts = parseArgs(['--dist=dist/client', '--site', 'https://example.ee', '--ignore', 'api/', '--ignore', '/admin/', '--widths', '375, 768', '--json']);
  assert.equal(opts.dist, 'dist/client');
  assert.deepEqual(opts.ignore, ['/api/', '/admin/']);
  assert.deepEqual(opts.widths, [375, 768]);
  assert.equal(opts.words, true, 'an option of the rendered check turns it on');
  assert.equal(opts.json, true);
  assert.deepEqual(parseArgs(['--engines', 'Chromium,webkit']).engines, ['chromium', 'webkit']);
  assert.throws(() => parseArgs(['--engines', 'safari']), /--engines takes/);
  assert.throws(() => parseArgs(['--widths', 'wide']), /--widths takes/);
  assert.throws(() => parseArgs(['--site']), /--site needs a value/);
  assert.throws(() => parseArgs(['--colour']), /unknown option --colour/);
  assert.throws(() => parseArgs(['--ignore=']), /--ignore needs a value/, 'an empty prefix would leave out every page');
  assert.throws(() => parseArgs(['--selector', ' ']), /--selector needs a value/);
});

test('a missing build folder or a wrong --site is a clear message', () => {
  const missing = runCli(['--dist', join(tmpdir(), 'static-seo-check-no-such-folder')]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^static-seo-check: no .* folder: build the site first, or give --dist/);
  const wrong = runCli(['--dist', fixture('good'), '--site', 'example.ee']);
  assert.match(wrong.stderr, /--site example\.ee is not an address/);
});

test('npm test finds the tests without a shell glob (Windows runs scripts in cmd.exe)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test');
});

// --- The rendered check ---------------------------------------------------------

const noPlaywrightHere = loadPlaywright({ cwd: tmpdir(), env: {} }) === null;
test('--words without Playwright says how to install it', { skip: !noPlaywrightHere && 'Playwright is installed next to the tool' }, () => {
  const env = { ...process.env };
  delete env.PLAYWRIGHT_PATH;
  delete env.NODE_PATH;
  const result = runCli(['--dist', fixture('good'), '--words'], { cwd: tmpdir(), env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs Playwright, which was not found/);
  assert.match(result.stderr, /npm install --save-dev playwright/);
});

// The browser test runs only where Playwright and its Chromium are installed:
// in a project that has them, or with PLAYWRIGHT_PATH pointing at one (see
// the README, "Testid").
const playwright = loadPlaywright();
const chromium = playwright
  ? await playwright.chromium.launch().then(
      async (browser) => {
        await browser.close();
        return true;
      },
      () => false,
    )
  : false;

test(
  '--words finds words broken between two letters, also in letter-by-letter headings',
  { skip: !chromium && 'no Playwright with Chromium: set PLAYWRIGHT_PATH to run it', timeout: 120_000 },
  () => {
    const result = runCli(['--dist', fixture('words'), '--site', 'https://example.ee', '--words', '--widths', '320,375', '--settle', '300', '--json']);
    const report = JSON.parse(result.stdout);
    const words = report.findings.filter((f) => f.check === 'words');
    assert.deepEqual(
      words.map((f) => [f.where, f.level, f.word, f.hits.map((hit) => hit.width)]),
      [
        ['/', 'error', 'Raamatupidamisteenused', [320, 375]],
        ['/', 'error', 'Ettevõtlusnõustamine', [320, 375]],
        ['/', 'error', 'Бухгалтерскиеуслуги', [320, 375]],
        // The stylesheet is linked by its full address on the site.
        ['/abs/', 'error', 'Raamatupidamisteenused', [320, 375]],
        // A noindex page is rendered too, and a slightly tilted heading is read
        // along its lines; hyphens: auto and an address are warnings.
        ['/layout/', 'error', 'Finantsjuhtimisteenused', [320, 375]],
        ['/layout/', 'warning', 'Raamatupidamisteenused', [320, 375]],
        ['/layout/', 'warning', 'info@raamatupidamine.ee', [320, 375]],
        ['/split/', 'error', 'raamatupidamisteenused', [320, 375]],
      ],
      'the fitting heading, the soft hyphen, the hyphen, the screen-reader copy, rows by design, turned text, a drop cap and two reveals break nowhere wrong',
    );
    assert.match(words[0].message, /^"Raamatupidamisteenused" in <h1> breaks between letters: Raamatupidamis\S*\|\S*enused at 320, 375 px$/);
    assert.match(words[1].message, /Ettevõtlusnõ\|ustamine/, 'a break right after õ');
    assert.match(words[5].message, /breaks with hyphens: auto: .* fine only where the browser can hyphenate lang="et"/);
    assert.match(words[7].message, /in <h2> "Head raamatupidamisteenused" breaks between letters: /);
    const wide = report.findings.filter((f) => f.check === 'overflow');
    assert.deepEqual(
      wide.map((f) => [f.where, f.level]),
      [['/split/', 'warning']],
    );
    assert.match(wide[0].message, /^wider than the screen, scrolls sideways at 320, 375 px \(sticking out: div\.wide\)$/);
    assert.deepEqual(report.words, { pages: 4, widths: [320, 375], engines: ['chromium'] });
    assert.equal(result.status, 1);
    assert.match(runCli(['--dist', fixture('words'), '--widths', '375']).stdout, /headings of 4 pages rendered at 375 px \(chromium\)/);
  },
);

test('--words stops on a selector the browser cannot read', { skip: !chromium && 'no Playwright with Chromium', timeout: 60_000 }, () => {
  const result = runCli(['--dist', fixture('good'), '--selector', 'h1,,h2', '--widths', '375']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^static-seo-check: --selector h1,,h2 is not a CSS selector the browser reads/m);
  assert.doesNotMatch(result.stderr, /words: chromium/, 'before any page is rendered');
});

test('--words with nothing to render is an error, not a pass', { skip: !chromium && 'no Playwright with Chromium', timeout: 60_000 }, () => {
  // Only an error page and a redirect: no page with content.
  const root = site({ 'index.html': '<!doctype html><meta http-equiv="refresh" content="0;url=/uus/">', '404.html': doc() });
  const result = runCli(['--dist', root, '--widths', '375', '--json']);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.words.pages, 0);
  assert.ok(report.findings.some((f) => f.level === 'error' && f.check === 'words' && /no page could be rendered/.test(f.message)));
  assert.equal(result.status, 1);
});

const firefoxMissing = Boolean(playwright?.firefox) && (() => {
  try {
    return !existsSync(playwright.firefox.executablePath());
  } catch {
    return true;
  }
})();
test('a missing browser is found before any page is rendered', { skip: !(chromium && firefoxMissing) && 'needs Chromium and no Firefox', timeout: 60_000 }, () => {
  const result = runCli(['--dist', fixture('good'), '--engines', 'chromium,firefox', '--widths', '375']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not start firefox/);
  assert.doesNotMatch(result.stderr, /words: chromium/);
});
