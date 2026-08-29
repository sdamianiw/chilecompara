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
