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

async function fetchPage(page: number): Promise<FalabellaResult[]> {
  const url = page === 1 ? CATEGORY_URL : `${CATEGORY_URL}?page=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "es-CL,es;q=0.9" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} en ${url}`);

  // La página se sirve en ISO-8859-1 (lo declara su propio <meta charSet>).
  // Decodificarla como UTF-8 destroza los acentos y contamina los títulos, que
  // son justamente la materia prima de la unificación.
  const html = Buffer.from(await res.arrayBuffer()).toString("latin1");

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
        title,
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
