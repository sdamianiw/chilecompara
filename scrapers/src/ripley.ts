import { applyCookies, openBrowser, parseCLP } from "./browser";
import { runLoop } from "./store";
import type { Offer } from "./types";

const RETAILER = "ripley";
const CATEGORY = "https://simple.ripley.cl/tecno/celulares/smartphones?s=mdco";

/**
 * Ripley devuelve HTTP 403 y un shell `<html class="no-js">` a cualquier
 * petición sin navegador: el markup de producto sólo aparece después de que su
 * JavaScript se ejecute. Por eso necesita Chromium.
 *
 * Se intentan dos vías sobre la MISMA carga de página, y gana la que traiga más
 * productos: (1) las respuestas JSON que la SPA pide para pintarse — datos
 * estructurados, inmunes a un cambio de maquetado; (2) el DOM ya renderizado.
 * Tener dos fuentes no es redundancia: un rediseño rompe la segunda y un cambio
 * de API rompe la primera, y nunca las dos el mismo día.
 */

interface Harvested {
  sku: string;
  title: string;
  brand?: string;
  price: number;
  url: string;
}

/** Recorre un JSON arbitrario y recoge lo que parezca un producto con precio. */
function harvestFromJson(node: unknown, out: Harvested[], depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const child of node) harvestFromJson(child, out, depth + 1);
    return;
  }

  const o = node as Record<string, unknown>;
  const title = (o.name ?? o.productName ?? o.title) as string | undefined;
  const sku = (o.partNumber ?? o.sku ?? o.productId ?? o.id) as string | number | undefined;

  // `prices.offer` es el precio al contado. Se ignora deliberadamente el precio
  // "Tarjeta Ripley": exige la tarjeta de la propia tienda, así que compararlo
  // contra el precio al contado de otra tienda inventa un ahorro irreal.
  const priceRaw =
    (o.offerPrice as unknown) ??
    (o.normalPrice as unknown) ??
    ((o.prices as Record<string, unknown> | undefined)?.offerPrice as unknown) ??
    ((o.prices as Record<string, unknown> | undefined)?.normalPrice as unknown);

  const price = parseCLP(priceRaw as string | number | null | undefined);

  if (typeof title === "string" && title.length > 3 && sku !== undefined && price !== null) {
    out.push({
      sku: String(sku),
      title,
      brand: typeof o.brand === "string" ? o.brand : undefined,
      price,
      url: typeof o.url === "string" ? o.url : CATEGORY,
    });
    return;
  }

  for (const value of Object.values(o)) harvestFromJson(value, out, depth + 1);
}

async function scrape(): Promise<Offer[]> {
  const { browser, context } = await openBrowser();
  try {
    // Mitigación barata: Cloudflare (el guardián real de simple.ripley.cl, ver
    // más abajo) mira `navigator.webdriver` como una de varias señales. No
    // basta por sí sola -medido-, pero no cuesta nada dejarla puesta.
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    // Misma vía que Paris: una cookie `cf_clearance` obtenida por una persona
    // al pasar el challenge convierte esto en un scraper autónomo contra el
    // sitio real. Sin ella, se intenta igual y se reporta el bloqueo.
    const injected = await applyCookies(
      context,
      process.env.RIPLEY_CF_COOKIE,
      ".ripley.cl"
    );
    if (injected > 0) console.log(`[${RETAILER}] usando ${injected} cookie(s) de sesión provistas`);

    const page = await context.newPage();
    const fromJson: Harvested[] = [];

    page.on("response", async (res) => {
      const type = res.headers()["content-type"] ?? "";
      if (!type.includes("application/json")) return;
      try {
        harvestFromJson(await res.json(), fromJson);
      } catch {
        // Una respuesta ilegible no es un fallo del scraper: sigue el DOM.
      }
    });

    await page.goto(CATEGORY, { waitUntil: "domcontentloaded", timeout: 60_000 });

    // El challenge necesita que el JS corra; los productos aparecen después.
    await page
      .waitForSelector("a[href*='/p/'], .catalog-product-item, [class*='catalog-product']", {
        timeout: 30_000,
      })
      .catch(() => undefined);
    await page.waitForTimeout(5_000);

    // simple.ripley.cl está detrás de Cloudflare: la carga inicial responde
    // 307 -> 403 y sirve un interstitial ("Un momento… estamos comprobando tu
    // navegador") con título "Un momento…". Medido: sigue mostrando ese
    // interstitial pasados 20s de espera y con `navigator.webdriver`
    // enmascarado -la única mitigación posible sin tocar otros ficheros o
    // añadir dependencias-. Si sigue ahí, ni la vía JSON ni la vía DOM van a
    // encontrar nunca productos: se corta ya con un motivo preciso en vez de
    // agotar el timeout completo para acabar en el mismo "no hay productos".
    const challenge = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 200),
    }));
    if (/un momento|comprobando tu navegador|verifica que tú eres un ser humano/i.test(
      `${challenge.title} ${challenge.text}`
    )) {
      throw new Error(
        `bloqueado por el challenge anti-bot de Cloudflare de simple.ripley.cl ` +
          `(HTTP 403 en la carga inicial, interstitial "Un momento…" persiste tras espera; ` +
          `title="${challenge.title}")`
      );
    }

    const fromDom = (await page.evaluate(() => {
      const results: { sku: string; title: string; price: string; url: string }[] = [];
      const cards = document.querySelectorAll<HTMLElement>(
        "a.catalog-product-item, [class*='catalog-product-item'], a[href*='/p/']"
      );

      for (const card of Array.from(cards)) {
        const link = card instanceof HTMLAnchorElement ? card : card.querySelector("a");
        const href = link?.getAttribute("href") ?? "";
        if (!href) continue;

        const titleEl = card.querySelector(
          "[class*='product-details__name'], [class*='product-name'], h3, h2"
        );
        const title = titleEl?.textContent?.trim() ?? "";
        if (title.length < 4) continue;

        // Se toma el precio de oferta o el normal; nunca el de tarjeta Ripley.
        const priceEl = card.querySelector(
          "[class*='prices__offer-price'], [class*='offer-price'], [class*='prices__list-price'], [class*='normal-price']"
        );
        const price = priceEl?.textContent?.trim() ?? "";
        if (!price) continue;

        results.push({
          sku: href.split("/").filter(Boolean).pop() ?? href,
          title,
          price,
          url: href.startsWith("http") ? href : `https://simple.ripley.cl${href}`,
        });
      }
      return results;
    })) as { sku: string; title: string; price: string; url: string }[];

    const domHarvest: Harvested[] = [];
    for (const d of fromDom) {
      const price = parseCLP(d.price);
      if (price === null) continue;
      domHarvest.push({ sku: d.sku, title: d.title, price, url: d.url });
    }

    console.log(`[${RETAILER}] json=${fromJson.length} dom=${domHarvest.length}`);
    const winner = fromJson.length >= domHarvest.length ? fromJson : domHarvest;

    const seen = new Set<string>();
    const offers: Offer[] = [];
    for (const h of winner) {
      if (seen.has(h.sku)) continue;
      seen.add(h.sku);
      offers.push({
        retailer: RETAILER,
        sku: h.sku,
        title: h.title,
        brand: h.brand,
        priceCLP: h.price,
        url: h.url,
        scrapedAt: new Date().toISOString(),
      });
    }

    if (offers.length === 0) {
      throw new Error("navegador cargó la página pero no se extrajo ningún producto (posible bloqueo anti-bot)");
    }
    return offers;
  } finally {
    await browser.close();
  }
}

void runLoop(RETAILER, scrape);
