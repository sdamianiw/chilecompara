import Redis from "ioredis";
import type { Offer, ScrapeStatus } from "./types";

const REDIS_URL = process.env.REDIS_URL ?? "redis://redis:6379";

export const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

/**
 * Persiste las ofertas de un retailer y avisa al unifier.
 *
 * Se borran primero las ofertas previas de ESTE retailer para que un producto
 * retirado del catálogo no quede fantasma en el portal. Los demás retailers no
 * se tocan: cada nodo es dueño de su propio espacio de claves.
 */
export async function saveOffers(retailer: string, offers: Offer[]): Promise<void> {
  const existing = await redis.hkeys("offers");
  const mine = existing.filter((k) => k.startsWith(`${retailer}:`));

  const tx = redis.multi();
  if (mine.length > 0) tx.hdel("offers", ...mine);
  for (const o of offers) {
    tx.hset("offers", `${o.retailer}:${o.sku}`, JSON.stringify(o));
  }
  await tx.exec();

  // Señal para que el unifier recalcule ahora, en vez de esperar su siguiente vuelta.
  await redis.lpush("events", retailer);
}

export async function saveStatus(status: ScrapeStatus): Promise<void> {
  await redis.hset("scrape:status", status.retailer, JSON.stringify(status));
}

/**
 * Corre un scraper en bucle. Un fallo NO mata el contenedor: se registra el
 * motivo en Redis y se reintenta en la siguiente vuelta. El nodo sigue de pie
 * aunque el retailer esté bloqueándonos — eso es información, no una caída.
 */
export async function runLoop(
  retailer: string,
  scrape: () => Promise<{ offers: Offer[]; source?: string }>
): Promise<void> {
  const intervalSec = Number(process.env.SCRAPE_INTERVAL_SEC ?? "900");

  for (;;) {
    const started = Date.now();
    try {
      console.log(`[${retailer}] scrape start`);
      const { offers, source } = await scrape();
      await saveOffers(retailer, offers);
      await saveStatus({
        retailer,
        ok: true,
        count: offers.length,
        at: new Date().toISOString(),
        source,
      });
      console.log(
        `[${retailer}] scrape ok: ${offers.length} ofertas en ${Date.now() - started}ms` +
          (source ? ` (fuente: ${source})` : "")
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await saveStatus({
        retailer,
        ok: false,
        count: 0,
        error: msg,
        at: new Date().toISOString(),
      });
      console.error(`[${retailer}] scrape FAILED: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}
