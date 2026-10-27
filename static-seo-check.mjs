#!/usr/bin/env node
// Reads a built static site (the folder you deploy) the way a search engine
// would and reports what can cost it rankings: links to pages that
// are not there, headings, titles and descriptions, canonical and language
// links, structured data, share pictures, the sitemap and robots.txt.
//
// With --words it also opens every page in a real browser at phone, tablet
// and desktop widths and finds words in headings that break between two
// letters. Long compound words (Estonian, Finnish, German) do that on narrow
// screens, and nothing in the HTML shows it.
//
//   static-seo-check [--dist dist] [--site https://example.ee] [--ignore /prefix/ ...] [--json]
//                    [--words] [--widths 320,375,414,768,1280] [--engines chromium,webkit]
//                    [--selector "h1, h2"] [--settle 1500] [--reduced-motion]
//
// It only reads the folder. Exit code 1 means at least one error.
import { createReadStream, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// Search results show about 60 characters of a title (600 pixels) and about
// 155 of a description and cut the rest. A description much shorter than 70
// says little, and Google then tends to write its own from the page.
const TITLE_MAX = 65;
const DESCRIPTION_MIN = 70;
const DESCRIPTION_MAX = 160;

// Hosts answer with an error status from 404.html and 500.html, and from the
// same as folders (404/index.html), at the root or in a language folder
// (en/404.html), and from a 404.html in any folder (the nearest one is used).
// No search engine lists them, so they need no title or canonical. A numbered
// folder further down (/tooted/450/) is an ordinary page.
const ERROR_PAGE = /^(?:(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})?\/)?[45]\d\d(?:\.html?|\/index\.html?)|(?:.+\/)?404\.html?)$/i;

// Files that prove to a search engine that the site is yours. Google's is
// plain text, Yandex's and Pinterest's are tiny HTML pages; none is a page.
const VERIFICATION = /^(?:google[0-9a-f]{16}|yandex_[0-9a-f]{16}|pinterest-[0-9a-f]{5,}|baidu_verify_[\w-]+)\.html?$/i;

// A language, optionally with a script and a region (et, en-GB, zh-Hant,
// es-419), or x-default for the page shown when no language fits.
const HREFLANG = /^(?:x-default|[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?)$/i;

const WIDTHS = [320, 375, 414, 768, 1280];
const ENGINES = ['chromium', 'webkit', 'firefox'];
const HEADINGS = 'h1, h2, h3, h4, h5, h6';

// Pages opened at the same time in one browser. More is not much faster,
// because every page waits for its own scroll and settle time anyway.
const TABS = 4;

// Other sites' styles, fonts and scripts shape how a heading looks (a web
// font, an animation library from a CDN), so they load. Everything else they
// would fetch is cut: pictures, frames and data requests are how most
// analytics and ad pixels count a visit, and a check is no visit. (A tracker
// that counts with a script load or a WebSocket alone still sees one.)
const LOADS = new Set(['stylesheet', 'font', 'script']);

const PLACEHOLDER = 'http://site.invalid';

const USAGE = `static-seo-check: reads a built static site the way a search engine would.

  static-seo-check [--dist dist] [--site https://example.ee] [--ignore /prefix/ ...] [--json]

  --dist <folder>     the built site, default dist
  --site <address>    the site's address; else taken from the home page's canonical or the sitemap
  --ignore <prefix>   leave out addresses under this path (repeatable)
  --json              print the report as JSON

  --words             also open every page in a browser and find words in headings
                      that break between two letters (needs Playwright)
  --widths <list>     screen widths in px, default ${WIDTHS.join(',')}
  --engines <list>    chromium, webkit, firefox; default chromium
  --selector <css>    which elements count as headings, default "${HEADINGS}"
  --settle <ms>       wait after scrolling through a page, default 1500
  --reduced-motion    open the pages as a visitor who asked for less motion

  Exit code 1 when there are errors.`;

const NO_PLAYWRIGHT = `static-seo-check: --words opens the pages in a browser and needs Playwright, which was not found.
Install it in the project you run this from:
  npm install --save-dev playwright
  npx playwright install chromium
or point PLAYWRIGHT_PATH at an installed playwright folder.`;

export function parseArgs(argv) {
  const opts = {
    dist: 'dist',
    site: '',
    ignore: [],
    json: false,
    words: false,
    widths: WIDTHS,
    engines: ['chromium'],
    selector: HEADINGS,
    settle: 1500,
    reducedMotion: false,
    help: false,
  };
  const list = (text) => text.split(',').map((part) => part.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --name=value works as well as --name value.
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      const given = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      // An empty value (--ignore=) would mean everything, or nothing.
      if (given === undefined || !given.trim() || (eq < 0 && given.startsWith('--'))) throw new Error(`${name} needs a value`);
      return given;
    };
    switch (name) {
      case '--dist':
        opts.dist = value();
        break;
      case '--site':
        opts.site = value();
        break;
      case '--ignore': {
        const prefix = value();
        opts.ignore.push(prefix.startsWith('/') ? prefix : `/${prefix}`);
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--words':
        opts.words = true;
        break;
      // The options of the rendered check only mean something with it, so
      // giving one of them turns it on.
      case '--widths':
        opts.widths = list(value()).map(Number);
        if (!opts.widths.length || opts.widths.some((w) => !Number.isInteger(w) || w < 100 || w > 4000)) {
          throw new Error('--widths takes screen widths in pixels, like 320,375,1280');
        }
        opts.words = true;
        break;
      case '--engines':
        opts.engines = list(value()).map((engine) => engine.toLowerCase());
        if (!opts.engines.length || opts.engines.some((engine) => !ENGINES.includes(engine))) {
          throw new Error(`--engines takes ${ENGINES.join(', ')}`);
        }
        opts.words = true;
        break;
      case '--selector':
        opts.selector = value();
        opts.words = true;
        break;
      case '--settle':
        opts.settle = Number(value());
        if (!Number.isInteger(opts.settle) || opts.settle < 0) throw new Error('--settle takes milliseconds, like 1500');
        opts.words = true;
        break;
      case '--reduced-motion':
        opts.reducedMotion = true;
        opts.words = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option ${arg}. See static-seo-check --help`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Reading HTML
//
// Build output is regular enough that a small tokenizer reads it the way a
// browser does, without a parser dependency. What it must get right is what
// trips regular expressions: comments, the insides of <script> and <style>,
// <template> contents, SVG titles, and attributes in any order and quoting.

const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro ' +
  'para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil ' +
  'Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave ' +
  'Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml ' +
  'igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute ' +
  'thorn yuml';

const NAMED = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ...Object.fromEntries(LATIN1.split(' ').map((name, i) => [name, String.fromCharCode(0xa0 + i)])),
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', Zcaron: 'Ž', zcaron: 'ž', fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†',
  Dagger: '‡', bull: '•', hellip: '…', permil: '‰', prime: '′', Prime: '″', lsaquo: '‹', rsaquo: '›', euro: '€',
  trade: '™', larr: '←', uarr: '↑', rarr: '→', darr: '↓', harr: '↔', minus: '−', check: '✓',
  AMP: '&', LT: '<', GT: '>', QUOT: '"', COPY: '©', REG: '®',
};

// The old names browsers still read without the closing semicolon (&amp, &copy).
const LEGACY = new Set([...LATIN1.split(' '), 'amp', 'lt', 'gt', 'quot', 'AMP', 'LT', 'GT', 'QUOT', 'COPY', 'REG']);

// Browsers read the numeric references 128-159 as Windows-1252 characters.
const CP1252 = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ', 137: '‰', 138: 'Š', 139: '‹',
  140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“', 148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™',
  154: 'š', 155: '›', 156: 'œ', 158: 'ž', 159: 'Ÿ',
};

/**
 * &amp; &otilde; &#8211; &#x2014; → the characters. Unknown names stay as they
 * are. As in a browser, the old names also work without the semicolon (&amp
 * 100), the longest that fits, except in an attribute before a letter, a digit
 * or "=" (?a=1&copy=2). In XML (mode 'xml') only names with a semicolon count.
 */
export function decodeEntities(text, mode = 'text') {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:#(\d+);?|#[xX]([0-9a-fA-F]+);?|([A-Za-z][A-Za-z0-9]*)(;?))/g, (whole, dec, hex, name, semi, at) => {
    if (name) {
      if (semi && Object.hasOwn(NAMED, name)) return NAMED[name];
      if (mode === 'xml') return whole;
      for (let n = Math.min(name.length, 6); n >= 2; n--) {
        if (!LEGACY.has(name.slice(0, n))) continue;
        const next = n < name.length ? name[n] : semi || text[at + whole.length] || '';
        if (mode === 'attribute' && /[A-Za-z0-9=]/.test(next)) return whole;
        return NAMED[name.slice(0, n)] + name.slice(n) + semi;
      }
      return whole;
    }
    const code = dec ? Number(dec) : parseInt(hex, 16);
    if (CP1252[code]) return CP1252[code];
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

// Elements whose content is text, not markup: a "<h1>" inside them is not a
// heading. Inside SVG and MathML they are ordinary elements again.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
const FOREIGN = new Set(['svg', 'math']);

/**
 * Where a <script> that starts at `from` ends: at its first </script>, except
 * that after "<!--" a "<script" opens a nested one, as in old document.write
 * code, and the next </script> only closes that. "-->" ends the escape.
 */
function scriptEnd(html, from) {
  const marks = /<!--|-->|<(\/?)script(?=[\s/>])/gi;
  marks.lastIndex = from;
  let escaped = false;
  let nested = false;
  for (let m = marks.exec(html); m; m = marks.exec(html)) {
    if (m[0] === '<!--') {
      // <!--> and <!---> close at once.
      if (!/^-*>/.test(html.slice(m.index + 4, m.index + 64))) escaped = true;
    } else if (m[0] === '-->') {
      escaped = nested = false;
    } else if (m[1]) {
      if (!nested) return m.index;
      nested = false;
    } else if (escaped) {
      nested = true;
    }
  }
  return -1;
}

/**
 * Every start and end tag in the document, in order: { name, attrs, end,
 * selfClosing, foreign, text }. `text` is the content of a raw-text element
 * such as <script> or <title>. Comments and doctypes are skipped.
 */
export function* tags(html) {
  const n = html.length;
  const closers = {};
  let foreign = 0;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) return;
    i = lt + 1;
    const next = html[i];

    if (next === '!' || next === '?') {
      if (html.startsWith('!--', i)) {
        // <!--> and <!---> are complete (empty) comments; others end at -->.
        const start = i + 3;
        if (html[start] === '>') i = start + 1;
        else if (html.startsWith('->', start)) i = start + 2;
        else {
          const end = /--!?>/g;
          end.lastIndex = start;
          const m = end.exec(html);
          i = m ? m.index + m[0].length : n;
        }
      } else if (foreign && html.startsWith('![CDATA[', i)) {
        const end = html.indexOf(']]>', i);
        i = end < 0 ? n : end + 3;
      } else {
        // A doctype, or something the browser treats as a comment.
        const end = html.indexOf('>', i);
        i = end < 0 ? n : end + 1;
      }
      continue;
    }

    if (next === '/') {
      const m = /^\/([A-Za-z][^\s/>]*)/.exec(html.slice(i, i + 64));
      const end = html.indexOf('>', i);
      i = end < 0 ? n : end + 1;
      if (!m) continue;
      const name = m[1].toLowerCase();
      if (foreign && FOREIGN.has(name)) foreign--;
      yield { name, end: true };
      continue;
    }

    if (!/[A-Za-z]/.test(next ?? '')) continue; // a lone "<" in text

    let j = i;
    while (j < n && !/[\s/>]/.test(html[j])) j++;
    const name = html.slice(i, j).toLowerCase();
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && /[\s/]/.test(html[j])) {
        if (html[j] === '/' && html[j + 1] === '>') selfClosing = true;
        j++;
      }
      if (j >= n) break;
      if (html[j] === '>') {
        j++;
        break;
      }
      // An attribute name may start with "=", and ends at a space, "/", ">" or "=".
      let k = j + 1;
      while (k < n && !/[\s/>=]/.test(html[k])) k++;
      const attr = html.slice(j, k).toLowerCase();
      j = k;
      while (j < n && /\s/.test(html[j])) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (j < n && /\s/.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          const end = close < 0 ? n : close;
          value = html.slice(j + 1, end);
          j = end + 1;
        } else {
          k = j;
          while (k < n && !/[\s>]/.test(html[k])) k++;
          value = html.slice(j, k);
          j = k;
        }
      }
      // The first of two equal attributes wins, as in a browser.
      if (!Object.hasOwn(attrs, attr)) attrs[attr] = decodeEntities(value, 'attribute');
    }
    i = j;

    const inForeign = foreign > 0;
    if (FOREIGN.has(name) && !selfClosing) foreign++;
    let text;
    if (!inForeign && RAW_TEXT.has(name)) {
      let end = n;
      if (name === 'script') {
        const at = scriptEnd(html, i);
        if (at >= 0) end = at;
      } else if (name !== 'plaintext') {
        closers[name] ??= new RegExp(`</${name}[\\s/>]`, 'ig');
        closers[name].lastIndex = i;
        const m = closers[name].exec(html);
        if (m) end = m.index;
      }
      text = html.slice(i, end);
      i = end;
    }
    yield { name, attrs, end: false, selfClosing, foreign: inForeign, text };
  }
}

// What may stand in <head>. Any other element (an <img>, a <div>) ends the
// head where it stands, even before </head>, and search engines then ignore a
// canonical, language link, robots or description tag that comes after it.
// Such a tag after </head> but before <body> is still the head's.
const HEAD = new Set(['html', 'head', 'title', 'base', 'link', 'meta', 'style', 'script', 'noscript', 'template']);

const clean = (text) => text.replace(/[\t\n\f\r ]+/g, ' ').trim();
const tokens = (text) => (text ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);

/** What a search engine reads from one HTML file. */
export function readHtml(html) {
  const page = {
    // A file without any of <!doctype html>, <html>, <head>, <body> or <title>
    // is a fragment or a verification file (google1234.html), not a page.
    document: /^﻿?\s*(?:<!--[\s\S]*?-->\s*)*<!doctype\s+html/i.test(html),
    title: null,
    description: null,
    noindex: false,
    canonicals: [],
    alternates: [],
    ogImage: null,
    h1: 0,
    links: [],
    jsonld: [],
    base: null,
    refresh: null,
    // The element that ended <head> early, if one did (img, div).
    headEnd: null,
    // Tags that only count in <head> but stand after it.
    outside: { canonical: 0, alternates: 0, robots: false, description: false },
  };
  let head = true;
  // A <noscript> in the head is text to a browser that runs scripts, as
  // search engines' do when they render the page.
  let noscript = false;
  // <template> content is not part of the page until a script uses it.
  let template = 0;
  for (const tag of tags(html)) {
    if (noscript) {
      if (tag.end && tag.name === 'noscript') noscript = false;
      continue;
    }
    if (tag.name === 'template') {
      if (tag.end) template = Math.max(0, template - 1);
      else if (!tag.selfClosing) template++;
      continue;
    }
    if (template || tag.end) continue;
    if (head && !HEAD.has(tag.name)) {
      head = false;
      if (tag.name !== 'body') page.headEnd = tag.name;
    }
    if (head && tag.name === 'noscript' && !tag.selfClosing) {
      noscript = true;
      continue;
    }
    const a = tag.attrs;
    switch (tag.name) {
      case 'html':
      case 'head':
      case 'body':
        page.document = true;
        break;
      case 'title':
        // An SVG icon's <title> is not the page's.
        if (tag.foreign) break;
        page.document = true;
        if (page.title === null) page.title = clean(decodeEntities(tag.text ?? ''));
        break;
      case 'h1':
        page.h1++;
        break;
      case 'a':
      case 'area':
        if (a.href !== undefined) page.links.push({ tag: tag.name, href: a.href });
        break;
      case 'base':
        if (page.base === null && a.href) page.base = a.href.trim();
        break;
      case 'link': {
        const rel = tokens(a.rel);
        if (a.href === undefined || tag.foreign) break;
        if (rel.includes('canonical')) {
          if (head) page.canonicals.push(a.href.trim());
          else page.outside.canonical++;
        }
        if (rel.includes('alternate') && a.hreflang !== undefined) {
          if (head) page.alternates.push({ lang: a.hreflang.trim(), href: a.href.trim() });
          else page.outside.alternates++;
        }
        break;
      }
      case 'meta': {
        const name = (a.name ?? '').trim().toLowerCase();
        const property = (a.property ?? '').trim().toLowerCase();
        const content = a.content ?? '';
        if (name === 'description' && page.description === null) {
          if (head) page.description = clean(content);
          else page.outside.description = true;
        }
        if (name === 'robots' && tokens(content).some((t) => t === 'noindex' || t === 'none')) {
          if (head) page.noindex = true;
          else page.outside.robots = true;
        }
        if (page.ogImage === null && [property, name].some((key) => key === 'og:image' || key === 'og:image:url')) {
          page.ogImage = content.trim();
        }
        if ((a['http-equiv'] ?? '').trim().toLowerCase() === 'refresh' && page.refresh === null) {
          const m = /^\s*[\d.]*\s*[;,]\s*(?:url\s*=\s*)?(['"]?)(.+?)\1\s*$/i.exec(content);
          if (m) page.refresh = m[2].trim();
        }
        break;
      }
      case 'script':
        if ((a.type ?? '').trim().toLowerCase() === 'application/ld+json') page.jsonld.push(tag.text ?? '');
        break;
    }
  }
  return page;
}

// ---------------------------------------------------------------------------
// Addresses and files

/** /teenused/index.html → /teenused/, kontakt.html → /kontakt.html */
export const pathOf = (file) => `/${file.replace(/(^|\/)index\.html?$/i, '$1')}`;

/** A URL path as a file path: %C3%B5 → õ, in the composed form file names are compared in. */
export function decodePath(path) {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // A stray "%" stays as it is.
  }
  return decoded.normalize('NFC');
}

/**
 * Every file in the folder, as POSIX paths relative to it, in the composed
 * form (NFC) addresses are compared in. A name stored in the other form (NFD,
 * from an old Mac disk or a zip) goes into `real` with its name on disk.
 */
export function listFiles(root, real = new Map()) {
  const files = [];
  const add = (rel) => {
    const name = rel.normalize('NFC');
    if (name !== rel) real.set(name, rel);
    files.push(name);
  };
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`);
      else if (entry.isFile()) add(rel);
      else if (entry.isSymbolicLink()) {
        try {
          if (statSync(join(dir, entry.name)).isFile()) add(rel);
        } catch {
          // A broken link is no file.
        }
      }
    }
  };
  walk(root, '');
  return new Set(files.sort());
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rules from a _redirects file (Netlify and Cloudflare Pages):
 *   /old/        /new/       301
 *   /blog/*      /news/:splat
 *   /shop/:id    /store/:id  302
 */
export function parseRedirects(text) {
  const rules = [];
  for (const line of text.split(/\r?\n/)) {
    const [from, ...rest] = line.trim().split(/\s+/);
    // Only paths: rules for whole other domains say nothing about this build.
    if (!from || from.startsWith('#') || !from.startsWith('/')) continue;
    // Netlify allows query conditions (id=:id) between the two addresses.
    const at = rest.findIndex((part) => part.startsWith('/') || /^https?:\/\//i.test(part));
    if (at < 0) continue;
    const code = /^(\d{3})!?$/.exec(rest[at + 1] ?? '');
    const names = [];
    const source = from
      .split(/(\*|(?<=\/):[A-Za-z_]\w*)/)
      .map((part, i) => {
        if (i % 2 === 0) return escapeRegExp(part);
        names.push(part === '*' ? 'splat' : part.slice(1));
        return part === '*' ? '(.*)' : '([^/]+)';
      })
      .join('');
    const status = code ? Number(code[1]) : 301;
    // A rewrite (200) of many addresses to one fixed page, like the
    // single-page-app fallback "/*  /index.html  200": it answers every
    // address with the same page, which search engines read as a missing one.
    const catchAll = status === 200 && names.length > 0 && !/\*|:[A-Za-z_]/.test(rest[at]);
    rules.push({ from, to: rest[at], status, pattern: new RegExp(`^${source}$`), names, catchAll });
  }
  return rules;
}

function matchRule(rules, path) {
  // Hosts match /old and /old/ alike.
  const forms = path.length > 1 ? [path, path.endsWith('/') ? path.slice(0, -1) : `${path}/`] : [path];
  for (const form of forms) {
    for (const rule of rules) {
      const m = rule.pattern.exec(form);
      if (!m) continue;
      let to = rule.to;
      rule.names.forEach((name, i) => {
        to = to.split(`:${name}`).join(m[i + 1] ?? '');
      });
      return { ...rule, to };
    }
  }
  return null;
}

/**
 * Finds the file a host serves for a path, the way static hosts do:
 * /x/ → x/index.html; /x → x, x.html or x/index.html (or .htm); and then
 * the _redirects rules. `via` says which: file, index, html, dir
 * (x/index.html for /x, which hosts answer with a redirect to /x/) or
 * redirect. `real` maps a file to its name on disk where the two differ.
 */
export function makeResolver(files, rules = [], real = new Map()) {
  const first = (...names) => names.find((name) => files.has(name));
  const find = (path) => {
    const rel = path.slice(1);
    let file;
    if (path.endsWith('/')) return (file = first(`${rel}index.html`, `${rel}index.htm`)) ? { file, via: 'index' } : null;
    if (files.has(rel)) return { file: rel, via: 'file' };
    if ((file = first(`${rel}.html`, `${rel}.htm`))) return { file, via: 'html' };
    if ((file = first(`${rel}/index.html`, `${rel}/index.htm`))) return { file, via: 'dir' };
    return null;
  };
  const resolver = {
    files,
    find,
    disk: (file) => real.get(file) ?? file,
    redirect: (path) => matchRule(rules, path),
    // Whether a full address a redirect points to is this site; set once the
    // site's address is known.
    own: () => false,
    /**
     * { file, via, chain } when something answers, { file: null, chain } when
     * nothing does. `catchAll` is the catch-all rewrite rule that answered,
     * if one did.
     */
    resolve(path, { follow = true } = {}) {
      const chain = [];
      let catchAll = null;
      let current = path;
      for (let hop = 0; hop < 10; hop++) {
        const found = find(current);
        if (found) return { ...found, via: chain.length ? 'redirect' : found.via, chain, ...(catchAll && { catchAll }) };
        const rule = follow ? matchRule(rules, current) : null;
        if (!rule) break;
        if (rule.catchAll) catchAll ??= rule;
        chain.push(rule.to);
        if (rule.status === 404 || rule.status === 410) break;
        let next;
        try {
          next = new URL(rule.to, PLACEHOLDER + current);
        } catch {
          break;
        }
        // A redirect to another site answers; whether that page exists is
        // that site's business.
        if (/^https?:\/\//i.test(rule.to) && !resolver.own(next)) return { file: null, external: true, via: 'redirect', chain };
        current = decodePath(next.pathname);
      }
      return { file: null, chain };
    },
  };
  return resolver;
}

// Whether an address is a page or file: a catch-all rewrite does not count.
const answers = (result) => Boolean((result.file && !result.catchAll) || result.external);

/** A URL, or null when it does not parse. */
const parse = (href, base) => {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
};

// One address however it is spelled: %C3%B5, %c3%b5 and õ are the same letter.
const addressKey = (href) => {
  const url = parse(href);
  return url ? `${url.origin}${decodePath(url.pathname)}${url.search}` : href;
};

// ---------------------------------------------------------------------------
// Sitemaps and robots.txt

/** The <loc> addresses of one sitemap file, and whether it is an index of other sitemaps. */
export function sitemapLocs(xml) {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  // The root's prefix, if it has one (<ns0:urlset>, <sm:sitemapindex>), is
  // the one its <loc> tags carry. <image:loc> and <video:content_loc> are
  // pictures and videos, not pages.
  const root = /<(?:([\w.-]+):)?(urlset|sitemapindex)[\s>]/i.exec(text);
  const loc = `${root?.[1] ? `${escapeRegExp(root[1])}:` : ''}loc`;
  const locs = [...text.matchAll(new RegExp(`<${loc}\\s*>([\\s\\S]*?)</${loc}\\s*>`, 'gi'))].map((m) =>
    decodeEntities(m[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1'), 'xml').trim(),
  );
  return { index: root?.[2].toLowerCase() === 'sitemapindex', locs };
}

/**
 * Reads the sitemaps the way a crawler finds them: the ones robots.txt names,
 * else sitemap-index.xml, sitemap_index.xml or sitemap.xml, following index
 * files to the sitemaps they list. Gzipped sitemaps (.xml.gz) work too.
 */
export function readSitemaps({ root, resolver, local = (path) => path, robots = null }) {
  const result = { files: [], entries: [], problems: [] };
  const fileFor = (loc) => {
    let url;
    try {
      url = new URL(loc, `${PLACEHOLDER}/`);
    } catch {
      return null;
    }
    const path = local(url.pathname);
    return path === null ? null : resolver.resolve(decodePath(path)).file;
  };
  const queue = [];
  if (robots?.sitemaps.length) {
    for (const loc of robots.sitemaps) {
      const file = fileFor(loc);
      if (file) queue.push(file);
      else result.problems.push({ where: 'robots.txt', message: `names the sitemap ${loc}, which is not in the build` });
    }
  } else {
    const first = ['sitemap-index.xml', 'sitemap_index.xml', 'sitemap.xml'].find((file) => resolver.files.has(file));
    if (first) queue.push(first);
    else queue.push(...[...resolver.files].filter((file) => /^sitemap[\w-]*\.xml(?:\.gz)?$/i.test(file)));
  }
  const seen = new Set();
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    result.files.push(file);
    let xml;
    try {
      const bytes = readFileSync(join(root, resolver.disk(file)));
      xml = (/\.gz$/i.test(file) ? gunzipSync(bytes) : bytes).toString('utf8');
    } catch (error) {
      result.problems.push({ where: file, message: `cannot be read: ${error.message}` });
      continue;
    }
    const { index, locs } = sitemapLocs(xml);
    for (const loc of locs) {
      if (!index) {
        result.entries.push({ url: loc, from: file });
        continue;
      }
      const child = fileFor(loc);
      if (child) queue.push(child);
      else result.problems.push({ where: file, message: `lists the sitemap ${loc}, which is not in the build` });
    }
  }
  return result;
}

/** The sitemap lines and the rules for every crawler (User-agent: *) of a robots.txt. */
export function parseRobots(text) {
  const sitemaps = [];
  const groups = [];
  let group = null;
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
    } else if (key === 'user-agent') {
      // User-agent lines in a row share the rules that follow them.
      if (!group || inRules) {
        group = { agents: [], rules: [] };
        groups.push(group);
        inRules = false;
      }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      inRules = true;
      // An empty Disallow allows everything and is no rule.
      if ((key === 'allow' || key === 'disallow') && value) group.rules.push({ allow: key === 'allow', path: decodePath(value) });
    }
  }
  return { sitemaps, rules: groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules) };
}

/** The Disallow rule that keeps crawlers from a path, if any: the longest matching rule wins, Allow on a tie. */
export function blockedBy(rules, path) {
  let best = null;
  for (const rule of rules) {
    const anchored = rule.path.endsWith('$');
    const body = (anchored ? rule.path.slice(0, -1) : rule.path).split('*').map(escapeRegExp).join('.*');
    if (!new RegExp(`^${body}${anchored ? '$' : ''}`).test(path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return best && !best.allow ? best : null;
}

// ---------------------------------------------------------------------------
// The checks

function inspect({ dist = 'dist', site = '', ignore = [] } = {}) {
  const root = resolve(dist);
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    // Missing.
  }
  if (!isDir) throw new Error(`no ${dist} folder: build the site first, or give --dist`);

  let siteUrl = null;
  if (site) {
    siteUrl = parse(site);
    if (!siteUrl || !/^https?:$/.test(siteUrl.protocol)) throw new Error(`--site ${site} is not an address; give it like https://example.ee`);
  }
  // A site under a path (https://example.github.io/project/) serves the
  // build's root at that path.
  const base = siteUrl ? siteUrl.pathname.replace(/\/?$/, '/') : '/';
  const local = (path) => {
    if (base === '/') return path;
    if (path.startsWith(base)) return path.slice(base.length - 1);
    return `${path}/` === base ? '/' : null;
  };
  const skipped = (path) => ignore.some((prefix) => path.startsWith(prefix));

  const real = new Map();
  const files = listFiles(root, real);
  const read = (file) => readFileSync(join(root, real.get(file) ?? file), 'utf8');
  const resolver = makeResolver(files, files.has('_redirects') ? parseRedirects(read('_redirects')) : [], real);
  const robots = files.has('robots.txt') ? parseRobots(read('robots.txt')) : null;

  const findings = [];
  const add = (level, where, check, message, extra = {}) => findings.push({ level, where, check, message, ...extra });

  const pages = [];
  for (const file of files) {
    if (!/\.html?$/i.test(file) || VERIFICATION.test(file)) continue;
    const path = pathOf(file);
    if (skipped(path)) continue;
    const info = readHtml(read(file));
    if (!info.document) continue;
    pages.push({ file, path, ...info, error: ERROR_PAGE.test(file) });
  }
  // A wrong --dist must not pass: an empty folder, a project instead of its
  // build, or all of a server build (Astro keeps the pages in dist/client).
  if (!files.has('index.html') && !files.has('index.htm')) {
    const inner = ['client', 'out', 'dist', 'build', '_site', 'public'].find((dir) => files.has(`${dir}/index.html`));
    if (inner) throw new Error(`${dist} has no index.html, but ${join(dist, inner)} has one: give --dist ${join(dist, inner)}`);
  }
  if (!pages.length) throw new Error(`no HTML pages in ${dist}${ignore.length ? ' outside --ignore' : ''}: build the site first, or give --dist`);
  const byFile = new Map(pages.map((page) => [page.file, page]));

  // The site's address: given, else the home page's canonical, else the
  // sitemap's. The pages are the better witness: when only the sitemap uses
  // another scheme or host, that is reported once, on the sitemap.
  const full = (href) => (href && /^https?:\/\//i.test(href) ? parse(href) : null);
  let origin = siteUrl?.origin ?? full(byFile.get('index.html')?.canonicals[0])?.origin ?? null;
  // While the sitemaps are read, a redirect to a full address on this site
  // (or, before the address is known, on the host robots.txt names) stays here.
  const sitemapHosts = new Set((robots?.sitemaps ?? []).map((loc) => full(loc)?.host).filter(Boolean));
  resolver.own = (url) => (origin ? url.host === new URL(origin).host : sitemapHosts.has(url.host));
  const sitemap = readSitemaps({ root, resolver, local, robots });
  for (const { where, message } of sitemap.problems) add('error', where, 'sitemap', message);
  origin ??= sitemap.entries.map(({ url }) => full(url)?.origin).find(Boolean) ?? null;
  if (!origin) {
    add('warning', 'site', 'site', 'no site address found: give --site https://your.site. Without it, where canonicals, language links and sitemap entries point was not checked');
  }
  const host = origin ? new URL(origin).host : null;
  // http:// and https:// links to the same host are both this site.
  const own = (url) => (origin ? url.host === host : url.origin === PLACEHOLDER);
  resolver.own = own;

  const at = (path) => `${origin ?? PLACEHOLDER}${base.slice(0, -1)}${path}`;
  const baseOf = (page) => {
    const here = at(page.path);
    if (!page.base) return here;
    return parse(page.base, here)?.href ?? here;
  };
  // Where an address on a page leads: { url, path } for this site's
  // addresses, { url } for others', null when it does not parse.
  const locate = (href, page) => {
    const url = parse(href, baseOf(page));
    if (!url) return null;
    if (!own(url)) return { url };
    const path = local(url.pathname);
    return { url, path: path === null ? null : decodePath(path) };
  };
  const fileOfLink = (href, page) => {
    const target = locate(href, page);
    return target?.path ? resolver.resolve(target.path, { follow: false }).file : null;
  };
  const describe = (result) => {
    if (result.catchAll) {
      const { from, to } = result.catchAll;
      return `is not in the build; only the catch-all rewrite ${from} → ${to} (200) answers it, the same page for any address, which search engines read as a missing page`;
    }
    if (answers(result)) return `redirects to ${result.chain.at(-1)}`;
    return result.chain.length ? `redirects to ${result.chain.at(-1)}, which is not in the build` : 'is not in the build';
  };
  const outsideHead = (page) => (page.headEnd ? `after <${page.headEnd}>, which ends <head>` : 'in <body>');

  // A meta refresh makes the page a redirect, unless it only reloads the page.
  for (const page of pages) {
    const target = page.refresh === null ? null : locate(page.refresh, page);
    page.redirect = page.refresh !== null && !(target?.path && resolver.resolve(target.path).file === page.file);
    page.indexable = !page.noindex && !page.error && !page.redirect;
  }
  const content = pages.filter((page) => !page.redirect);

  // Links. A page that asks to stay out of search is still crawled for its
  // links, but nothing on it costs a place, so its findings are warnings.
  const linked = [];
  for (const page of pages) {
    const level = page.noindex ? 'warning' : 'error';
    if (page.redirect) {
      // A meta refresh is read as a redirect, so its target must answer.
      const target = locate(page.refresh, page);
      if (!target) add('error', page.path, 'link', `redirects (meta refresh) to ${page.refresh}, which does not parse`);
      else if (target.path !== undefined && target.path !== null && !skipped(target.path)) {
        const result = resolver.resolve(target.path);
        if (!answers(result)) add('error', page.path, 'link', `redirects (meta refresh) to ${page.refresh}, which ${describe(result)}`);
      }
      continue;
    }
    const reported = new Set();
    for (const { tag, href } of page.links) {
      const raw = href.replace(/[\t\n\r]/g, '').trim();
      if (!raw || raw.startsWith('#') || reported.has(raw)) continue;
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
      if (scheme && !/^https?$/i.test(scheme[1])) continue; // mailto:, tel:, javascript: and the like
      const target = locate(raw, page);
      let message = null;
      if (!target) message = `<${tag}> address does not parse: ${raw}`;
      else if (target.path === null) message = `link to ${raw}, which is outside the site (${base})`;
      else if (target.path !== undefined && !skipped(target.path)) {
        const result = resolver.resolve(target.path);
        // /kontakt/ when the build has kontakt.html, which is served at /kontakt.
        const bare = target.path.length > 1 && target.path.endsWith('/') ? resolver.find(target.path.slice(0, -1)) : null;
        if (bare?.via === 'html') {
          message = `link to ${raw}, but the page is ${bare.file}, at ${target.path.slice(0, -1)} without the closing slash; some hosts redirect, others answer 404`;
        } else if (!answers(result)) {
          message = result.chain.length || result.catchAll ? `link to ${raw} ${describe(result)}` : `link to ${raw}, which is not in the build`;
        } else if (result.via !== 'redirect') {
          linked.push({ from: page, url: target.url, result });
        }
      }
      if (message) {
        reported.add(raw);
        add(level, page.path, 'link', message);
      }
    }
  }

  // Headings, titles, structured data and share pictures of every page that
  // shows content (not error pages and not redirects).
  for (const page of content) {
    const level = page.noindex ? 'warning' : 'error';
    page.jsonld.forEach((block, i) => {
      try {
        JSON.parse(block);
      } catch (error) {
        add(level, page.path, 'json-ld', `JSON-LD block ${i + 1} does not parse: ${error.message}`);
      }
    });
    if (page.error) continue;
    if (page.h1 !== 1) add(level, page.path, 'h1', page.h1 ? `${page.h1} h1 headings, should be 1` : 'no h1 heading');
    if (!page.title) add(level, page.path, 'title', 'no title');

    // Tags that only count in <head> but stand after it.
    if (page.outside.robots && !page.noindex) {
      add('error', page.path, 'robots', `meta robots noindex is ${outsideHead(page)}; search engines read it only in <head>, so the page can be indexed`);
    }
    const stray = page.outside.alternates;
    if (stray) {
      add(level, page.path, 'hreflang', `${stray === 1 ? '1 language link is' : `${stray} language links are`} ${outsideHead(page)}; search engines read them only in <head>`);
    }

    if (!page.ogImage) {
      if (page.indexable) add('warning', page.path, 'og-image', 'no og:image: a shared link shows no picture');
      continue;
    }
    const image = locate(page.ogImage, page);
    if (!image) {
      add(level, page.path, 'og-image', `og:image ${page.ogImage} does not parse`);
      continue;
    }
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(page.ogImage)) {
      add('warning', page.path, 'og-image', `og:image ${page.ogImage} is relative; Facebook, LinkedIn and others need the full https:// address`);
    }
    if (image.path === null) add(level, page.path, 'og-image', `og:image ${page.ogImage} is outside the site (${base})`);
    else if (image.path !== undefined && !skipped(image.path) && !answers(resolver.resolve(image.path))) {
      add(level, page.path, 'og-image', `og:image ${page.ogImage} is not in the build`);
    }
  }

  // Canonical: the page names itself, as one full address on this site. It
  // may instead name another page it duplicates (a print copy, a second
  // landing page): search engines then show that one, so this page stays out
  // of the sitemap and of the checks below.
  const indexable = pages.filter((page) => page.indexable);
  const canonicalOf = new Map();
  const slashless = new Set();
  for (const page of indexable) {
    if (!page.canonicals.length) {
      if (page.outside.canonical) add('error', page.path, 'canonical', `canonical link is ${outsideHead(page)}; search engines read it only in <head>`);
      else add('warning', page.path, 'canonical', 'no canonical link; search engines then choose the address themselves');
      continue;
    }
    const href = page.canonicals[0];
    const distinct = [...new Set(page.canonicals.map((h) => locate(h, page)?.url.href ?? h))];
    if (distinct.length > 1) {
      add('error', page.path, 'canonical', `${distinct.length} canonical links that disagree (${distinct.join(', ')}); search engines then ignore them all`);
    }
    if (!/^https?:\/\//i.test(href)) add('warning', page.path, 'canonical', `canonical ${href} is relative; give the full address`);
    if (!origin) continue;
    const target = locate(href, page);
    if (!target) add('error', page.path, 'canonical', `canonical ${href} does not parse`);
    else if (target.url.origin !== origin) add('error', page.path, 'canonical', `canonical ${target.url.href} is not on ${origin}`);
    else if (target.path === null) add('error', page.path, 'canonical', `canonical ${target.url.href} is outside the site (${base})`);
    else {
      const found = resolver.resolve(target.path, { follow: false });
      const other = found.file ? byFile.get(found.file) : null;
      if (!found.file) add('error', page.path, 'canonical', `canonical ${target.url.href} ${describe(resolver.resolve(target.path))}`);
      else if (found.file !== page.file && other?.indexable) {
        page.duplicateOf = other;
        add('warning', page.path, 'canonical', `canonical ${target.url.href} is another page, so search engines show ${other.path} instead of this one`);
      } else if (found.file !== page.file) {
        const why = !other ? ', which is not a page' : other.redirect ? ', which only redirects' : other.error ? ', an error page' : ', which asks to stay out of search (noindex)';
        add('error', page.path, 'canonical', `canonical ${target.url.href} is another page (${pathOf(found.file)})${why}`);
      } else {
        canonicalOf.set(page, target.url.href);
        if (found.via === 'dir') {
          slashless.add(page);
          add('warning', page.path, 'canonical', `canonical ${target.url.href} has no closing slash; hosts answer it with a redirect to ${target.url.href}/`);
        } else if (found.via === 'file' && /(?:^|\/)index\.html?$/i.test(found.file)) {
          add('warning', page.path, 'canonical', `canonical ${target.url.href} names the file; the page's address is ${new URL('./', target.url).href}, and many hosts redirect the one to the other`);
        }
        if (target.url.search) add('warning', page.path, 'canonical', `canonical ${target.url.href} carries a query (${target.url.search}); give the address without it`);
      }
    }
  }
  // The pages that want to be found, under their own address.
  const indexed = indexable.filter((page) => !page.duplicateOf);

  // Titles and descriptions of the pages that want to be found.
  for (const page of indexed) {
    if (page.title && [...page.title].length > TITLE_MAX) {
      add('warning', page.path, 'title', `title is ${[...page.title].length} characters; search results cut it after about 60: ${page.title}`);
    }
    if (!page.description) {
      add('error', page.path, 'description', page.outside.description ? `meta description is ${outsideHead(page)}; search engines read it only in <head>` : 'no meta description');
    } else {
      const length = [...page.description].length;
      if (length < DESCRIPTION_MIN || length > DESCRIPTION_MAX) {
        add('warning', page.path, 'description', `description is ${length} characters; search results show about ${DESCRIPTION_MIN}-${DESCRIPTION_MAX}`);
      }
    }
  }
  // Each title and description belongs to one page. Language versions of
  // one page may share one (a brand name as the home page's title), so
  // between them it is a warning.
  const versions = (a, b) => [[a, b], [b, a]].some(([x, y]) => x.alternates.some((alt) => fileOfLink(alt.href, x) === y.file));
  for (const key of ['title', 'description']) {
    const seen = new Map();
    for (const page of indexed) {
      const value = page[key];
      if (!value) continue;
      const first = seen.get(value);
      if (!first) seen.set(value, page);
      else if (versions(page, first)) add('warning', page.path, key, `same ${key} as ${first.path}, its other language version`);
      else add('error', page.path, key, `same ${key} as ${first.path}`);
    }
  }

  // Language links (hreflang): every language version lists all the others
  // and itself, and each of them lists this page back. A one-sided link is
  // ignored by Google.
  for (const page of origin ? indexed : []) {
    if (!page.alternates.length) continue;
    const seen = new Map();
    let self = false;
    for (const { lang, href } of page.alternates) {
      if (!HREFLANG.test(lang)) add('error', page.path, 'hreflang', `hreflang "${lang}" is not a language code (like et, en-GB or x-default)`);
      const target = locate(href, page);
      if (!target) {
        add('error', page.path, 'hreflang', `language link (${lang}) ${href} does not parse`);
        continue;
      }
      if (!/^https?:\/\//i.test(href)) {
        add('error', page.path, 'hreflang', `language link (${lang}) ${href} is relative; search engines need the full https:// address`);
      }
      const key = lang.toLowerCase();
      if (seen.has(key) && seen.get(key) !== target.url.href) {
        add('error', page.path, 'hreflang', `hreflang "${lang}" points to two pages: ${seen.get(key)} and ${target.url.href}`);
      }
      seen.set(key, target.url.href);
      // Another site's pages cannot be checked from this build.
      if (target.path === undefined) continue;
      if (target.path === null || skipped(target.path)) continue;
      const found = resolver.resolve(target.path, { follow: false });
      const other = found.file ? byFile.get(found.file) : null;
      const name = `language link (${lang}) ${target.url.href}`;
      if (!found.file) add('error', page.path, 'hreflang', `${name} ${describe(resolver.resolve(target.path))}`);
      else if (!other) add('error', page.path, 'hreflang', `${name} is not a page`);
      else if (other.redirect) add('error', page.path, 'hreflang', `${name} only redirects (meta refresh) to ${other.refresh}`);
      else if (other.error) add('error', page.path, 'hreflang', `${name} is an error page`);
      else if (other.noindex) add('error', page.path, 'hreflang', `${name} asks to stay out of search (noindex)`);
      else if (other.duplicateOf) add('error', page.path, 'hreflang', `${name} names another page (${other.duplicateOf.path}) as its canonical`);
      else {
        if (other === page) self = true;
        else if (!other.alternates.some((alt) => fileOfLink(alt.href, other) === page.file)) {
          add('error', page.path, 'hreflang', `${target.url.href} (${lang}) does not link back to this page`);
        }
        const theirs = canonicalOf.get(other);
        if (theirs && addressKey(theirs) !== addressKey(target.url.href)) add('warning', page.path, 'hreflang', `${name}, but that page's canonical is ${theirs}`);
      }
    }
    if (!self) add('warning', page.path, 'hreflang', 'the language links do not include this page itself');
  }

  // The sitemap: every page that wants to be found, and nothing else.
  const listed = new Map();
  if (!sitemap.files.length) {
    add('warning', 'site', 'sitemap', 'no sitemap (sitemap-index.xml, sitemap.xml, or a Sitemap: line in robots.txt)');
  } else if (origin) {
    const foreign = new Map();
    // Pages the sitemap lists on another scheme or host: that is one error,
    // on the sitemap, not one more on every page.
    const elsewhere = new Set();
    for (const { url: loc, from } of sitemap.entries) {
      const url = parse(loc);
      if (!url) {
        add('error', from, 'sitemap', `lists ${loc}, which is not a full address`);
        continue;
      }
      if (url.origin !== origin) {
        if (!foreign.has(url.origin)) foreign.set(url.origin, { from, urls: [] });
        foreign.get(url.origin).urls.push(loc);
        const path = local(url.pathname);
        const found = path === null ? null : resolver.resolve(decodePath(path), { follow: false }).file;
        if (found && byFile.has(found)) elsewhere.add(byFile.get(found));
        continue;
      }
      const path = local(url.pathname);
      if (path === null) {
        add('error', from, 'sitemap', `lists ${loc}, which is outside the site (${base})`);
        continue;
      }
      if (skipped(decodePath(path))) continue;
      const found = resolver.resolve(decodePath(path), { follow: false });
      if (!found.file) {
        add('error', from, 'sitemap', `lists ${loc}, which ${describe(resolver.resolve(decodePath(path)))}`);
        continue;
      }
      const page = byFile.get(found.file);
      // PDFs and other files may be listed; search engines index them too.
      if (!page) continue;
      if (page.redirect) add('error', from, 'sitemap', `lists ${loc}, which only redirects (meta refresh) to ${page.refresh}`);
      else if (page.error) add('error', from, 'sitemap', `lists ${loc}, which is an error page`);
      else if (page.noindex) add('error', from, 'sitemap', `lists ${loc}, which asks to stay out of search (noindex)`);
      else if (page.duplicateOf) add('error', from, 'sitemap', `lists ${loc}, whose canonical is another page (${page.duplicateOf.path})`);
      else {
        if (!listed.has(page)) listed.set(page, []);
        listed.get(page).push(url.href);
      }
    }
    for (const [other, { from, urls }] of foreign) {
      add('error', from, 'sitemap', `lists ${urls.length} ${urls.length === 1 ? 'address' : 'addresses'} on ${other}, not ${origin} (${urls[0]})`);
    }
    for (const page of indexed) {
      const urls = listed.get(page);
      const canonical = canonicalOf.get(page);
      if (!urls) {
        if (!elsewhere.has(page)) add('error', page.path, 'sitemap', 'not in the sitemap');
      }
      else if (canonical && !urls.some((url) => addressKey(url) === addressKey(canonical))) {
        add('warning', page.path, 'sitemap', `the sitemap lists it as ${urls[0]}, its canonical is ${canonical}`);
      }
    }
  }

  // Links that reach a page by another address than its own: /x for the
  // folder x/, x.html when the page names itself /x, /x/index.html. Every
  // visit is then a redirect, or the same page under a second address.
  const detours = new Map();
  for (const { from, url, result } of linked) {
    const page = byFile.get(result.file);
    if (!page || page.redirect) continue;
    const canonical = slashless.has(page) ? null : canonicalOf.get(page);
    const folder = `${origin ?? ''}${base.slice(0, -1)}${page.path}`;
    let address = null;
    if (result.via === 'dir') address = folder;
    else if (canonical) {
      const named = parse(canonical);
      if (named && (named.origin !== url.origin || decodePath(named.pathname) !== decodePath(url.pathname))) address = canonical;
    } else if (result.via === 'file' && /(?:^|\/)index\.html?$/i.test(result.file)) address = folder;
    if (!address) continue;
    const shown = url.origin === (origin ?? PLACEHOLDER) ? url.pathname : `${url.origin}${url.pathname}`;
    const key = `${result.file}\n${shown}`;
    if (!detours.has(key)) detours.set(key, { page, shown, address, from: new Set() });
    detours.get(key).from.add(from.path);
  }
  for (const { page, shown, address, from } of detours.values()) {
    const list = [...from].sort();
    const names = list.length > 3 ? `${list.slice(0, 3).join(', ')} and ${list.length - 3} more` : list.join(', ');
    add('warning', page.path, 'link', `linked as ${shown} from ${list.length === 1 ? '1 page' : `${list.length} pages`} (${names}); its address is ${address}`);
  }

  // robots.txt: a Disallow keeps crawlers from reading the page at all.
  if (robots) {
    const blocked = indexed.map((page) => [page, blockedBy(robots.rules, base.slice(0, -1) + page.path)]).filter(([, rule]) => rule);
    if (blocked.length > 1 && blocked.length === indexed.length) {
      add('error', 'robots.txt', 'robots', `blocks every page for all crawlers (Disallow: ${blocked[0][1].path})`);
    } else {
      for (const [page, rule] of blocked) add('error', page.path, 'robots', `robots.txt keeps crawlers out (Disallow: ${rule.path})`);
    }
    if (!robots.sitemaps.length && sitemap.files.length && origin) {
      add('warning', 'robots.txt', 'robots', `does not name the sitemap; add "Sitemap: ${origin}${base}${sitemap.files[0]}" so every search engine finds it`);
    }
  }

  const report = {
    dist: root,
    site: origin ? origin + base.slice(0, -1) : null,
    pages: pages.length,
    indexable: indexed.length,
    sitemap: new Set(sitemap.entries.map((entry) => entry.url)).size,
    errors: 0,
    warnings: 0,
    findings,
  };
  // The rendered check looks at every page that shows content.
  return { report, root, base, resolver, origin, content: content.filter((page) => !page.error), add };
}

// Pages first, in address order, then the site-wide files; errors before
// warnings within each.
function finish(report) {
  const rank = (where) => (where.startsWith('/') ? 0 : 1);
  report.findings.sort(
    (a, b) => rank(a.where) - rank(b.where) || (a.where < b.where ? -1 : a.where > b.where ? 1 : 0) || (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1),
  );
  report.errors = report.findings.filter((f) => f.level === 'error').length;
  report.warnings = report.findings.length - report.errors;
  return report;
}

/** The checks that need no browser. Returns the report. */
export function check(opts = {}) {
  return finish(inspect(opts).report);
}

/** All checks, with the rendered one when opts.words is set. */
export async function run(opts = {}, { log = () => {}, playwright } = {}) {
  const state = inspect(opts);
  if (opts.words) {
    const pw = playwright ?? loadPlaywright();
    if (!pw) throw new Error(NO_PLAYWRIGHT.replace(/^static-seo-check: /, ''));
    const widths = opts.widths ?? WIDTHS;
    const engines = opts.engines ?? ['chromium'];
    const measured = await checkWords({
      ...state,
      playwright: pw,
      widths,
      engines,
      selector: opts.selector ?? HEADINGS,
      settle: opts.settle ?? 1500,
      reducedMotion: Boolean(opts.reducedMotion),
      log,
    });
    state.report.words = { pages: measured, widths, engines };
  }
  return finish(state.report);
}

export function format(report) {
  const lines = [];
  let where = null;
  for (const finding of report.findings) {
    if (finding.where !== where) {
      if (where !== null) lines.push('');
      where = finding.where;
      lines.push(where);
    }
    lines.push(`  ${finding.level === 'error' ? '✗' : '·'} ${finding.message}`);
  }
  if (lines.length) lines.push('');
  const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let summary = `${count(report.pages, 'page')} read, ${report.indexable} indexable, ${report.sitemap} in the sitemap`;
  if (report.words) {
    summary += `, headings of ${count(report.words.pages, 'page')} rendered at ${report.words.widths.join(', ')} px (${report.words.engines.join(', ')})`;
  }
  summary += report.findings.length ? `: ${count(report.errors, 'error')}, ${count(report.warnings, 'warning')}.` : '. All clear.';
  lines.push(summary);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The rendered check (--words)

/**
 * Playwright, from PLAYWRIGHT_PATH if set, else the project this runs in
 * (the current folder's node_modules), else this tool's own. Null when none
 * is installed. Any of playwright, @playwright/test and playwright-core works.
 */
export function loadPlaywright({ cwd = process.cwd(), env = process.env } = {}) {
  const names = ['playwright', '@playwright/test', 'playwright-core'];
  const tries = [];
  if (env.PLAYWRIGHT_PATH) {
    const path = resolve(cwd, env.PLAYWRIGHT_PATH);
    // The package folder itself, or the node_modules folder that holds it.
    tries.push([createRequire(join(path, 'noop.js')), [path, ...names]]);
  }
  tries.push([createRequire(join(cwd, 'noop.js')), names], [createRequire(import.meta.url), names]);
  for (const [require, ids] of tries) {
    for (const id of ids) {
      try {
        const pw = require(id);
        if (pw?.chromium) return pw;
      } catch {
        // Not there; the next one.
      }
    }
  }
  return null;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
};

// A header may only hold ASCII; addresses with õ or ä are sent encoded.
const headerSafe = (text) => text.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));

/**
 * Serves the build on 127.0.0.1 the way a static host would: the same file
 * resolution, /x answered with a redirect to /x/, the _redirects rules, and
 * the nearest 404.html for anything else.
 */
export async function serve(root, resolver, base = '/') {
  const notFound = (path) => {
    for (let dir = path.replace(/[^/]*$/, ''); dir; dir = dir.replace(/[^/]*\/$/, '')) {
      const file = `${dir.slice(1)}404.html`;
      if (resolver.files.has(file)) return file;
      if (dir === '/') break;
    }
    return null;
  };
  const server = createServer((req, res) => {
    const send = (status, file) => {
      res.writeHead(status, { 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      if (req.method === 'HEAD') res.end();
      else createReadStream(join(root, resolver.disk(file))).on('error', () => res.end()).pipe(res);
    };
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      res.writeHead(400).end();
      return;
    }
    let path = url.pathname;
    if (base !== '/') {
      if (!path.startsWith(base)) {
        res.writeHead(404).end();
        return;
      }
      path = path.slice(base.length - 1);
    }
    path = decodePath(path);
    const found = resolver.find(path);
    if (found?.via === 'dir') {
      res.writeHead(301, { location: `${url.pathname}/${url.search}` }).end();
      return;
    }
    if (found) return send(200, found.file);
    const rule = resolver.redirect(path);
    if (rule && rule.status === 200) {
      const result = resolver.resolve(path);
      if (result.file) return send(200, result.file);
    } else if (rule && rule.status !== 404 && rule.status !== 410) {
      res.writeHead(rule.status >= 300 && rule.status < 400 ? rule.status : 302, { location: headerSafe(rule.to) }).end();
      return;
    }
    const page = notFound(path);
    if (page) return send(404, page);
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}

// Runs in the page. Scrolls down in steps, like a thumb would, so that
// everything animated on scroll (letter-by-letter headings) has played.
async function scrollThrough() {
  const pause = (ms) => new Promise((done) => setTimeout(done, ms));
  const step = Math.max(200, Math.round(window.innerHeight * 0.6));
  for (let y = 0, n = 0; y < document.documentElement.scrollHeight && n < 150; y += step, n++) {
    window.scrollTo({ top: y, behavior: 'instant' });
    await pause(100);
  }
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  await pause(100);
}

// Runs in the page. Waits for the page's own animations and transitions that
// end (CSS and Web Animations), at most 5 seconds. Script libraries such as
// GSAP do not show in that list; --settle and a second look cover them.
async function settleAnimations() {
  const ending = (document.getAnimations?.() ?? []).filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
  await Promise.race([Promise.all(ending.map((a) => a.finished.catch(() => {}))), new Promise((done) => setTimeout(done, 5000))]);
}

// Runs in the page. For every heading, finds the words whose letters sit on
// two lines, and whether the page is wider than the screen.
function measure(selector) {
  // \s covers the no-break space; U+200B is an explicit break opportunity.
  const SPACE = /[\s​]/u;
  const LETTER = /[\p{L}\p{M}\p{N}]/u;
  // Scripts written without spaces break between letters by design.
  const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
  // A break after these is where a word may break: the soft hyphen (U+00AD),
  // which shows a hyphen only at a break, the hyphens and dashes
  // U+2010-U+2014, the hyphen-minus and a slash.
  const BREAKS_AFTER = /[­‐-—/-]/u;
  const SOFT = '­';
  const range = document.createRange();
  const styles = new Map();
  const styleOf = (e) => {
    if (!styles.has(e)) styles.set(e, getComputedStyle(e));
    return styles.get(e);
  };

  // Text a screen reader gets but nobody sees (a 1-pixel "sr-only" box) is
  // left out: in its tiny box every letter is on a line of its own.
  const tinyCache = new Map();
  const tiny = (el, heading) => {
    for (let e = el; e && e !== heading; e = e.parentElement) {
      if (!tinyCache.has(e)) {
        const box = e.getBoundingClientRect();
        tinyCache.set(e, styleOf(e).display !== 'contents' && (box.width <= 1 || box.height <= 1));
      }
      if (tinyCache.get(e)) return true;
    }
    return false;
  };

  // A box on a row of its own by design: a block in normal flow (a number
  // above a title, the two rows of an accordion button) or an item of a flex
  // or grid container. Two such boxes hold two words even with no space
  // between them. Inside an inline box (a letter's inline-block) nothing
  // splits the heading's rows.
  const ownRow = (e) => /flex|grid/.test(styleOf(e.parentElement).display) || /^(?:block|list-item|flow-root|table|flex|grid)/.test(styleOf(e).display);
  const apart = (a, b, heading) => {
    let common = b.parentElement;
    while (common !== heading && !common.contains(a)) common = common.parentElement;
    return [a, b].some((node) => {
      const chain = [];
      for (let e = node.parentElement; e !== common; e = e.parentElement) chain.unshift(e);
      for (const e of chain) {
        if (/^inline-/.test(styleOf(e).display)) return false;
        if (ownRow(e)) return true;
      }
      return false;
    });
  };

  // Vertical text and headings turned on their side run down the screen
  // letter by letter; their lines cannot be read from where the letters are.
  // A slight tilt (a playful -4deg) still reads along its lines.
  const turned = (el) => {
    if (/^(?:vertical|sideways)/.test(styleOf(el).writingMode)) return true;
    let m = new DOMMatrixReadOnly();
    for (let e = el; e; e = e.parentElement) {
      const style = styleOf(e);
      try {
        let own = new DOMMatrixReadOnly(style.transform && style.transform !== 'none' ? style.transform : undefined);
        // The rotate property turns before transform does. An axis with the
        // angle ("x 90deg") is a turn in 3D.
        if (style.rotate && style.rotate !== 'none') {
          if (!/^-?[\d.]+(?:deg|rad|turn|grad)$/.test(style.rotate)) return true;
          own = new DOMMatrixReadOnly(`rotate(${style.rotate})`).multiply(own);
        }
        m = own.multiply(m);
      } catch {
        // Not a matrix this browser reads.
      }
    }
    // More than 45 degrees from level.
    return Math.abs(m.b) > Math.abs(m.a);
  };

  const all = [...document.querySelectorAll(selector)];
  const matched = new Set(all);
  const headings = [];
  all.forEach((el, index) => {
    for (let up = el.parentElement; up; up = up.parentElement) if (matched.has(up)) return;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || turned(el)) return;
    const rtl = styleOf(el).direction === 'rtl';

    const chars = [];
    const unseen = [];
    let last = null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        // <br> and <wbr> are places the author chose for a break.
        if (node.localName === 'br' || node.localName === 'wbr') chars.push({ ch: ' ' });
        continue;
      }
      if (tiny(node.parentElement, el)) {
        unseen.push(node.data);
        continue;
      }
      if (last && apart(last, node, el)) chars.push({ ch: ' ' });
      last = node;
      // With hyphens: auto the browser may draw a hyphen at the break itself.
      const style = styleOf(node.parentElement);
      const hyphenates = (style.hyphens || style.webkitHyphens) === 'auto';
      const text = node.data;
      for (let i = 0; i < text.length; ) {
        const size = text.codePointAt(i) > 0xffff ? 2 : 1;
        const ch = text.slice(i, i + size);
        let rect = null;
        if (!SPACE.test(ch)) {
          range.setStart(node, i);
          range.setEnd(node, i + size);
          // The last box: at a soft hyphen Chromium gives the next letter a
          // second box at the end of the line, where the hyphen is drawn.
          const boxes = [...range.getClientRects()];
          rect = boxes.findLast((r) => r.width > 0) ?? boxes.findLast((r) => r.height > 0) ?? null;
        }
        chars.push({ ch, rect, hyphenates });
        i += size;
      }
    }

    // A letter-splitting script often drops the spaces from the markup and
    // keeps the real text in aria-label or a screen-reader copy. When one of
    // those has the same letters, its spaces tell where the words are.
    const letters = (text) => [...text].filter((ch) => !SPACE.test(ch) && ch !== SOFT);
    const shown = letters(chars.map((c) => c.ch).join('')).join('');
    const labels = [el.getAttribute('aria-label'), ...[...el.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')), unseen.join('')];
    let wordsOf = null;
    for (const label of labels) {
      if (!label || letters(label).join('') !== shown) continue;
      wordsOf = [];
      let word = 0;
      let inWord = false;
      for (const ch of label) {
        if (SPACE.test(ch)) {
          if (inWord) word++;
          inWord = false;
        } else if (ch !== SOFT) {
          wordsOf.push(word);
          inWord = true;
        }
      }
      break;
    }
    let word = 0;
    let k = 0;
    for (const c of chars) {
      if (SPACE.test(c.ch)) {
        c.word = -1;
        word++;
      } else if (c.ch === SOFT) c.word = wordsOf ? (wordsOf[k - 1] ?? 0) : word;
      else c.word = wordsOf ? wordsOf[k++] : word;
    }

    // Each break: the letter after it, and whether the one before it has
    // hyphens: auto.
    const cuts = new Map();
    let prev = null;
    let prevWord = null;
    let opening = false;
    chars.forEach((c, i) => {
      if (c.word !== prevWord) {
        prev = null;
        opening = false;
        prevWord = c.word;
      }
      if (c.word === -1) return;
      if (BREAKS_AFTER.test(c.ch)) opening = true;
      if (!c.rect) return;
      if (prev && !opening && LETTER.test(prev.ch) && LETTER.test(c.ch) && !UNSPACED.test(prev.ch) && !UNSPACED.test(c.ch)) {
        // A new line: the letter is lower by more than half a line, and back
        // where lines start instead of on along this one. (A drop cap or a
        // letter still rising into place is lower but further along.)
        const line = Math.max(prev.rect.height, c.rect.height) || 1;
        const step = Math.min(prev.rect.width, c.rect.width) / 2;
        const back = rtl ? c.rect.right > prev.rect.left + step : c.rect.left < prev.rect.right - step;
        if (c.rect.top - prev.rect.top > line / 2 && back) {
          if (!cuts.has(c.word)) cuts.set(c.word, new Map());
          cuts.get(c.word).set(i, prev.hyphenates);
        }
      }
      prev = c;
      opening = BREAKS_AFTER.test(c.ch);
    });
    if (!cuts.size) return;

    // The word as written, without the punctuation around it.
    const trim = (text) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{M}\p{N}]+$/gu, '');
    const words = [...cuts].map(([id, at]) => {
      let plain = '';
      let split = '';
      chars.forEach((c, i) => {
        if (c.word !== id || c.ch === SOFT) return;
        if (at.has(i)) split += '|';
        plain += c.ch;
        split += c.ch;
      });
      return { word: trim(plain), split: trim(split), hyphens: [...at.values()].every(Boolean) };
    });
    const text = (el.getAttribute('aria-label') || el.textContent).replace(/­/g, '').replace(/\s+/g, ' ').trim();
    const lang = el.closest('[lang]')?.getAttribute('lang') ?? '';
    headings.push({ index, tag: el.localName, text: text.length > 80 ? `${text.slice(0, 77)}...` : text, lang, words });
  });

  // Wider than the screen: the page scrolls sideways, unless the root or the
  // body clips it (overflow-x: hidden or clip on the viewport).
  const doc = document.documentElement;
  const rootStyle = getComputedStyle(doc);
  const viewport = rootStyle.overflowX !== 'visible' ? rootStyle : getComputedStyle(document.body ?? doc);
  let wide = null;
  if (!/hidden|clip/.test(viewport.overflowX) && doc.scrollWidth > doc.clientWidth + 1) {
    const width = doc.clientWidth;
    // Inside a scroll box, a clipping box or a fixed layer, sticking out does
    // not widen the page.
    const contained = (el) => {
      for (let e = el; e && e !== document.body && e !== doc; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.position === 'fixed' || (e !== el && style.overflowX !== 'visible')) return true;
      }
      return false;
    };
    const culprits = [];
    for (const el of document.body?.querySelectorAll('*') ?? []) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.right <= width + 1) continue;
      // Only the outermost element that sticks out.
      const parent = el.parentElement;
      if (parent && parent !== document.body && parent.getBoundingClientRect().right > width + 1 && !contained(parent)) continue;
      if (contained(el)) continue;
      const id = el.id ? `#${el.id}` : '';
      const classes = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
      culprits.push(`${el.localName}${id}${classes}`);
      if (culprits.length === 3) break;
    }
    wide = { width, scroll: doc.scrollWidth, culprits };
  }
  return { headings, wide };
}

/** A file from the built-in server: { status, headers, body }. */
const fetchLocal = (url) =>
  new Promise((done, fail) => {
    httpGet(url, (res) => {
      const parts = [];
      res.on('data', (part) => parts.push(part));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      res.on('error', fail);
    }).on('error', fail);
  });

// An e-mail address or a domain has no better place to break.
const ADDRESS = /@|^(?:https?:\/\/|www\.)|^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,24}$/iu;

/** Renders every page with content and reports broken words; returns how many pages were measured. */
async function checkWords({ root, base, resolver, origin, content, add, playwright, widths, engines, selector, settle, reducedMotion, log }) {
  const broken = new Map();
  const wide = new Map();
  const measured = new Set();
  const host = origin ? new URL(origin).host : null;
  // Every browser first, so that a missing one shows before the others have
  // rendered every page.
  const browsers = [];
  try {
    for (const engine of engines) {
      if (!playwright[engine]) throw new Error(`this Playwright has no ${engine}`);
      try {
        browsers.push([engine, await playwright[engine].launch()]);
      } catch (error) {
        throw new Error(`could not start ${engine}: ${String(error.message).split('\n')[0]}\nInstall it with: npx playwright install ${engine}`);
      }
    }
    // A selector the browser cannot read would fail on every page.
    const probe = await browsers[0][1].newPage();
    const problem = await probe.evaluate((css) => {
      try {
        document.querySelectorAll(css);
        return null;
      } catch (error) {
        return error.message;
      }
    }, selector);
    await probe.close();
    if (problem) throw new Error(`--selector ${selector} is not a CSS selector the browser reads: ${problem}`);

    const server = await serve(root, resolver, base);
    try {
      for (const [engine, browser] of browsers) {
        for (const width of widths) {
          log(`words: ${engine} at ${width} px, ${content.length} pages`);
          const context = await browser.newContext({
            viewport: { width, height: width < 768 ? 800 : 900 },
            reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
            serviceWorkers: 'block',
          });
          await context.route('**/*', async (route) => {
            const request = route.request();
            const url = parse(request.url());
            if (url?.origin === server.origin) return route.continue();
            // The site's own files by full address (Hugo's .Permalink, an
            // asset prefix) come from the build, not from the live site.
            if (host && url?.host === host && /^https?:$/.test(url.protocol)) {
              try {
                const answer = await fetchLocal(server.origin + url.pathname + url.search);
                const headers = Object.fromEntries(Object.entries(answer.headers).map(([name, value]) => [name, [].concat(value).join(', ')]));
                return await route.fulfill({ status: answer.status, headers: { ...headers, 'access-control-allow-origin': '*' }, body: answer.body });
              } catch {
                return route.abort();
              }
            }
            if (LOADS.has(request.resourceType())) return route.continue();
            return route.abort();
          });
          const queue = [...content];
          await Promise.all(
            Array.from({ length: Math.min(TABS, queue.length) }, async () => {
              const tab = await context.newPage();
              for (let page = queue.shift(); page; page = queue.shift()) {
                try {
                  // A third-party request that hangs can hold the load event
                  // back for good; the page is measured anyway after a while.
                  const url = server.origin + base + encodeURI(page.path.slice(1));
                  await tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => tab.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
                  await tab.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
                  await tab.evaluate(() => (document.fonts ? document.fonts.ready.then(() => true) : true));
                  await tab.evaluate(scrollThrough);
                  await tab.waitForTimeout(settle);
                  await tab.evaluate(settleAnimations);
                  const result = await tab.evaluate(measure, selector);
                  // A letter still on its way into place can look like a
                  // break; a real break is still there a moment later.
                  if (result.headings.length) {
                    await tab.waitForTimeout(300);
                    const again = await tab.evaluate(measure, selector);
                    const still = new Set(again.headings.flatMap((h) => h.words.map((w) => `${h.index}\n${w.split}`)));
                    for (const heading of result.headings) heading.words = heading.words.filter((w) => still.has(`${heading.index}\n${w.split}`));
                  }
                  measured.add(page.path);
                  for (const heading of result.headings) {
                    for (const { word, split, hyphens } of heading.words) {
                      const key = `${page.path}\n${heading.index}\n${word}`;
                      if (!broken.has(key)) broken.set(key, { page, tag: heading.tag, text: heading.text, lang: heading.lang, word, hyphens, hits: [] });
                      const entry = broken.get(key);
                      entry.hyphens &&= hyphens;
                      entry.hits.push({ engine, width, split });
                    }
                  }
                  if (result.wide) {
                    if (!wide.has(page.path)) wide.set(page.path, []);
                    wide.get(page.path).push({ engine, width, ...result.wide });
                  }
                } catch (error) {
                  add('warning', page.path, 'words', `could not be checked at ${width} px in ${engine}: ${String(error.message).split('\n')[0]}`);
                }
              }
              await tab.close();
            }),
          );
          await context.close();
        }
      }
    } finally {
      await server.close();
    }
  } finally {
    for (const [, browser] of browsers) await browser.close();
  }
  if (!measured.size) add('error', 'site', 'words', 'no page could be rendered and measured, so no heading was checked');

  // One line per word: where it breaks, and at which widths it breaks there.
  const many = engines.length > 1;
  const order = (a, b) => engines.indexOf(a.engine) - engines.indexOf(b.engine) || a.width - b.width;
  const places = (hits) => {
    const byEngine = new Map();
    for (const hit of [...hits].sort(order)) {
      if (!byEngine.has(hit.engine)) byEngine.set(hit.engine, []);
      byEngine.get(hit.engine).push(hit.width);
    }
    return [...byEngine].map(([engine, list]) => `${many ? `${engine} ` : ''}${list.join(', ')} px`).join(', ');
  };
  const groupBy = (hits, key) => {
    const groups = new Map();
    for (const hit of hits) {
      if (!groups.has(key(hit))) groups.set(key(hit), []);
      groups.get(key(hit)).push(hit);
    }
    return [...groups];
  };
  // Broken words are errors on every page, noindex ones too: visitors see them.
  for (const { page, tag, text, lang, word, hyphens, hits } of broken.values()) {
    hits.sort(order);
    const heading = text === word ? `<${tag}>` : `<${tag}> "${text}"`;
    const where = groupBy(hits, (hit) => hit.split).map(([split, group]) => `${split} at ${places(group)}`).join('; ');
    const extra = { word, heading: text, hits };
    if (hyphens) {
      const language = lang ? `lang="${lang}"` : 'the page (it has no lang)';
      add('warning', page.path, 'words', `"${word}" in ${heading} breaks with hyphens: auto: ${where}; fine only where the browser can hyphenate ${language} and draws a hyphen there`, extra);
    } else if (ADDRESS.test(word)) {
      add('warning', page.path, 'words', `"${word}" in ${heading} breaks between letters: ${where}; an address has no better place to break, so give it room or a smaller size`, extra);
    } else {
      add('error', page.path, 'words', `"${word}" in ${heading} breaks between letters: ${where}`, extra);
    }
  }
  for (const [path, hits] of wide) {
    hits.sort(order);
    const where = groupBy(hits, (hit) => hit.culprits.join(', ')).map(
      ([culprits, group]) => `at ${places(group)}${culprits ? ` (sticking out: ${culprits})` : ''}`,
    );
    add('warning', path, 'overflow', `wider than the screen, scrolls sideways ${where.join('; ')}`, { hits });
  }
  return measured.size;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  let playwright;
  if (opts.words) {
    playwright = loadPlaywright();
    if (!playwright) {
      console.error(NO_PLAYWRIGHT);
      process.exitCode = 1;
      return;
    }
  }
  const report = await run(opts, { playwright, log: (line) => console.error(line) });
  console.log(opts.json ? JSON.stringify(report, null, 2) : format(report));
  process.exitCode = report.errors ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(`static-seo-check: ${error.message}`);
    process.exitCode = 1;
  });
}
