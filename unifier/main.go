package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

// Offer es lo que escribe cada scraper. Espejo de scrapers/src/types.ts.
type Offer struct {
	Retailer  string `json:"retailer"`
	SKU       string `json:"sku"`
	Title     string `json:"title"`
	Brand     string `json:"brand,omitempty"`
	PriceCLP  int    `json:"priceCLP"`
	URL       string `json:"url"`
	ScrapedAt string `json:"scrapedAt"`
}

// RetailerOffer es una fila de la tarjeta: lo que UNA tienda cobra.
type RetailerOffer struct {
	Retailer string `json:"retailer"`
	Title    string `json:"title"`
	PriceCLP int    `json:"priceCLP"`
	URL      string `json:"url"`
	Cheapest bool   `json:"cheapest"`
}

// Product es una tarjeta del portal: un producto canónico con todas sus ofertas.
type Product struct {
	Key              string          `json:"key"`
	Brand            string          `json:"brand"`
	Model            string          `json:"model"`
	StorageGB        int             `json:"storageGB"`
	Condition        string          `json:"condition"`
	DisplayName      string          `json:"displayName"`
	Offers           []RetailerOffer `json:"offers"`
	RetailerCount    int             `json:"retailerCount"`
	MinPriceCLP      int             `json:"minPriceCLP"`
	MaxPriceCLP      int             `json:"maxPriceCLP"`
	SavingsCLP       int             `json:"savingsCLP"`
	CheapestRetailer string          `json:"cheapestRetailer"`
}

type Catalog struct {
	UpdatedAt     string    `json:"updatedAt"`
	ProductCount  int       `json:"productCount"`
	OfferCount    int       `json:"offerCount"`
	MultiRetailer int       `json:"multiRetailer"`
	Products      []Product `json:"products"`
}

type group struct {
	id     Identity
	offers []Offer
}

func main() {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		url = "redis://redis:6379"
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		log.Fatalf("REDIS_URL inválida: %v", err)
	}
	rdb := redis.NewClient(opt)
	ctx := context.Background()

	log.Println("[unifier] arriba; esperando eventos de los scrapers")

	// Primera pasada inmediata: si Redis ya trae ofertas de una corrida previa
	// (el volumen es persistente), el portal no arranca vacío.
	rebuild(ctx, rdb)

	for {
		// BRPOP también hace de reloj: si nadie publica, reconstruye igual cada
		// 5 s. Un scraper que muere no deja el catálogo congelado.
		if _, err := rdb.BRPop(ctx, 5*time.Second, "events").Result(); err != nil && err != redis.Nil {
			log.Printf("[unifier] BRPOP: %v", err)
			time.Sleep(2 * time.Second)
			continue
		}
		rebuild(ctx, rdb)
	}
}

// rebuild recalcula el catálogo COMPLETO desde las ofertas crudas.
//
// Es O(n) sobre unos cientos de filas, así que reconstruir entero cuesta lo
// mismo que actualizar incremental — y elimina la clase entera de bugs de
// estado parcial (una oferta retirada que sobrevive, un precio viejo que gana).
func rebuild(ctx context.Context, rdb *redis.Client) {
	raw, err := rdb.HGetAll(ctx, "offers").Result()
	if err != nil {
		log.Printf("[unifier] HGETALL offers: %v", err)
		return
	}

	offers := make([]Offer, 0, len(raw))
	for _, v := range raw {
		var o Offer
		if err := json.Unmarshal([]byte(v), &o); err != nil {
			log.Printf("[unifier] oferta ilegible, se descarta: %v", err)
			continue
		}
		if o.PriceCLP <= 0 || o.Title == "" {
			// Precio cero o negativo no es una ganga, es un dato roto.
			continue
		}
		if IsAccessoryOrBundle(o.Title) {
			// Un cargador de $17.990 no compite con un smartphone, y el precio de
			// un pack ("+ kit cámara") no es comparable con el del teléfono solo.
			continue
		}
		offers = append(offers, o)
	}

	products := unify(offers)

	multi := 0
	for _, p := range products {
		if p.RetailerCount > 1 {
			multi++
		}
	}

	cat := Catalog{
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		ProductCount:  len(products),
		OfferCount:    len(offers),
		MultiRetailer: multi,
		Products:      products,
	}

	blob, err := json.Marshal(cat)
	if err != nil {
		log.Printf("[unifier] marshal catálogo: %v", err)
		return
	}
	if err := rdb.Set(ctx, "catalog", blob, 0).Err(); err != nil {
		log.Printf("[unifier] SET catalog: %v", err)
		return
	}

	log.Printf("[unifier] catálogo: %d ofertas -> %d productos (%d en más de un retailer)",
		len(offers), len(products), multi)
}

// unify agrupa ofertas en productos canónicos.
//
// Dos niveles, por diseño y no como rescate: el 16% de los títulos no declara
// almacenamiento (los iPhone de Falabella se listan como "IPhone 17" a secas).
// Si esas ofertas sólo se agruparan por la clave completa, jamás cruzarían con
// un retailer que sí escribe "256GB" — y son justamente los productos estrella.
func unify(offers []Offer) []Product {
	byKey := map[string]*group{}
	var order []string

	for _, o := range offers {
		id := Identify(o.Title, o.Brand)
		k := id.Key()
		g, ok := byKey[k]
		if !ok {
			g = &group{id: id}
			byKey[k] = g
			order = append(order, k)
		}
		g.offers = append(g.offers, o)
	}

	// Segundo nivel: las ofertas sin almacenamiento se adhieren al grupo que
	// comparte marca, modelo y condición — pero SÓLO si hay exactamente uno.
	// Con dos candidatos (256 GB y 512 GB) la oferta es genuinamente ambigua, y
	// mostrar dos tarjetas separadas es honesto; fusionar al azar inventaría un
	// "más barato" falso, que es el error más caro de esta pantalla.
	candidates := map[string][]string{}
	for _, k := range order {
		g := byKey[k]
		if g.id.StorageGB > 0 {
			nk := g.id.KeyNoStorage()
			candidates[nk] = append(candidates[nk], k)
		}
	}

	merged := map[string]bool{}
	for _, k := range order {
		g := byKey[k]
		if g.id.StorageGB != 0 {
			continue
		}
		targets := candidates[g.id.KeyNoStorage()]
		if len(targets) != 1 {
			continue
		}
		target := byKey[targets[0]]
		target.offers = append(target.offers, g.offers...)
		merged[k] = true
	}

	products := make([]Product, 0, len(order))
	for _, k := range order {
		if merged[k] {
			continue
		}
		products = append(products, buildProduct(byKey[k]))
	}

	// El valor para el usuario está en los productos que SÍ se pueden comparar:
	// van primero, y dentro de ellos, los de mayor ahorro.
	sort.SliceStable(products, func(a, b int) bool {
		if products[a].RetailerCount != products[b].RetailerCount {
			return products[a].RetailerCount > products[b].RetailerCount
		}
		if products[a].SavingsCLP != products[b].SavingsCLP {
			return products[a].SavingsCLP > products[b].SavingsCLP
		}
		return products[a].DisplayName < products[b].DisplayName
	})

	return products
}

func buildProduct(g *group) Product {
	// Una tienda puede listar el mismo producto canónico varias veces (colores,
	// vendedores distintos). Para comparar entre retailers sólo cuenta su oferta
	// más barata: es la que el usuario pagaría en esa tienda.
	best := map[string]Offer{}
	for _, o := range g.offers {
		cur, ok := best[o.Retailer]
		if !ok || o.PriceCLP < cur.PriceCLP {
			best[o.Retailer] = o
		}
	}

	rows := make([]RetailerOffer, 0, len(best))

	// El mínimo se inicializa con la PRIMERA oferta, no con 0 usado de centinela.
	// Con el centinela, un precio 0 que se colara dejaría `minPrice` clavado en 0
	// para siempre: el ahorro se inflaría hasta el precio máximo y el badge "más
	// barato" se lo llevaría el dato basura. Hoy `rebuild` filtra los precios <= 0,
	// pero la corrección de esta pantalla no debe depender de un filtro remoto.
	minPrice, maxPrice := 0, 0
	first := true
	for _, o := range best {
		rows = append(rows, RetailerOffer{
			Retailer: o.Retailer,
			Title:    o.Title,
			PriceCLP: o.PriceCLP,
			URL:      o.URL,
		})
		if first || o.PriceCLP < minPrice {
			minPrice = o.PriceCLP
		}
		if first || o.PriceCLP > maxPrice {
			maxPrice = o.PriceCLP
		}
		first = false
	}

	sort.Slice(rows, func(a, b int) bool { return rows[a].PriceCLP < rows[b].PriceCLP })
	if len(rows) > 0 {
		rows[0].Cheapest = true
	}

	cheapest := ""
	if len(rows) > 0 {
		cheapest = rows[0].Retailer
	}

	return Product{
		Key:              g.id.Key(),
		Brand:            g.id.Brand,
		Model:            g.id.Model,
		StorageGB:        g.id.StorageGB,
		Condition:        g.id.Condition,
		DisplayName:      displayName(g),
		Offers:           rows,
		RetailerCount:    len(rows),
		MinPriceCLP:      minPrice,
		MaxPriceCLP:      maxPrice,
		SavingsCLP:       maxPrice - minPrice,
		CheapestRetailer: cheapest,
	}
}

// displayName usa el título real más corto del grupo. Es el que menos ruido
// comercial arrastra, y deja la tarjeta legible sin inventar un nombre.
func displayName(g *group) string {
	name := ""
	for _, o := range g.offers {
		if name == "" || len(o.Title) < len(name) {
			name = o.Title
		}
	}
	return name
}
