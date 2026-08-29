/** Una oferta = un producto tal como lo publica UN retailer. Sin normalizar. */
export interface Offer {
  retailer: string;
  /** Identificador del producto en el catálogo del retailer. */
  sku: string;
  /** Título tal cual aparece en el sitio. Es la materia prima de la unificación. */
  title: string;
  /** Marca declarada por el sitio, cuando la publica. El unifier no depende de esto. */
  brand?: string;
  /** Precio en pesos chilenos, como entero. */
  priceCLP: number;
  url: string;
  scrapedAt: string;
}

/** Resultado de una corrida de scraping. Se persiste para que el portal pueda
 *  mostrar honestamente qué retailer respondió y cuál no. */
export interface ScrapeStatus {
  retailer: string;
  ok: boolean;
  count: number;
  error?: string;
  at: string;
}
