const CLP = new Intl.NumberFormat("es-CL", {
  style: "currency", currency: "CLP", maximumFractionDigits: 0,
});

const RETAILER_LABEL = { falabella: "Falabella", paris: "Paris", ripley: "Ripley" };

let catalog = { products: [] };

// El filtro "solo comparables" se ajusta a lo que hay, una única vez. Si ninguna
// tienda cruza con otra, dejarlo marcado abriría el portal en blanco: el usuario
// vería una pantalla vacía en vez del catálogo que sí tenemos.
let filterInitialised = false;

const $grid = document.getElementById("grid");
const $summary = document.getElementById("summary");
const $retailers = document.getElementById("retailers");
const $search = document.getElementById("search");
const $onlyMulti = document.getElementById("only-multi");
const $empty = document.getElementById("empty");

function label(retailer) {
  return RETAILER_LABEL[retailer] ?? retailer;
}

/** Cuántas ofertas de esa tienda hay en el catálogo que se está mostrando. */
function offersFrom(retailer) {
  return catalog.products.reduce(
    (n, p) => n + p.offers.filter((o) => o.retailer === retailer).length, 0);
}

function card(p) {
  const el = document.createElement("article");
  el.className = "card";

  const specs = [];
  if (p.storageGB > 0) specs.push(`${p.storageGB} GB`);
  if (p.condition === "reacondicionado") specs.push("reacondicionado");

  const rows = p.offers.map((o) => `
    <li class="row ${o.cheapest ? "row--cheapest" : ""}">
      <a class="row__retailer" href="${safeUrl(o.url)}" target="_blank" rel="noopener">${label(o.retailer)}</a>
      <span class="row__price">${CLP.format(o.priceCLP)}</span>
      ${o.cheapest ? '<span class="badge">más barato</span>' : ""}
    </li>`).join("");

  // El ahorro es lo que justifica la existencia del portal: se muestra sólo
  // cuando hay al menos dos tiendas que comparar, nunca inventado.
  const savings = p.retailerCount > 1 && p.savingsCLP > 0
    ? `<p class="savings">Ahorras ${CLP.format(p.savingsCLP)} comprando en ${label(p.cheapestRetailer)}</p>`
    : "";

  el.innerHTML = `
    <div class="card__head">
      <h2 class="card__title">${escapeHtml(p.displayName)}</h2>
      <p class="card__specs">${escapeHtml([p.brand, ...specs].filter(Boolean).join(" · "))}</p>
    </div>
    <ul class="rows">${rows}</ul>
    ${savings}
    <p class="card__meta">${p.retailerCount === 1 ? "Solo en 1 tienda" : `En ${p.retailerCount} tiendas`}</p>
  `;
  return el;
}

/**
 * Una URL raspada de un sitio de terceros es entrada no confiable, igual que el
 * título. Se escapa como atributo Y se exige que el esquema sea http(s): sin
 * esto, un `javascript:` en el campo `url` de una oferta se ejecutaría al hacer
 * clic. El título ya se escapaba; la URL era la superficie que nadie miraba.
 */
function safeUrl(raw) {
  try {
    const u = new URL(String(raw), window.location.origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "#";
    return escapeHtml(u.href);
  } catch {
    return "#";
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

/**
 * Normaliza para buscar: minúsculas y sin tildes.
 *
 * Sin esto, escribir "camara" no encuentra los productos cuyo título dice
 * "Cámara" — y nadie teclea las tildes en un buscador.
 */
function foldAccents(s) {
  return String(s ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

function render() {
  const q = foldAccents($search.value.trim());
  const onlyMulti = $onlyMulti.checked;

  const shown = catalog.products.filter((p) => {
    if (onlyMulti && p.retailerCount < 2) return false;
    if (!q) return true;
    return foldAccents(`${p.displayName} ${p.brand} ${p.model}`).includes(q);
  });

  $grid.replaceChildren(...shown.map(card));
  $empty.hidden = shown.length > 0;
  $empty.textContent = onlyMulti
    ? "Ningún producto aparece todavía en más de una tienda. Destilda el filtro para ver el catálogo completo."
    : "Sin productos que coincidan con la búsqueda.";
}

async function load() {
  try {
    const [catRes, statusRes] = await Promise.all([
      fetch("/api/products", { cache: "no-store" }),
      fetch("/api/status", { cache: "no-store" }),
    ]);
    catalog = await catRes.json();
    const status = await statusRes.json();

    if (!filterInitialised && catalog.productCount > 0) {
      $onlyMulti.checked = catalog.multiRetailer > 0;
      filterInitialised = true;
    }

    $summary.textContent = catalog.productCount
      ? `${catalog.productCount} productos · ${catalog.offerCount} ofertas · ${catalog.multiRetailer} comparables entre tiendas`
      : "Los scrapers todavía no han cargado datos. Esta página se actualiza sola.";

    // Estado honesto por retailer: si una tienda nos está bloqueando, se dice.
    $retailers.replaceChildren(...["falabella", "paris", "ripley"].map((r) => {
      const s = status[r];
      const chip = document.createElement("span");
      const ok = s && s.ok && s.count > 0;
      // Lo que esa tienda aporta AHORA al catálogo, venga del último scrape o de
      // uno anterior: es lo que el usuario está viendo en las tarjetas.
      const enCatalogo = offersFrom(r);

      if (ok) {
        // La procedencia se muestra, no se esconde: si una tienda se leyó a
        // través de un intermediario, quien mira el precio tiene derecho a saberlo.
        const via = s.source && s.source !== "sitio directo" ? ` · vía ${s.source}` : "";
        chip.className = "chip chip--ok";
        chip.textContent = `${label(r)}: ${s.count} productos${via}`;
      } else if (enCatalogo > 0) {
        // El scrape falló pero Redis conserva lo último bueno, y esos precios
        // están en pantalla. Decir "sin datos" sería mentir sobre lo que se ve;
        // callar que están viejos, también. Se dicen las dos cosas.
        chip.className = "chip chip--stale";
        chip.textContent = `${label(r)}: ${enCatalogo} productos guardados · sin actualizar`;
      } else {
        chip.className = "chip chip--down";
        chip.textContent = `${label(r)}: sin datos`;
      }
      if (s && s.error) chip.title = s.error;
      return chip;
    }));

    render();
  } catch (err) {
    $summary.textContent = `No se pudo contactar a la API: ${err.message}`;
  }
}

$search.addEventListener("input", render);
$onlyMulti.addEventListener("change", render);

load();
setInterval(load, 10000);
