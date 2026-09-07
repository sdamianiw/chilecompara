# chilecompara

![Go](https://img.shields.io/badge/backend-Go-00ADD8) ![TypeScript](https://img.shields.io/badge/scrapers-TypeScript-3178C6)

Comparing a smartphone's price across Falabella, Paris and Ripley means opening three tabs and matching titles that never agree word for word: one store calls it `Celular Galaxy S25 Ultra 256GB`, another `Samsung Galaxy S25 Ultra 256 GB Negro Titanio`.

Fetching the prices is the easy half. The hard part is deciding that two differently worded listings are the same phone, using rules general enough to work on a model that does not exist yet, with no hardcoded product list.

Everything runs locally with one command, no cloud account or paid API required. The only manual step is a browser cookie for the one retailer that puts a Cloudflare challenge in front of its catalog.

## Architecture

```
   falabella.com        paris.cl              simple.ripley.cl
   (SSR, HTTP 200)      (Next.js + WAF)        (Next.js + Cloudflare)
        |                     |                        |
        v                     v                        v
  scraper-falabella    scraper-paris           scraper-ripley
  (fetch, TS)           (browser or proxy, TS)  (Chromium, TS)
        \                     |                        /
         \                    v                       /
          '----------->   redis   <------------------'
                      (HSET offers, LPUSH events)
                             |
                             v
                          unifier (Go)
                   BRPOP events -> HGETALL offers
                   -> canonical key -> SET catalog
                             |
                             v
                           api (Go)
                     GET catalog -> JSON
                             |
                             v
                          portal (nginx)
                   proxies /api/ -> static HTML/JS cards
                             |
                             v
                      browser, localhost:8080
```

Seven containers, one responsibility each: `redis`, `scraper-falabella`, `scraper-paris`, `scraper-ripley`, `unifier`, `api`, `portal` (`docker-compose.yml`). No container both scrapes and unifies, or both unifies and serves HTTP.

Each scraper writes raw offers into a Redis hash (`offers`, keyed `{retailer}:{sku}`) and pushes its name onto a list (`events`). The unifier blocks on `BRPOP events`; when an event lands, or every 5 seconds if none does, it re-reads every offer, computes each one's canonical identity, groups them, and writes the resolved catalog to the `catalog` key. The API only reads that key and computes nothing of its own. The portal is static HTML served by nginx that polls the API every 10 seconds and proxies `/api/` so the browser sees one origin.

**Stack.** Scrapers run on Node with `playwright` 1.49.1 for the two sites that need a real browser and `ioredis` 5.4.1 to talk to Redis (`scrapers/package.json`). The unifier and API are Go processes using `github.com/redis/go-redis/v9`. Redis runs as the stock `redis:7-alpine` image with `--appendonly yes` and a named volume, so the catalog survives a full `docker compose down` (`docker-compose.yml`).

Each scraper re-scrapes every 900 seconds (`SCRAPE_INTERVAL_SEC` in `docker-compose.yml`), independently per retailer. The three containers do not wait on each other, so the catalog is always a merge of three snapshots taken at slightly different times.

## Quickstart

Four commands, one optional:

```bash
git clone <repo-url> && cd chilecompara
docker compose up --build
# open http://localhost:8080, Falabella and Paris populate with no setup
cp .env.example .env   # optional: add RIPLEY_CF_COOKIE for the third retailer
docker compose up -d --force-recreate scraper-ripley
```

`.env.example` walks through getting the Ripley cookie out of a browser's dev tools; it expires in about 30 minutes. Without it the portal still runs and shows "Ripley: no data" while comparing the other two.

## Results

| Metric | Value | How it was measured |
|---|---|---|
| Retailers scraped | 3 (Falabella, Paris, Ripley) | one scraper file per retailer in `scrapers/src/` |
| Services in `docker-compose.yml` | 7 | counted the `services:` block |
| API endpoints | 3 (`/api/products`, `/api/status`, `/api/health`) | `grep` on `api/main.go` |
| Unifier test functions | 6, with 11 table-driven cases inside `TestIdentify` | `grep` on `unifier/canonical_test.go` |
| Go LOC (unifier + api) | 978 (660 production + 218 test in `unifier/`, 100 in `api/`) | `wc -l` |
| TypeScript LOC (scrapers) | 685 across 6 files | `wc -l scrapers/src/*.ts` |
| Portal LOC (JS+HTML+CSS) | 313 | `wc -l portal/*` |
| Storage backend | 1 (Redis, AOF-persisted) | `docker-compose.yml` |
| Go module dependency | `github.com/redis/go-redis/v9 v9.7.0`, shared by `unifier` and `api` | `unifier/go.mod`, `api/go.mod` |
| Scraper dependencies | `playwright 1.49.1`, `ioredis 5.4.1` | `scrapers/package.json` |

No product/offer sample data ships in the repo. `probe/` (the scraper's raw dumps) is git-ignored, so every number above is about the code, not a specific catalog snapshot. With the stack running, the live counts come from:

```bash
# the API container is published on 8081; the portal on 8080
curl -s localhost:8081/api/status      # which scraper answered, and how
curl -s localhost:8081/api/products    # the unified catalog, with productCount/offerCount
```

Live catalog counts fluctuate run to run because retailer inventory rotates and Ripley's listing is sorted by relevance, not a stable key (see Limitations).

## Design decisions

- **Go for the unifier, TypeScript for the scrapers.** The scrapers need a real browser (Playwright) to get past Paris's WAF and Ripley's Cloudflare challenge, and Node's ecosystem for that is stronger. The unifier is a tight, testable transform over a few hundred JSON rows, where Go's static typing and single-binary deploy fit better than adding a second Node process (`unifier/main.go`, `scrapers/src/browser.ts`).
- **Cookie-based bypass instead of a paid unlocker.** `RIPLEY_CF_COOKIE` and `SCRAPER_UA` (`docker-compose.yml`, `.env.example`) are a manually obtained `cf_clearance` cookie tied to the browser that got it. It is a demo-grade workaround, documented in the repo rather than hidden in it.
- **Two-level product matching.** Offers first group by `brand | model | storage | condition`; a second pass merges storage-less offers (mostly Falabella's undated iPhones) into a group only when exactly one candidate exists for that model, to avoid inventing a false price match (`unifier/main.go`, `unify()`).
- **Accessories and bundles are filtered before matching**, not after: `unifier/canonical.go`'s `IsAccessoryOrBundle` regex removes chargers and add-on kits so their price never competes with a phone's.
- **The catalog is rebuilt from scratch on every event**, not updated incrementally. At a few hundred rows the cost is negligible, and it removes an entire class of stale-state bugs: a withdrawn offer that lingers, an old price that wins (`unifier/main.go`, `rebuild()`).
- **Falabella's HTML is decoded as `latin1`, not UTF-8**, because the page declares `charSet="iso-8859-1"`; decoding it as UTF-8 corrupts every accented character in the titles that the matcher depends on (`scrapers/src/falabella.ts`).
- **Matching logic is tested with real, measured titles, not invented ones.** `unifier/canonical_test.go` has 6 test functions; `TestIdentify` alone carries 11 table-driven cases built from titles pulled off the live Falabella and Ripley catalogs (RAM-before-ROM ordering, refurbished vs. new, storage-less iPhones, brand missing from the title), plus one deliberately invented phone to catch hardcoded product lists.
- **Redis is the only datastore, with AOF persistence and a mounted volume.** There is no Postgres and no separate cache layer. Offers, events and the resolved catalog all live in Redis, which is enough at a few hundred rows and keeps the number of moving parts down for a project meant to be cloned and run in one command.
- **The portal proxies the API instead of calling it cross-origin.** `portal/nginx.conf` forwards `/api/` to the `api` container so the browser only ever talks to one origin: no CORS headers to configure on the Go side or debug in the browser.
- **Storage is taken as the maximum of the numbers found, not the first one.** Titles mix RAM and ROM in either order (`8GB RAM+ 256GB Memoria` vs. `256GB (12GB RAM)`); taking the first match returned 8 GB for a 256 GB phone, which is both a wrong displayed spec and a split matching key (`unifier/canonical.go`).

## Limitations

- No CI and no automated test run wired into this repo beyond `go test ./...` in `unifier/`. The scrapers and API have no tests, so a retailer markup change is only caught by watching `/api/status` go to `ok: false`.
- Ripley's session cookie expires in roughly 30 minutes; keeping all three retailers live requires re-pasting `RIPLEY_CF_COOKIE` by hand, which rules out unattended long-running deployments as-is.
- Paris is read through a public proxy (`r.jina.ai`) by default because its AWS WAF serves an image CAPTCHA to direct and headless requests alike; the fallback is disclosed in the portal and in `scrapers/src/paris.ts` rather than silently substituted.
- Retailer HTML/JS structure drifts without notice: Paris moved off a VTEX catalog API to Next.js + Constructor.io mid-project, which broke the original scraper's assumptions entirely, not just its selectors.
- Coverage is partial and uneven across stores: a fixed number of listing pages per retailer, not the full catalog, so cross-store matches undercount what each store actually sells, and the undercount is worse for whichever retailer paginates least.
- Chile-only; prices are in CLP and the matching vocabulary (brands, colors, storage units) is tuned to these three retailers' title conventions, so adding a fourth retailer or another country means extending that vocabulary, not just plugging in a new scraper.
- Card-price fields (`cmrPrice` on Falabella, the store-card price on Ripley) are excluded by name so the comparison never uses a price that requires a store credit card: verified for those two, but not independently confirmed for Paris's single price attribute.
- Cards from Paris and Ripley link to the search results page, not the individual product page, because their scrapers pull data from listing metadata rather than a per-product fetch: the price is right, the click lands one step short of where it should.
- Network suffixes (`5G`, `LTE`) are dropped from the matching key on purpose, because one store writes "5G" in the title and another omits it for the same phone; the tradeoff is that a genuinely different `LTE`-only variant of a model can collapse into the same card as its `5G` sibling.
- The brand and color vocabularies used for title parsing are finite lists (`unifier/canonical.go`); an unlisted brand falls back to "first useful token," which works but is more fragile than reading a structured field, and an unlisted color can split a matching key that should have merged.

## License

MIT, see [LICENSE](LICENSE). Spanish original at [docs/README.es.md](docs/README.es.md).
