# static-seo-check

Loeb ehitatud staatilise saidi kausta (selle, mille serverisse laadite) nii, nagu otsingumootor seda loeb, ja ütleb, mis võib saidi otsingutulemustes allapoole viia: lingid lehtedele, mida pole, pealkirjad ja kirjeldused, canonical- ja keelelingid, struktureeritud andmed, jagamispildid, sitemap ja robots.txt. Valikuga `--words` avab ta iga lehe ka päris brauseris telefoni, tahvelarvuti ja arvuti laiusel ning leiab pealkirjadest sõnad, mis murduvad kahe tähe vahelt.

Sobib iga generaatoriga, mis kirjutab lehed valmis HTML-iks (Astro, Eleventy, Hugo, Jekyll, Next.js static export, käsitsi kirjutatud HTML), sest loeb ainult seda HTML-i. Rakendus, mis ehitab lehe alles brauseris (tühi `<div id="root">` ja skript), on tööriistale tühi leht. Põhikontrollid ei vaja ühtegi paketti, ainult Node 18+.

*English below.*

## Mida see kontrollib

Vead (✗) annavad väljumiskoodi 1, hoiatused (·) mitte.

- **Lingid.** `<a>` ja `<area>` lingid saidi enda lehtedele ja failidele, mida valmis saidis pole. Aadressid lahendatakse nagu staatilised hostid seda teevad: `/x/` → `x/index.html`; `/x` → `x`, `x.html` või `x/index.html` (ka `.htm`); ja siis `_redirects` faili (Netlify, Cloudflare Pages) reeglid, ka `*` ja `:nimi`. Reegel, mis vastab igale aadressile sama lehega (`/* /index.html 200`), ei tee puuduvast lehest olemasolevat. Ankrud (`#…`), `mailto:`, `tel:`, `javascript:` ja teiste saitide lingid jäävad välja. Suur- ja väiketähtedel tehakse vahet nagu serveris, ka siis, kui teie arvuti ketas neid ei erista. Hoiatus, kui link jõuab lehele teise aadressi kaudu kui lehe enda oma (`/x` kausta `x/` jaoks, `meist.html`, kui leht nimetab end `/meist`, või `/x/index.html`), sest siis on iga klõps ümbersuunamine.
- **h1.** Igal lehel täpselt üks.
- **Pealkiri ja kirjeldus.** Mõlemad olemas ja igal lehel oma. Ühe lehe keeleversioonidel võib olla sama (näiteks avalehe pealkirjaks ainult brändi nimi), see on hoiatus. Hoiatus, kui pealkiri on üle 65 märgi (otsingutulemus näitab umbes 60) või kirjeldus väljaspool 70–160 märki.
- **`<head>`.** Canonical, keelelingid, `robots` ja kirjeldus kehtivad ainult `<head>`-is. Kui need on `<body>`-s või kui mõni muu element (`<img>`, `<div>`) lõpetab head'i enne neid, jätavad otsingumootorid need lugemata, ja see on viga.
- **Canonical.** Täisaadress sama saidi all, mis nimetab lehte ennast. Puudumine on hoiatus: siis valib otsingumootor aadressi ise. Viga, kui see osutab ümbersuunamisele, olematule või `noindex` lehele või teisele domeenile. Kui see nimetab teist lehte, on leht selle koopia (näiteks prinditav versioon): see on hoiatus, ja sellist lehte ei tohi sitemapis olla. Hoiatus ka siis, kui `/x` lõpust puudub kaldkriips, mille hostid ümbersuunamisega juurde panevad, kui aadress lõpeb failinimega `index.html` või kui sellel on päring (`?…`).
- **Keelelingid (hreflang).** Täisaadressid, sest suhtelisi Google ei loe. Iga keeleversioon on valmis saidis olemas, indekseeritav ja lingib tagasi, sest ühepoolse keelelingi jätab Google kõrvale. Hoiatus, kui leht ei nimeta iseennast. `x-default` on lubatud; keelekood on kujul `et`, `en-GB` või `zh-Hant`.
- **JSON-LD.** Iga `application/ld+json` plokk on korrektne JSON.
- **og:image.** Hoiatus, kui puudub või on suhteline aadress (Facebook ja LinkedIn vajavad täisaadressi). Viga, kui pilt on sellel saidil, aga valmis saidist see puudub.
- **Sitemap.** Loeb `robots.txt` failis nimetatud sitemapid, muidu `sitemap-index.xml`, `sitemap_index.xml` või `sitemap.xml`, ja järgib indekseid edasi (ka `.xml.gz`). Iga indekseeritav leht peab olema sitemapis ja iga sitemapi aadress peab olema indekseeritav leht valmis saidis. Sitemapi puudumine on hoiatus.
- **robots.txt.** Viga, kui `Disallow` hoiab indekseeritava lehe otsingurobotitest eemal. Hoiatus, kui robots.txt ei nimeta sitemapi.

Indekseeritav tähendab, et lehel pole `<meta name="robots" content="noindex">` (ega `none`). `noindex` lehe leiud on hoiatused: seda otsingus ei näidata, nii et sealsed leiud kohta ei mõjuta (`--words` leiud on erand, sest külastaja näeb lehte ikka). Vealehtedel (`404.html` mis tahes kaustas, `500.html`, ka kujul `404/index.html` juurkaustas või keelekaustas) ei kontrollita h1-te, pealkirja, canonicali ega sitemapi. Leht, mis ainult suunab edasi (`<meta http-equiv="refresh">`, nagu Astro `redirects`), loetakse ümbersuunamiseks: kontrollitakse ainult, et siht on olemas. Otsingumootorite kinnitusfailid (`google….html`, `yandex_….html`) ei ole lehed.

Saidi aadress tuleb `--site` valikust, muidu avalehe canonicalist, muidu sitemapist. Kui seda kuskilt ei leia, jääb ühe hoiatusega kontrollimata, kuhu canonicalid, keelelingid ja sitemapi read osutavad.

Kaust, kus pole ühtegi HTML-lehte, on viga, et vale `--dist` ei läheks läbi. Kui kaustas endas `index.html`-i pole, aga näiteks `client/` (Astro serveriadapteriga build) või `out/` sees on, ütleb tööriist, millise kausta anda.

HTML-i loeb tööriist ise, nagu brauser: kommentaaride, `<script>`, `<style>` ja `<template>` sisu ei loe (JSON-LD välja arvatud), SVG ikooni `<title>` ei ole lehe pealkiri, atribuudid võivad olla mis tahes järjekorras ja jutumärkidega või ilma, ning entiteedid (`&amp;`, `&otilde;`, `&#8211;`) dekodeeritakse.

## Pikad sõnad pealkirjades (`--words`)

Eesti, soome, saksa, hollandi, ungari ja teised liitsõnakeeled teevad pikki sõnu: „raamatupidamisteenused“, „kirjanpitopalvelut“, „Kundenzufriedenheit“. Kui selline sõna on pealkirja reast laiem, juhtub üks kahest. Ilma `overflow-wrap`-ita läheb sõna reast välja ja leht hakkab telefonis külgsuunas kerima. Kui stiilileht lubab `overflow-wrap: break-word` või `anywhere` (paljud CSS-i alused teevad seda vaikimisi), murrab brauser sõna kahe tähe vahelt ja ilma sidekriipsuta: „raamatupidamiste“ ühel real, „enused“ järgmisel. Sama teevad animatsioonid, mis jagavad pealkirja tähthaaval eraldi elementideks (GSAP SplitText, SplitType, Splitting.js, omakirjutatud tähthaaval ilmuvad pealkirjad): iga täht on oma kast ja rida võib vahetuda iga kasti vahel.

HTML-ist seda ei näe ja arvutiekraanil enamasti ka mitte. See juhtub telefonis, sageli ainult mõnel laiusel, ja külastaja loeb seda veana. `--words` avab iga sisuga lehe (ka `noindex` lehe, aga mitte vealehti ja ümbersuunamisi) päris brauseris igal laiusel, kerib lehe läbi, et kerimisega käivituvad animatsioonid jõuaksid lõpuni, ootab `--settle` millisekundit ja lehe enda CSS-animatsioonide lõppu ning vaatab siis iga pealkirja iga tähe asukohta, kaks korda väikese vahega. Kui sõna kaks järjestikust tähte on eri ridadel, on see viga. Korras on murdmine sidekriipsu järel või pehme poolitusmärgi (`&shy;`) kohal, pealkirja osad, mis on kujunduse järgi eri ridadel (plokid, flex- ja grid-elemendid), ekraanilugejale mõeldud peidetud koopia (`sr-only`) ja tühikuteta kirjutatavad keeled (hiina, jaapani, tai). Püstist ja külili pööratud teksti ei kontrollita. Murdunud e-posti- või veebiaadress on hoiatus, sest paremat kohta murdumiseks sel pole.

Mida teha:

- lühem sõna või teine sõnastus („raamatupidamisteenused“ → „raamatupidamine“);
- pealkirja rida laiemaks, sest kitsas `max-width` (sageli `ch` ühikutes) on tavaline põhjus;
- väiksem kiri kitsal ekraanil, näiteks `font-size: clamp(…)`;
- pehme poolitus kohas, kus sõna tohib poolituda (`raamatupidamis&shy;teenused`). `hyphens: auto` poolitab ainult brauseris, millel on selle keele poolitusreeglid; kus neid pole, murdub sõna ikka tähtede vahelt ja ilma sidekriipsuta, nii et `--words` annab sellise murdmise kohta hoiatuse;
- tähthaaval animatsioonis iga sõna tähed ühte elementi, mis ei murdu (`white-space: nowrap`), ja sõna, mis mahub reale.

Lisaks annab `--words` hoiatuse, kui leht on mõnel laiusel ekraanist laiem ja kerib külgsuunas, koos elementidega, mis välja ulatuvad.

Lehti näidatakse tööriista enda väikesest serverist (127.0.0.1) samade aadressireeglitega. Saidi enda failid tulevad valmis saidist ka siis, kui leht viitab neile täisaadressiga. Teiste saitide stiilid, fondid ja skriptid laaditakse, sest need määravad, kuidas pealkiri välja näeb. Pildid, raamid ja andmepäringud lõigatakse ära, nii et enamik analüütikat ja reklaamipiksleid kontrolli külastusena kirja ei pane. Skript, mis loeb külastuse juba enda laadimisel või WebSocketi kaudu, võib selle siiski kirja panna.

`--words` vajab Playwrighti, mida tööriist kaasa ei too. Seda otsitakse muutujast `PLAYWRIGHT_PATH`, siis kaustast, kust tööriista käivitate (`node_modules`), siis tööriista enda kõrvalt:

```bash
npm install --save-dev playwright
npx playwright install chromium webkit
```

## Kasutamine

Proovimiseks pole midagi vaja paigaldada, käivitage see pärast buildi:

```bash
npx github:novuwebsolutions/static-seo-check --dist dist --site https://teie.sait
```

Tööriist on üks fail ilma sõltuvusteta, nii et selle võib panna ka oma projekti, näiteks `scripts/` kausta:

```bash
node scripts/static-seo-check.mjs --dist dist --site https://teie.sait
node scripts/static-seo-check.mjs --dist dist --words --engines chromium,webkit
```

Näiteks `package.json`-is, nii et vigadega sait serverisse ei lähe:

```json
"check": "astro build && node scripts/static-seo-check.mjs --dist dist --site https://teie.sait",
"deploy": "npm run check && …"
```

| Valik | Mida teeb |
|---|---|
| `--dist` | ehitatud saidi kaust, vaikimisi `dist` |
| `--site` | saidi aadress; võib olla ka alamtee all (`https://kasutaja.github.io/projekt/`) |
| `--ignore` | jätab välja aadressid selle tee all: sealseid lehti ei loeta ning linke ja sitemapi ridu sinna ei kontrollita (näiteks serveri marsruudid, mida staatilises buildis pole); võib korrata |
| `--json` | väljastab aruande JSON-ina |
| `--words` | lülitab sisse brauseris tehtava kontrolli; iga allolev valik teeb seda ka |
| `--widths` | ekraani laiused pikslites, vaikimisi `320,375,414,768,1280` |
| `--engines` | `chromium`, `webkit` (iPhone'i Safari mootor), `firefox`; vaikimisi `chromium` |
| `--selector` | mida loetakse pealkirjaks, vaikimisi `h1, h2, h3, h4, h5, h6` |
| `--settle` | ooteaeg pärast lehe läbikerimist millisekundites, vaikimisi `1500` |
| `--reduced-motion` | avab lehed nagu külastaja, kes on palunud vähem liikumist |

Väljumiskood on 1, kui leidub vigu, ja 0, kui on ainult hoiatused või mitte midagi.

## Testid

```bash
npm test
```

Brauserit vajavad testid (`--words`) käivad ainult siis, kui Playwright ja selle Chromium on olemas, muidu jäetakse need vahele. Kui Playwright on mõnes teises projektis, näidake see muutujaga `PLAYWRIGHT_PATH`, mis osutab `playwright` kaustale (või `node_modules` kaustale, kus see on):

```bash
PLAYWRIGHT_PATH=../teine-projekt/node_modules/playwright npm test
```

Sama muutujat loeb ka tööriist ise.

Tegi [Novu Web Solutions](https://novu.ee), veebistuudio Viljandist, oma Astro saidi jaoks Cloudflare'is. MIT litsents.

---

## English

Reads a built static site (the folder you deploy) the way a search engine does and reports what can cost you rankings. It works with any generator that writes finished HTML (Astro, Eleventy, Hugo, Jekyll, a Next.js static export, hand-written HTML) because it reads only that HTML; an app that builds its pages in the browser (an empty `<div id="root">` and a script) is an empty page to it. The core checks need no dependencies, Node 18+.

Errors (✗) set exit code 1, warnings (·) do not.

- **Links**: `<a>` and `<area>` links to the site's own pages and files that are not in the build, resolved the way static hosts do (`/x/` → `x/index.html`; `/x` → `x`, `x.html` or `x/index.html`, `.htm` too; then the `_redirects` rules of Netlify and Cloudflare Pages, with `*` and `:name`). A rule that answers every address with one page (`/* /index.html 200`) does not make a missing page exist. Fragments, `mailto:`, `tel:`, `javascript:` and other sites are left alone. Letter case counts as it does on the server. A warning when a link reaches a page by another address than its own (`/x` for the folder `x/`, `meist.html` when the page names itself `/meist`, `/x/index.html`), since every visit is then a redirect.
- **h1**: exactly one per page.
- **Title and description**: present and unique, except that language versions of one page may share one (a warning); a warning for a title over 65 characters or a description outside 70–160.
- **`<head>`**: canonical, language links, robots and description count only in `<head>`; in `<body>`, or after an element that ends the head early (`<img>`, `<div>`), they are errors.
- **Canonical**: a full address on this site naming the page itself. Missing is a warning (search engines then choose). An error when it points to a redirect, a missing or noindex page, or another domain. Naming another page makes this page a duplicate of it (a print version): a warning, and it must not be in the sitemap. Warnings when `/x` lacks the closing slash hosts redirect to, ends in `index.html`, or carries a query.
- **hreflang**: full addresses (Google ignores relative ones); every language version is in the build, indexable and links back; a warning when a page does not list itself; `x-default` allowed.
- **JSON-LD** blocks that do not parse.
- **og:image**: a warning when missing or relative, an error when it is on this site and not in the build.
- **Sitemap**: read from robots.txt, or `sitemap-index.xml`, `sitemap_index.xml`, `sitemap.xml`, following index files (and `.xml.gz`). Every indexable page is listed, and every listed address is an indexable page in the build. No sitemap is a warning.
- **robots.txt**: an error when `Disallow` keeps crawlers from an indexable page, a warning when it does not name the sitemap.

Indexable means not marked `noindex` in meta robots; findings on a noindex page are warnings, except for `--words`, since visitors still see it. Error pages (`404.html` in any folder, `500.html`, or `404/index.html` at the root or in a language folder) skip the h1, title, canonical and sitemap checks, a page that only redirects (meta refresh) is checked as a redirect, and search engine verification files are not pages. The site's address comes from `--site`, else the home page's canonical, else the sitemap; without one, where canonicals, language links and sitemap entries point is not checked (one warning). A folder with no HTML pages is an error, with a hint when the pages are in `client/` (Astro server adapters), `out/` or the like.

### Long words in headings (`--words`)

Estonian, Finnish, German, Dutch, Hungarian and other compounding languages make long words: "raamatupidamisteenused", "kirjanpitopalvelut", "Kundenzufriedenheit". When such a word is wider than a heading's line, it either sticks out and the page scrolls sideways, or, with `overflow-wrap: break-word` or `anywhere` (a default in many CSS resets), the browser breaks it between two letters without a hyphen. Animations that split a heading into one element per letter (GSAP SplitText, SplitType, Splitting.js, hand-made letter-by-letter reveals) do the same: every letter is a box, and the line may break between any two of them. None of this shows in the HTML or on a desktop screen. It happens on phones, often at one width only, and reads as a mistake.

`--words` opens every page with content (noindex ones too, not error pages or redirects) in a real browser at each width, scrolls through it so scroll-triggered animations play, waits `--settle` ms and for the page's own CSS animations to end, and checks where every letter of every heading sits, twice a moment apart. A word whose consecutive letters are on different lines is an error. Fine: a break after a hyphen or at a soft hyphen (`&shy;`), parts of a heading on rows of their own by design (blocks, flex and grid items), screen-reader-only copies and scripts written without spaces. Vertical and sideways-turned text is not checked. A broken e-mail or web address is a warning, since it has no better place to break. It also warns when a page is wider than the screen, naming what sticks out.

What to do: a shorter word or another phrasing; let the heading's line out (a narrow `max-width`, often in `ch`, is a common cause); a smaller size on narrow screens (`clamp()`); a soft hyphen where the word may break (`hyphens: auto` hyphenates only in browsers that have patterns for the language, and elsewhere the word still breaks between letters without a hyphen, so `--words` warns about it); and in letter-by-letter animations, keep each word's letters in one element that does not wrap (`white-space: nowrap`) and make sure the word fits.

Pages are served from a small built-in server on 127.0.0.1 with the same address rules, and the site's own files come from the build even when a page names them by full address. Other sites' styles, fonts and scripts load, because they shape the heading; their pictures, frames and data requests are cut, so most analytics and ad pixels do not count the check as a visit (a script that counts with its own load or through a WebSocket still can). Playwright is an optional peer dependency, found through `PLAYWRIGHT_PATH`, then in the folder you run from, then next to the tool.

Try it after a build with nothing to install:

```bash
npx github:novuwebsolutions/static-seo-check --dist dist --site https://your.site
```

The tool is one file with no dependencies, so you can also put `static-seo-check.mjs` in your project (in `scripts/`, say) and run it after the build, for example from a `"check"` script that your deploy script runs first:

```bash
npm install --save-dev playwright && npx playwright install chromium webkit
node scripts/static-seo-check.mjs --dist dist --site https://your.site --words --engines chromium,webkit
```

Options: `--dist`, `--site`, `--ignore <prefix>` (repeatable: leaves out pages under it and links and sitemap entries pointing there, such as server routes), `--json`, `--words`, `--widths 320,375,414,768,1280`, `--engines chromium,webkit,firefox`, `--selector "h1, h2, h3, h4, h5, h6"`, `--settle 1500`, `--reduced-motion`. Each rendered option turns on `--words`.

Tests: `npm test`. The browser tests run only when Playwright and its Chromium are found, and are skipped otherwise; point `PLAYWRIGHT_PATH` at a `playwright` folder (or the `node_modules` holding it) to run them with another project's install.

Made by [Novu Web Solutions](https://novu.ee), a web studio in Viljandi, Estonia, for our own Astro site on Cloudflare. MIT licence.
