import { applyCookies, openBrowser, parseCLP } from "./browser";
import { runLoop } from "./store";
import type { Offer } from "./types";

const RETAILER = "paris";
const HOME = "https://www.paris.cl/";

/**
 * Paris corre sobre VTEX, cuya API de catálogo es pública... pero TODO el
 * dominio está detrás de AWS WAF: un curl recibe HTTP 405 y una página
 * "Human Verification" con `window.gokuProps`, incluso en el sitemap.
 *
 * Por eso hace falta navegador. Y una vez que el navegador resolvió el desafío,
 * NO raspamos el DOM: pedimos el JSON de VTEX desde dentro de la página, que ya
 * lleva la cookie del WAF. Se obtiene metadata estructurada — marca y precio en
 * campos propios — en vez de texto extraído de un maquetado que cambia solo.
 */
const VTEX_ENDPOINTS = [
  "/api/catalog_system/pub/products/search/tecnologia/celulares?_from=0&_to=49",
  "/api/catalog_system/pub/products/search?ft=smartphone&_from=0&_to=49",
  "/api/catalog_system/pub/products/search?ft=celular&_from=0&_to=49",
];

interface VtexSeller {
  commertialOffer?: { Price?: number; ListPrice?: number; IsAvailable?: boolean };
}
interface VtexItem {
  itemId?: string;
  sellers?: VtexSeller[];
}
interface VtexProduct {
  productId?: string;
  productName?: string;
  brand?: string;
  link?: string;
  linkText?: string;
  items?: VtexItem[];
}

/** Precio al contado más bajo entre los sellers disponibles del producto. */
function priceOf(p: VtexProduct): number | null {
  const prices: number[] = [];
  for (const item of p.items ?? []) {
    for (const seller of item.sellers ?? []) {
      const offer = seller.commertialOffer;
      if (!offer) continue;
      if (offer.IsAvailable === false) continue;
      const price = parseCLP(offer.Price ?? offer.ListPrice ?? null);
      if (price !== null) prices.push(price);
    }
  }
  return prices.length > 0 ? Math.min(...prices) : null;
}

async function scrape(): Promise<Offer[]> {
  const { browser, context } = await openBrowser();
  try {
    // Si alguien resolvió el desafío en su navegador y exportó la cookie, se
    // usa esa sesión. Los datos siguen siendo del sitio real y en vivo: lo
    // único que aporta el humano es haber pasado el CAPTCHA una vez.
    const injected = await applyCookies(context, process.env.PARIS_WAF_COOKIE, ".paris.cl");
    if (injected > 0) console.log(`[${RETAILER}] usando ${injected} cookie(s) de sesión provistas`);

    const page = await context.newPage();

    // Primero la home: es donde el challenge de AWS WAF se ejecuta y deja su
    // cookie. Ir directo a la API sin pasar por aquí devuelve el interstitial.
    await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(6_000);

    let html = await page.content();
    if (html.includes("gokuProps") || html.includes("Human Verification")) {
      // El desafío se resuelve solo en un navegador real, pero necesita tiempo
      // y a veces una segunda carga.
      await page.waitForTimeout(6_000);
      await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForTimeout(4_000);
      html = await page.content();
    }

    // Verificado a mano (docker run interactivo, con y sin xvfb-run headed):
    // AWS WAF no sirve aquí un challenge JS silencioso, sino un CAPTCHA
    // interactivo real -- carga captcha.js y renderiza "Let's confirm you are
    // human" con un botón "Begin" que abre un puzzle de imágenes. Reintentar
    // la carga o esperar más no lo resuelve: hace falta clic humano + puzzle
    // visual, o un servicio de resolución de CAPTCHA (fuera de alcance). No
    // tiene sentido seguir insistiendo en cada vuelta contra los endpoints:
    // todos van a devolver el mismo 405 mientras el reto siga sin resolver.
    if (html.includes("captcha.js") || html.includes("Let's confirm you are human")) {
      throw new Error(
        "bloqueado por AWS WAF: CAPTCHA interactivo (Human Verification / captcha.js), " +
          "no un challenge JS silencioso -- requiere resolución humana o servicio de CAPTCHA solving, fuera de alcance"
      );
    }

    let products: VtexProduct[] = [];
    let lastError = "ningún endpoint devolvió productos";

    for (const endpoint of VTEX_ENDPOINTS) {
      const result = await page.evaluate(async (path: string) => {
        try {
          const res = await fetch(path, {
            headers: { accept: "application/json" },
            credentials: "include",
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const body = await res.json();
          return Array.isArray(body) ? { body } : { error: "respuesta no es una lista" };
        } catch (e) {
          return { error: String(e) };
        }
      }, endpoint);

      if (result.body && result.body.length > 0) {
        products = result.body as VtexProduct[];
        console.log(`[${RETAILER}] ${endpoint} -> ${products.length} productos`);
        break;
      }
      lastError = `${endpoint}: ${result.error ?? "0 productos"}`;
      console.warn(`[${RETAILER}] ${lastError}`);
    }

    if (products.length === 0) throw new Error(lastError);

    const offers: Offer[] = [];
    for (const p of products) {
      const sku = p.productId ?? p.items?.[0]?.itemId;
      const title = p.productName;
      const price = priceOf(p);
      if (!sku || !title || price === null) continue;

      offers.push({
        retailer: RETAILER,
        sku,
        title,
        brand: p.brand,
        priceCLP: price,
        url: p.link ?? (p.linkText ? `${HOME}${p.linkText}/p` : HOME),
        scrapedAt: new Date().toISOString(),
      });
    }

    if (offers.length === 0) throw new Error("productos recibidos pero ninguno con precio disponible");
    return offers;
  } finally {
    await browser.close();
  }
}

void runLoop(RETAILER, scrape);
