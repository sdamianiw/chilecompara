import { applyCookies, openBrowser, parseCLP } from "./browser";
import { runLoop } from "./store";
import type { Offer } from "./types";

const RETAILER = "ripley";
// La ruta de categoría `/tecno/celulares/smartphones` está MUERTA: devuelve
// "La página que buscas ya no se encuentra disponible", y el interstitial de
// Cloudflare tapaba ese 404 — durante un rato el scraper parecía bloqueado
// cuando además apuntaba a una URL inexistente. El buscador sí lista.
const SEARCH = "https://simple.ripley.cl/search/smartphones?sort=relevance_desc&page=";
// 4, no 2. `relevance_desc` es un ranking que la tienda recalcula sola: pedir
// "las N páginas más relevantes" devuelve un CONJUNTO distinto de teléfonos en
// cada pasada, no los mismos con otro precio. Medido en una sesión: 102, 54, 0,
// 102, 57 ofertas, y los productos comparables entre tiendas se movían con
// ellas (correlación 0.78). Más páginas no eliminan la causa —para eso habría
// que ordenar por una clave estable, ver Limitaciones— pero amplían el solape
// con las otras tiendas, que es lo que sostiene una tarjeta de tres precios.
const PAGES = 4;

/**
 * Ripley: navegador obligatorio, pero NO para leer el DOM.
 *
 * El sitio está detrás de Cloudflare — sin navegador da HTTP 403 y un shell
 * `class="no-js"` sin producto alguno. Hace falta un navegador (y, mientras el
 * challenge sea de los que exigen una persona, una cookie de sesión) sólo para
 * ATRAVESAR LA PUERTA.
 *
 * Una vez dentro, se ignora el DOM a propósito. La página se arma con Module
 * Federation (Webpack 5) y el listado lo pinta un remote aparte
 * (`findabilitycomponent`) cuyos chunks internos reciben 403 intermitente: el
 * DOM queda vacío sin que nada parezca fallar, y sólo monta un 30-40 % de las
 * veces. Pero el catálogo YA VIENE renderizado por el servidor dentro de
 * `__NEXT_DATA__`, en `props.pageProps.findabilityProps.data.products`, con
 * marca, nombre, sku y precio como campos propios.
 *
 * Depender del HTML del servidor en vez del render del cliente convierte un
 * scraper que acierta una de cada tres veces en uno determinista.
 */

interface RipleyProduct {
  sku?: string;
  code?: string;
  parentProductID?: string | number;
  name?: string;
  brand?: string;
  price?: string;
  priceNumber?: number;
  oldPrice?: string;
  /** Precio con Tarjeta Ripley. NUNCA se usa: ver más abajo. */
  ripleyPrice?: string;
}

/**
 * Precio comparable entre tiendas.
 *
 * Decisión de negocio, no de parsing: se ignora `ripleyPrice`. Exige la tarjeta
 * de crédito de la propia tienda, así que compararlo contra el precio al contado
 * de Falabella o Paris anuncia un ahorro que el usuario no puede obtener sin
 * contratar un producto financiero. Se usa `price` (contado), y `oldPrice`
 * —el precio de lista— sólo si el primero no viene.
 */
function comparablePrice(p: RipleyProduct): number | null {
  return parseCLP(p.price ?? p.priceNumber ?? null) ?? parseCLP(p.oldPrice ?? null);
}

function extractProducts(html: string): RipleyProduct[] {
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) return [];

  try {
    const data = JSON.parse(m[1]);
    const products = data?.props?.pageProps?.findabilityProps?.data?.products;
    return Array.isArray(products) ? (products as RipleyProduct[]) : [];
  } catch {
    return [];
  }
}

async function scrape(): Promise<{ offers: Offer[]; source: string }> {
  const { browser, context } = await openBrowser();
  try {
    const injected = await applyCookies(context, process.env.RIPLEY_CF_COOKIE, ".ripley.cl");
    if (injected > 0) console.log(`[${RETAILER}] usando ${injected} cookie(s) de sesión provistas`);

    const page = await context.newPage();
    const offers: Offer[] = [];
    const seen = new Set<string>();
    let blocked = "";

    for (let n = 1; n <= PAGES; n++) {
      await page.goto(`${SEARCH}${n}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(3_000);

      const html = await page.content();

      // El interstitial de Cloudflare es un estado distinto de "no hay
      // productos", y merece un mensaje distinto: uno se arregla con una cookie
      // nueva y el otro no.
      const title = await page.title();
      if (/un momento|just a moment|comprobando tu navegador/i.test(title)) {
        blocked =
          `bloqueado por el challenge de Cloudflare (title="${title}"). ` +
          `La cookie de sesión caduca en ~30 min: hay que renovarla`;
        break;
      }

      const products = extractProducts(html);
      console.log(`[${RETAILER}] página ${n}: ${products.length} productos en __NEXT_DATA__`);
      if (products.length === 0) break;

      for (const p of products) {
        const sku = p.sku ?? p.code ?? (p.parentProductID ? String(p.parentProductID) : undefined);
        const price = comparablePrice(p);
        if (!sku || !p.name || price === null) continue;
        if (seen.has(sku)) continue;
        seen.add(sku);

        offers.push({
          retailer: RETAILER,
          sku,
          title: p.name,
          brand: p.brand,
          priceCLP: price,
          url: `${SEARCH}1`,
          scrapedAt: new Date().toISOString(),
        });
      }
    }

    if (offers.length === 0) {
      // Sin cookie, Cloudflare sirve una página que CARGA y viene vacía, así que
      // el síntoma es idéntico al de un cambio de esquema. Medido levantando el
      // repo en frío desde un clon limpio: el mensaje culpaba a Ripley de haber
      // cambiado `findabilityProps` cuando lo único que faltaba era configurar
      // `.env`. Quien clona esto por primera vez merece el diagnóstico correcto,
      // no una pista falsa que le haga leer el parser.
      throw new Error(
        blocked ||
          (injected === 0
            ? "no se configuró RIPLEY_CF_COOKIE: sin cookie de sesión, " +
              "Cloudflare devuelve una página vacía. Copia `.env.example` a " +
              "`.env` y sigue las instrucciones que trae dentro"
            : "la página cargó pero __NEXT_DATA__ no traía productos: puede que " +
              "la estructura de findabilityProps haya cambiado")
      );
    }
    return { offers, source: "navegador + __NEXT_DATA__ del servidor" };
  } finally {
    await browser.close();
  }
}

void runLoop(RETAILER, scrape);
