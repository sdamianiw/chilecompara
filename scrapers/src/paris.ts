import { applyCookies, openBrowser } from "./browser";
import { runLoop } from "./store";
import type { Offer } from "./types";

const RETAILER = "paris";
const ORIGIN = "https://www.paris.cl";
const CATEGORY_PATHS = [
  "/tecnologia/celulares/",
  "/tecnologia/celulares/smartphones/",
];

/**
 * Paris ya NO corre sobre VTEX.
 *
 * La primera versión de este scraper llamaba a la API de catálogo de VTEX, que
 * es lo que uno espera de un retailer chileno grande. Estaba equivocada: esos
 * endpoints no están bloqueados, **ya no existen**. Comprobado:
 * `pariscl.vtexcommercestable.com.br` responde 400 "This store is temporarily
 * unavailable" y el dominio público sirve `/_next/static/chunks/`. Paris migró a
 * Next.js con Constructor.io para búsqueda y catálogo.
 *
 * Eso cambia dónde están los datos: cada tarjeta del listado es un
 * `<div role="gridcell">` con los atributos de analítica de Constructor.io ya
 * puestos: `data-cnstrc-item-name`, `-item-id`, `-item-price`. Es metadata
 * estructurada dentro del HTML: mejor que raspar texto de la maqueta, porque no
 * depende de clases CSS que cambian con cada rediseño.
 *
 * El acceso sigue siendo el problema: AWS WAF sirve un CAPTCHA de imágenes.
 * Dos vías, en orden de preferencia, y el portal dice cuál se usó.
 */

/** El precio viene como entero limpio en el atributo; se valida igual. */
function parsePrice(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Extrae las tarjetas del HTML renderizado.
 *
 * Se parsea la ETIQUETA completa y de ahí sus atributos, en vez de recolectar
 * cada atributo por separado y emparejarlos por posición: si una tarjeta llegara
 * sin precio, el emparejamiento posicional desplazaría todos los precios una
 * fila y asignaría a cada teléfono el precio del siguiente. Un error así no
 * rompe nada visiblemente: simplemente muestra precios falsos.
 */
function parseGridcells(html: string): Offer[] {
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const tags = html.match(/<div[^<>]*data-cnstrc-item-name[^<>]*>/g) ?? [];

  for (const tag of tags) {
    const name = tag.match(/data-cnstrc-item-name="([^"]*)"/)?.[1];
    const id = tag.match(/data-cnstrc-item-id="([^"]*)"/)?.[1];
    const priceRaw = tag.match(/data-cnstrc-item-price="([^"]*)"/)?.[1];
    if (!name || !id || !priceRaw) continue;

    const price = parsePrice(priceRaw);
    if (price === null) continue;
    if (seen.has(id)) continue;
    seen.add(id);

    offers.push({
      retailer: RETAILER,
      sku: id,
      title: decodeEntities(name),
      priceCLP: price,
      url: `${ORIGIN}/tecnologia/celulares/`,
      scrapedAt: new Date().toISOString(),
    });
  }

  return offers;
}

/**
 * Vía 1: el sitio directo, con navegador.
 *
 * Sólo prospera si alguien pasó el CAPTCHA y exportó su cookie
 * (`PARIS_WAF_COOKIE`). Sin ella, AWS WAF sirve el reto y se devuelve null para
 * que el llamador pruebe la otra vía. No se lanza excepción: no encontrar
 * camino aquí es un resultado esperado, no un fallo.
 */
async function fetchDirect(path: string): Promise<string | null> {
  const { browser, context } = await openBrowser();
  try {
    const injected = await applyCookies(context, process.env.PARIS_WAF_COOKIE, ".paris.cl");
    if (injected > 0) console.log(`[${RETAILER}] usando ${injected} cookie(s) de sesión provistas`);

    const page = await context.newPage();
    await page.goto(`${ORIGIN}${path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(5_000);

    const html = await page.content();
    if (html.includes("captcha.js") || html.includes("Let's confirm you are human") || html.includes("gokuProps")) {
      console.warn(`[${RETAILER}] sitio directo: AWS WAF sirvió el CAPTCHA`);
      return null;
    }
    return html;
  } catch (err) {
    console.warn(`[${RETAILER}] sitio directo falló: ${String(err)}`);
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * Vía 2: proxy de lectura público.
 *
 * `r.jina.ai` carga la URL con un navegador propio y devuelve el DOM ya
 * renderizado. Los datos siguen siendo del catálogo real de Paris y del momento
 * en que se pide, no es una copia en caché ni un fixture. Pero es un
 * INTERMEDIARIO, y eso se declara: queda en el estado del scraper, se muestra
 * en el portal y está escrito en el README. Presentarlo como acceso directo
 * sería mentir sobre la procedencia del dato.
 */
async function fetchViaReader(path: string): Promise<string> {
  const res = await fetch(`https://r.jina.ai/${ORIGIN}${path}`, {
    headers: { "x-return-format": "html" },
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`proxy de lectura HTTP ${res.status}`);
  return await res.text();
}

async function scrape(): Promise<{ offers: Offer[]; source: string }> {
  const all: Offer[] = [];
  const seen = new Set<string>();
  let source = "";

  for (const path of CATEGORY_PATHS) {
    let html = await fetchDirect(path);
    let via = "sitio directo";

    if (html === null) {
      html = await fetchViaReader(path);
      via = "proxy de lectura (r.jina.ai)";
    }

    const found = parseGridcells(html);
    console.log(`[${RETAILER}] ${path} -> ${found.length} productos (${via})`);

    for (const offer of found) {
      if (seen.has(offer.sku)) continue;
      seen.add(offer.sku);
      all.push(offer);
    }
    if (source === "" || via === "sitio directo") source = via;
  }

  if (all.length === 0) {
    throw new Error(
      "ninguna vía devolvió productos: AWS WAF sirve un CAPTCHA interactivo en el " +
        "sitio directo y el proxy de lectura no entregó tarjetas"
    );
  }
  return { offers: all, source };
}

void runLoop(RETAILER, scrape);
