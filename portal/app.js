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

function card(p) {
  const el = document.createElement("article");
  el.className = "card";

  const specs = [];
  if (p.storageGB > 0) specs.push(`${p.storageGB} GB`);
  if (p.condition === "reacondicionado") specs.push("reacondicionado");

  const rows = p.offers.map((o) => `
    <li class="row ${o.cheapest ? "row--cheapest" : ""}">
      <a class="row__retailer" href="${o.url}" target="_blank" rel="noopener">${label(o.retailer)}</a>
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

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function render() {
  const q = $search.value.trim().toLowerCase();
  const onlyMulti = $onlyMulti.checked;

  const shown = catalog.products.filter((p) => {
    if (onlyMulti && p.retailerCount < 2) return false;
    if (!q) return true;
    return `${p.displayName} ${p.brand} ${p.model}`.toLowerCase().includes(q);
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
      chip.className = `chip ${ok ? "chip--ok" : "chip--down"}`;
      chip.textContent = ok ? `${label(r)}: ${s.count} productos` : `${label(r)}: sin datos`;
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
