import { runLoop } from "./store";
import type { Offer } from "./types";

const RETAILER = "falabella";
const CATEGORY_URL =
  "https://www.falabella.com/falabella-cl/category/cat720161/Smartphones";
const PAGES = 3;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface FalabellaPrice {
  type?: string;
  price?: string[];
}

interface FalabellaResult {
  skuId?: string;
  productId?: string;
  displayName?: string;
  brand?: string;
  url?: string;
  prices?: FalabellaPrice[];
}

/**
 * "1.199.990" -> 1199990. El separador de miles chileno es el punto, así que
 * quitarlo es correcto aquí; un parseFloat ingenuo devolvería 1.19.
 */
function parseCLP(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 0) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Precio comparable entre retailers.
 *
 * Decisión de negocio, no de parsing: se EXCLUYE `cmrPrice`. Es el precio con
 * la tarjeta de crédito de la propia tienda, así que compararlo contra el
 * precio al contado de otro retailer inventa un "más barato" que el usuario no
 * puede pagar sin contratar un producto financiero. Comparamos lo que cualquiera
 * paga hoy: internetPrice / eventPrice, y normalPrice sólo como último recurso.
 */
function comparablePrice(prices: FalabellaPrice[] | undefined): number | null {
  if (!prices) return null;

  const pick = (types: string[]): number | null => {
    const values = prices
      .filter((p) => p.type !== undefined && types.includes(p.type))
      .flatMap((p) => p.price ?? [])
      .map(parseCLP)
      .filter((n): n is number => n !== null);
    return values.length > 0 ? Math.min(...values) : null;
  };

  return pick(["internetPrice", "eventPrice"]) ?? pick(["normalPrice"]);
}

/**
 * Elige el encoding por respuesta, no por suposición.
 *
 * Orden: (1) el charset que declare la cabecera; (2) UTF-8 estricto, que falla
 * si los bytes no son UTF-8 válido; (3) latin1, que nunca falla. El paso 2 es
 * el que distingue de verdad: un texto ISO-8859-1 con acentos NO es UTF-8
 * válido, así que el decodificador estricto lo rechaza y caemos a latin1.
 */
function decodeBody(buf: Buffer, contentType: string | null): string {
  const declared = contentType?.match(/charset=([\w-]+)/i)?.[1]?.toLowerCase();
  if (declared && /8859|latin1/.test(declared)) return buf.toString("latin1");
  if (declared === "utf-8" || declared === "utf8") return buf.toString("utf8");

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return buf.toString("latin1");
  }
}

/**
 * Repara mojibake por título, no por documento.
 *
 * Medido: Falabella mezcla los dos encodings DENTRO de la misma respuesta —
 * unos títulos llegan bien y otros con la firma clásica de UTF-8 leído como
 * latin1 ("cámara" -> "cÃ¡mara"). Por eso decidir el encoding a nivel de
 * documento no alcanza: se repara cada cadena por separado, y sólo si muestra
 * esa firma. Si el resultado no mejora, se devuelve el original intacto.
 */
function fixMojibake(s: string): string {
  if (!/Ã[\x80-\xbf]|Â[\x80-\xbf]/.test(s)) return s;
  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(s, "latin1")
    );
    return repaired;
  } catch {
    return s;
  }
}

async function fetchPage(page: number): Promise<FalabellaResult[]> {
  const url = page === 1 ? CATEGORY_URL : `${CATEGORY_URL}?page=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "es-CL,es;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);

  // El encoding NO es constante: la primera página declara ISO-8859-1 en su
  // <meta charSet>, pero otras vienen en UTF-8. Fijar uno de los dos rompe los
  // acentos en el otro ("Batería" -> "Bater?a", o "cámara" -> "cÃ¡mara"), y los
  // títulos son la materia prima de la unificación. Se decide por respuesta.
  const html = decodeBody(Buffer.from(await res.arrayBuffer()), res.headers.get("content-type"));

  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) throw new Error("no se encontró __NEXT_DATA__ en el HTML");

  const data = JSON.parse(m[1]);
  const results = data?.props?.pageProps?.results;
  return Array.isArray(results) ? (results as FalabellaResult[]) : [];
}

/**
 * Falabella NO necesita navegador: renderiza en servidor con Next.js y embebe
 * el catálogo entero en __NEXT_DATA__. Un GET con User-Agent de navegador basta.
 */
async function scrape(): Promise<Offer[]> {
  const offers: Offer[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= PAGES; page++) {
    let results: FalabellaResult[];
    try {
      results = await fetchPage(page);
    } catch (err) {
      // Una página caída no invalida las anteriores: se registra y se sigue.
      console.error(`[${RETAILER}] página ${page} falló: ${String(err)}`);
      break;
    }
    if (results.length === 0) break;

    for (const r of results) {
      const sku = r.skuId ?? r.productId;
      const title = r.displayName;
      const price = comparablePrice(r.prices);
      if (!sku || !title || price === null) continue;
      if (seen.has(sku)) continue;
      seen.add(sku);

      offers.push({
        retailer: RETAILER,
        sku,
        title: fixMojibake(title),
        brand: r.brand,
        priceCLP: price,
        url: r.url ?? CATEGORY_URL,
        scrapedAt: new Date().toISOString(),
      });
    }
  }

  if (offers.length === 0) throw new Error("0 ofertas extraídas");
  return offers;
}

void runLoop(RETAILER, scrape);
