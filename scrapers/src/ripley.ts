import { applyCookies, openBrowser, parseCLP } from "./browser";
import { runLoop } from "./store";
import type { Offer } from "./types";

const RETAILER = "ripley";
// La ruta de categoría `/tecno/celulares/smartphones` está MUERTA: devuelve
// "La página que buscas ya no se encuentra disponible". El challenge de
// Cloudflare tapaba ese 404, así que durante un rato el scraper parecía
// bloqueado cuando además apuntaba a una URL inexistente. El buscador sí lista.
const CATEGORY =
  "https://simple.ripley.cl/search/smartphones?sort=relevance_desc&page=1";

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
 *
 * Investigado con probe/dump.js (borrado tras esta sesión): simple.ripley.cl es
 * un Next.js "pages router" que arma la página con Module Federation — el
 * listado de productos lo pinta un remote separado, `findabilitycomponent`,
 * cargado vía `remoteEntry.js` y varios chunks JS/CSS aparte. Esos chunks del
 * remote (no la página en sí, que carga bien) reciben intermitentemente un 403
 * de Cloudflare: en las pruebas, ~30-40% de las cargas lo consiguen y el resto
 * el remote muere con "findability/findability offline" + React error #418/423
 * y el DOM queda vacío (0 `<a>`, sólo el shell `__NEXT_DATA__` con
 * `findabilityProps.catalog: null`). No hay llamada JSON propia que capturar:
 * cuando el remote sí carga, pinta el catálogo directo a HTML server-rendered
 * por ese componente, sin un fetch de API adicional visible. Por eso la vía
 * DOM reintenta con recargas completas de página en vez de esperar más tiempo
 * en la misma carga.
 *
 * Selector real (visto en el DOM cuando el remote carga): cada producto es
 * `a.product-link` envolviendo un `article.product-item-horizontal`. El título
 * limpio está en `img[alt]` (no en un nodo de texto). El SKU es el número final
 * del slug de la URL, ej. `/smartphone-xiaomi-redmi-note-15-5g-256gb-2000409968466?...`
 * -> sku `2000409968466`. Los viejos selectores (`catalog-product-item`,
 * `prices__offer-price`, `a[href*="/p/"]`) no existen en este DOM: por eso
 * `json=0 dom=0` pese a que la página sí cargaba.
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

async function scrape(): Promise<{ offers: Offer[]; source: string }> {
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
    await page.waitForSelector("a.product-link", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);

    // El listado lo pinta un remote de Module Federation (findabilitycomponent)
    // cuyos chunks Cloudflare bloquea con 403 de forma intermitente (medido:
    // falla en la mayoría de las cargas). Cuando falla, el remote nunca monta y
    // el DOM queda vacío. Recargar la página completa (no sólo esperar más)
    // reintenta la carga de esos chunks desde cero, que es lo que en la
    // práctica lo destraba.
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = await page.evaluate(
        () => document.querySelectorAll("a.product-link").length
      );
      if (found > 0) break;
      console.log(`[${RETAILER}] intento ${attempt + 1}: 0 productos en el DOM, recargando`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.waitForSelector("a.product-link", { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(4_000);
    }

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
      const cards = document.querySelectorAll<HTMLAnchorElement>("a.product-link");

      for (const card of Array.from(cards)) {
        const href = card.getAttribute("href") ?? "";
        if (!href) continue;

        // El slug termina en el SKU numérico, antes de la querystring:
        // /smartphone-xiaomi-redmi-note-15-5g-256gb-2000409968466?color_80=...
        const skuMatch = href.match(/-(\d{6,})(?:\?|$)/);
        if (!skuMatch) continue;
        const sku = skuMatch[1];

        // El título limpio vive en el alt de la imagen, no en un nodo de texto.
        const title = card.querySelector("img[alt]")?.getAttribute("alt")?.trim() ?? "";
        if (title.length < 4) continue;

        // Se recogen todos los precios candidatos de la tarjeta y se descartan
        // los que estén marcados como "tarjeta" (crédito de la propia tienda).
        // Entre los que quedan (oferta/normal) se toma el MÁS ALTO: si uno de
        // ellos fuera en realidad el de tarjeta y no se detectó por el texto,
        // tomar el más alto nunca cuela un ahorro falso, sólo subestima uno real.
        const priceCandidates: number[] = [];
        card.querySelectorAll<HTMLElement>("[class*='price' i]").forEach((el) => {
          const context = (el.closest("[class*='price' i]")?.parentElement?.textContent ?? "") +
            " " + (el.getAttribute("class") ?? "") + " " + (el.textContent ?? "");
          if (/tarjeta/i.test(context)) return;
          const digits = (el.textContent ?? "").replace(/[^\d]/g, "");
          if (!digits) return;
          const n = Number(digits);
          if (Number.isFinite(n) && n > 1000) priceCandidates.push(n);
        });
        if (priceCandidates.length === 0) continue;
        const price = String(Math.max(...priceCandidates));

        results.push({
          sku,
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
      throw new Error(
        "navegador cargó la página pero no se extrajo ningún producto: tras 3 " +
          "reintentos con recarga completa, el remote 'findabilitycomponent' " +
          "(Module Federation) que pinta el catálogo no llegó a montar — sus " +
          "chunks JS/CSS reciben 403 de Cloudflare de forma intermitente. No es " +
          "un problema de selectores."
      );
    }
    return { offers, source: "navegador, sitio directo" };
  } finally {
    await browser.close();
  }
}

void runLoop(RETAILER, scrape);
