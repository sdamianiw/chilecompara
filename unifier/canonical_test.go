package main

import "testing"

// Los casos vienen de títulos REALES medidos en el catálogo en vivo de
// Falabella el 2026-08-29, más un producto inventado que no existe en ningún
// retailer: si la lógica fuera hardcodeada por producto, ese último fallaría.
func TestIdentify(t *testing.T) {
	cases := []struct {
		name    string
		title   string
		brand   string
		want    Identity
	}{
		{
			name:  "RAM antes que ROM: gana el almacenamiento, no el primer match",
			title: "Redmi Note 15 Pro 8GB RAM+ 256GB Memoria - Midnight Black",
			brand: "XIAOMI",
			want:  Identity{Brand: "xiaomi", Model: "15-note-pro", StorageGB: 256, Condition: "nuevo"},
		},
		{
			name:  "mismo producto, título más corto y con prefijo comercial",
			title: "Celular Redmi Note 15 Pro 5G 256GB",
			brand: "XIAOMI",
			want:  Identity{Brand: "xiaomi", Model: "15-note-pro", StorageGB: 256, Condition: "nuevo"},
		},
		{
			name:  "ROM después de la RAM entre paréntesis",
			title: "Galaxy Z Flip 8 5G Nano SIM + eSIM 256GB (12GB RAM) F776B",
			brand: "SAMSUNG",
			want:  Identity{Brand: "samsung", Model: "8-f776b-flip-z", StorageGB: 256, Condition: "nuevo"},
		},
		{
			name:  "sin capacidad en el título: el 16% del catálogo",
			title: "IPhone 17 Pro",
			brand: "APPLE",
			want:  Identity{Brand: "apple", Model: "17-pro", StorageGB: 0, Condition: "nuevo"},
		},
		{
			name:  "reacondicionado NO es el mismo producto que el nuevo",
			title: "IPhone 15 Pro Max 256GB Reacondicionado",
			brand: "APPLE",
			want:  Identity{Brand: "apple", Model: "15-max-pro", StorageGB: 256, Condition: "reacondicionado"},
		},
		{
			name:  "el color no parte la clave",
			title: "Celular Galaxy A17 5G 128GB Negro",
			brand: "SAMSUNG",
			want:  Identity{Brand: "samsung", Model: "a17", StorageGB: 128, Condition: "nuevo"},
		},
		{
			name:  "marca ausente del título: la trae el campo estructurado",
			title: "Celular 15T 512GB",
			brand: "XIAOMI",
			want:  Identity{Brand: "xiaomi", Model: "15t", StorageGB: 512, Condition: "nuevo"},
		},
		{
			name:  "terabyte se normaliza a GB",
			title: "Celular Signature 16+1Tb",
			brand: "HONOR",
			want:  Identity{Brand: "honor", Model: "signature", StorageGB: 1024, Condition: "nuevo"},
		},
		{
			name:  "producto que no existe: marca conocida, modelo nunca visto",
			title: "Celular Galaxy Zeta 99 Ultra 5G 1TB Azul Marino",
			brand: "SAMSUNG",
			want:  Identity{Brand: "samsung", Model: "99-ultra-zeta", StorageGB: 1024, Condition: "nuevo"},
		},
		{
			name:  "marca desconocida: el primer token útil hace de marca",
			title: "Celular Kraken X1 256GB",
			brand: "",
			want:  Identity{Brand: "kraken", Model: "x1", StorageGB: 256, Condition: "nuevo"},
		},
		{
			name:  "acentos y ruido de ficha técnica no entran al modelo",
			title: "Celular A5 5g 8+256gb Dual Sim, Batería 6000mAh, IP65, Cámara 50MP, Smartphone",
			brand: "OPPO",
			want:  Identity{Brand: "oppo", Model: "a5", StorageGB: 256, Condition: "nuevo"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Identify(c.title, c.brand)
			if got != c.want {
				t.Errorf("Identify(%q, %q)\n  got  %+v\n  want %+v", c.title, c.brand, got, c.want)
			}
		})
	}
}

// El cruce cross-retailer es la tesis del cliente: si esto falla, el portal no
// sirve para nada. Tres tiendas nombran el mismo teléfono de tres maneras.
func TestUnifyCrossRetailer(t *testing.T) {
	offers := []Offer{
		{Retailer: "falabella", SKU: "1", Title: "Celular Galaxy S25 Ultra 256GB", Brand: "SAMSUNG", PriceCLP: 849990},
		{Retailer: "paris", SKU: "2", Title: "Samsung Galaxy S25 Ultra 256 GB Negro Titanio", Brand: "Samsung", PriceCLP: 899990},
		{Retailer: "ripley", SKU: "3", Title: "Smartphone Samsung Galaxy S25 Ultra 5G 256GB", Brand: "SAMSUNG", PriceCLP: 799990},
	}

	products := unify(offers)
	if len(products) != 1 {
		t.Fatalf("las tres tiendas describen el MISMO teléfono: se esperaba 1 producto, hay %d: %+v", len(products), products)
	}

	p := products[0]
	if p.RetailerCount < 2 {
		t.Fatalf("el mismo teléfono quedó sin unificar: %d retailers, claves %+v", p.RetailerCount, products)
	}
	if p.CheapestRetailer != "ripley" {
		t.Errorf("más barato = %q, se esperaba ripley (799990)", p.CheapestRetailer)
	}
	if p.MinPriceCLP != 799990 || p.MaxPriceCLP != 899990 {
		t.Errorf("rango de precios = %d..%d, se esperaba 799990..899990", p.MinPriceCLP, p.MaxPriceCLP)
	}
}

// Un reacondicionado más barato NO puede ganarle a un producto nuevo: es la
// forma más fácil de mostrar un "más barato" que el cliente no puede comprar.
func TestRefurbishedDoesNotUndercutNew(t *testing.T) {
	offers := []Offer{
		{Retailer: "falabella", SKU: "1", Title: "IPhone 15 Pro Max 256GB Reacondicionado", Brand: "APPLE", PriceCLP: 599990},
		{Retailer: "paris", SKU: "2", Title: "Apple iPhone 15 Pro Max 256GB", Brand: "Apple", PriceCLP: 1199990},
	}

	for _, p := range unify(offers) {
		if p.RetailerCount > 1 {
			t.Fatalf("reacondicionado y nuevo colapsaron en la misma tarjeta: %+v", p)
		}
	}
}

// Una oferta sin almacenamiento en el título se adhiere al grupo correcto sólo
// si no hay ambigüedad. Con dos capacidades candidatas debe quedarse aparte.
func TestAmbiguousStorageDoesNotMerge(t *testing.T) {
	ambiguous := []Offer{
		{Retailer: "falabella", SKU: "1", Title: "IPhone 17 Pro", Brand: "APPLE", PriceCLP: 1199990},
		{Retailer: "paris", SKU: "2", Title: "Apple iPhone 17 Pro 256GB", Brand: "Apple", PriceCLP: 1249990},
		{Retailer: "paris", SKU: "3", Title: "Apple iPhone 17 Pro 512GB", Brand: "Apple", PriceCLP: 1449990},
	}
	// La aserción original miraba productos con StorageGB == 0, y por eso NO
	// podía fallar: si la fusión errónea ocurriera, el grupo resultante tendría
	// la capacidad del destino (256), nunca 0. Un test escrito para pasar.
	// Lo correcto es exigir que la oferta sin capacidad siga SOLA en su tarjeta.
	got := unify(ambiguous)
	orphan := false
	for _, p := range got {
		if p.StorageGB == 0 && p.RetailerCount == 1 {
			orphan = true
		}
		if p.StorageGB > 0 && p.RetailerCount > 1 {
			t.Fatalf("con dos capacidades candidatas no debe fusionarse: %+v", p)
		}
	}
	if !orphan {
		t.Fatal("la oferta ambigua debía quedar en su propia tarjeta, sin capacidad")
	}

	unambiguous := []Offer{
		{Retailer: "falabella", SKU: "1", Title: "IPhone 17 Pro", Brand: "APPLE", PriceCLP: 1199990},
		{Retailer: "paris", SKU: "2", Title: "Apple iPhone 17 Pro 256GB", Brand: "Apple", PriceCLP: 1249990},
	}
	found := false
	for _, p := range unify(unambiguous) {
		if p.RetailerCount == 2 {
			found = true
		}
	}
	if !found {
		t.Error("con un único candidato, la oferta sin capacidad debía fusionarse")
	}
}

// Un accesorio suelto no compite con un smartphone, y el precio de un pack no es
// comparable con el del teléfono a secas. Ambos casos aparecieron en el catálogo
// real: un cargador de $17.990 servido como tarjeta, y un "17 Ultra + kit cámara"
// cuya tarjeta cotizaba el pack.
func TestAccessoriesAndBundlesAreExcluded(t *testing.T) {
	fuera := []string{
		"Cargador Samsung Ultra Rapido Tipo C 45W",
		"Celular 600E 8 512GB + Cargador",
		"17 Ultra 512GB + kit camara",
		"Barbie Phone + Dos carcasas + Stickers y Charms",
	}
	for _, title := range fuera {
		if !IsAccessoryOrBundle(title) {
			t.Errorf("debía excluirse y no se excluyó: %q", title)
		}
	}

	dentro := []string{
		"Celular Galaxy S25 Ultra 256GB",
		"IPhone 17 Pro Max",
		"Celular Redmi Note 15 Pro 5G 256GB",
	}
	for _, title := range dentro {
		if IsAccessoryOrBundle(title) {
			t.Errorf("es un teléfono y se excluyó: %q", title)
		}
	}
}

// El tamaño de pantalla en el título no puede partir el producto: Paris escribe
// «6.3''» y Falabella no, y esa diferencia costaba un cruce real de $130.000.
func TestScreenSizeDoesNotSplitTheProduct(t *testing.T) {
	conPantalla := Identify("Smartphone Galaxy S26 5G 256GB 6.3'' Negro", "")
	sinPantalla := Identify("Celular Galaxy S26 256GB", "SAMSUNG")
	if conPantalla.Key() != sinPantalla.Key() {
		t.Errorf("el mismo teléfono quedó en dos claves: %s vs %s", conPantalla.Key(), sinPantalla.Key())
	}
}
