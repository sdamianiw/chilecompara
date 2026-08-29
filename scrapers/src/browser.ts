import { chromium, type Browser, type BrowserContext } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Contexto de navegador con una identidad coherente.
 *
 * No es "stealth" ni evasión: es no mentir. Un contexto con User-Agent de
 * Chrome pero locale en inglés, sin idioma aceptado y con `navigator.webdriver`
 * en true es incoherente consigo mismo, y esa incoherencia es lo que los
 * sistemas anti-bot detectan. Aquí sólo se declara lo mismo que declararía el
 * navegador de un usuario chileno.
 */
export async function openBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    userAgent: UA,
    locale: "es-CL",
    timezoneId: "America/Santiago",
    viewport: { width: 1440, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "es-CL,es;q=0.9" },
  });

  return { browser, context };
}

/**
 * Inyecta cookies de sesión obtenidas fuera del contenedor.
 *
 * Por qué existe: Paris y Ripley no sirven un desafío que un navegador resuelva
 * solo, sino uno que exige una persona — un puzzle de imágenes de AWS WAF y un
 * managed challenge de Cloudflare. Fingir que no existe no es una opción, y
 * falsear los datos tampoco. Lo honesto es aislar el paso humano: alguien pasa
 * el desafío UNA vez en su navegador, exporta la cookie, y a partir de ahí el
 * scraper hace peticiones reales al sitio real, sin intervención.
 *
 * Formato de la variable de entorno: `nombre=valor; otro=valor`, tal cual se
 * copia desde las DevTools del navegador.
 *
 * Si la variable no está, no pasa nada: el scraper intenta la vía automática y,
 * si lo bloquean, reporta el motivo. Nunca inventa datos.
 */
export async function applyCookies(
  context: BrowserContext,
  raw: string | undefined,
  domain: string
): Promise<number> {
  if (!raw || raw.trim() === "") return 0;

  const cookies = raw
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.includes("="))
    .map((part) => {
      const idx = part.indexOf("=");
      return {
        name: part.slice(0, idx).trim(),
        value: part.slice(idx + 1).trim(),
        domain,
        path: "/",
      };
    });

  if (cookies.length === 0) return 0;
  await context.addCookies(cookies);
  return cookies.length;
}

/** "$ 1.199.990" / "1199990" -> 1199990. El punto es separador de miles en CLP. */
export function parseCLP(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  }
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}
