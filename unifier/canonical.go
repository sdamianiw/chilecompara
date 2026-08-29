package main

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Identidad canónica de un producto, derivada del título y de los campos
// estructurados que publica cada retailer.
//
// NO hay reglas por producto en ningún punto: el vocabulario que usamos es de
// ATRIBUTOS (marcas, colores, ruido comercial), no de modelos. Un teléfono que
// nadie ha visto nunca se normaliza igual que uno conocido, siempre que su
// marca sea conocida — y si no lo es, el token de marca se extrae del título.
type Identity struct {
	Brand     string
	Model     string
	StorageGB int
	Condition string // "nuevo" | "reacondicionado"
}

// Key es la clave de agrupación. La condición entra a propósito: un
// reacondicionado y uno nuevo NO son el mismo producto, y colapsarlos produce
// un "más barato" que el cliente no puede comprar.
func (i Identity) Key() string {
	return fmt.Sprintf("%s|%s|%d|%s", i.Brand, i.Model, i.StorageGB, i.Condition)
}

// KeyNoStorage identifica el producto ignorando la capacidad. Se usa sólo para
// rescatar ofertas cuyo título no declara almacenamiento (16% del catálogo de
// Falabella: los iPhone se listan como "IPhone 17", sin GB).
func (i Identity) KeyNoStorage() string {
	return fmt.Sprintf("%s|%s|%s", i.Brand, i.Model, i.Condition)
}

// Marcas conocidas en el mercado chileno de smartphones. Es un vocabulario de
// MARCAS, no de productos: un modelo nuevo de una marca de esta lista se
// reconoce solo. Una marca desconocida cae al fallback de extracción por token.
var knownBrands = map[string]string{
	"apple": "apple", "iphone": "apple",
	"samsung": "samsung", "galaxy": "samsung",
	"xiaomi": "xiaomi", "redmi": "xiaomi", "poco": "xiaomi",
	"motorola": "motorola", "moto": "motorola",
	"honor": "honor", "huawei": "huawei",
	"oppo": "oppo", "realme": "realme", "oneplus": "oneplus",
	"vivo": "vivo", "nokia": "nokia", "zte": "zte", "tcl": "tcl",
	"google": "google", "pixel": "google",
	"infinix": "infinix", "tecno": "tecno", "alcatel": "alcatel",
	"asus": "asus", "sony": "sony", "lg": "lg", "nothing": "nothing",
}

// Ruido comercial: palabras que describen la venta, no el producto.
var noiseWords = map[string]bool{
	"celular": true, "celulares": true, "smartphone": true, "smartphones": true,
	"telefono": true, "movil": true, "liberado": true, "liberada": true,
	"desbloqueado": true, "nuevo": true, "nueva": true, "sellado": true,
	"dual": true, "sim": true, "nano": true, "esim": true, "sims": true,
	"memoria": true, "ram": true, "rom": true, "almacenamiento": true,
	"con": true, "de": true, "del": true, "la": true, "el": true, "y": true,
	"gratis": true, "regalo": true, "incluye": true, "mas": true,
	"garantia": true, "oficial": true, "tienda": true, "version": true,
	"pantalla": true, "camara": true, "bateria": true, "carga": true,
	"rapida": true, "mah": true, "mp": true, "pulgadas": true, "hz": true,
	"awesome": true, "reacondicionado": true, "reacondicionada": true,
	"refurbished": true, "seminuevo": true, "caja": true, "abierta": true,

	// Generación de red. Se descarta a sabiendas, y es una decisión con coste:
	// una tienda escribe "Redmi Note 15 Pro 5G" y otra "Redmi Note 15 Pro" para
	// el mismo teléfono, así que conservarlo parte el producto en dos tarjetas y
	// hunde la tasa de cruce, que es justo lo que el portal existe para lograr.
	// El coste conocido está en el README: un "A17 LTE" y un "A17 5G", que sí
	// son modelos distintos, colapsan en la misma tarjeta.
	"5g": true, "4g": true, "3g": true, "lte": true,

	// Ficha técnica y marketing: procesador, panel, grado del reacondicionado.
	// Una tienda escribe "Xiaomi 17 512GB" y otra "Xiaomi 17 5G 12GB RAM 512GB
	// Snapdragon 8 Elite Gen 5"; sin esto son dos tarjetas del mismo teléfono.
	"snapdragon": true, "dimensity": true, "exynos": true, "mediatek": true,
	"helio": true, "elite": true, "gen": true, "octacore": true,
	"amoled": true, "oled": true, "lcd": true, "ips": true, "hd": true,
	"flagship": true, "global": true, "internos": true, "interno": true,
	"interna": true, "kit": true, "excelente": true, "bueno": true,
	"muy": true, "estado": true, "grado": true, "libre": true,
}

// Colores, en los dos idiomas en que aparecen en los catálogos chilenos.
// Un color es una variante del mismo producto: no debe partir la clave.
var colorWords = map[string]bool{
	"negro": true, "negra": true, "blanco": true, "blanca": true,
	"azul": true, "verde": true, "rojo": true, "roja": true, "gris": true,
	"dorado": true, "dorada": true, "plateado": true, "plata": true,
	"morado": true, "violeta": true, "rosado": true, "rosa": true,
	"celeste": true, "amarillo": true, "naranja": true, "cafe": true,
	"titanio": true, "marino": true, "medianoche": true, "noche": true,
	"media": true, "grafito": true, "natural": true, "desierto": true,
	"crema": true, "lavanda": true, "menta": true, "arena": true,
	"black": true, "white": true, "blue": true, "green": true, "red": true,
	"gray": true, "grey": true, "gold": true, "silver": true, "purple": true,
	"pink": true, "midnight": true, "graphite": true, "teal": true,
	"lavender": true, "mint": true, "cream": true, "desert": true,
	"titanium": true, "sage": true, "ivory": true, "obsidian": true,
	"mocha": true, "jade": true, "sandstone": true, "cosmic": true,
	"phantom": true, "ultramarine": true, "coral": true, "lila": true,
}

var accents = strings.NewReplacer(
	"á", "a", "é", "e", "í", "i", "ó", "o", "ú", "u", "ü", "u", "ñ", "n",
	"Á", "a", "É", "e", "Í", "i", "Ó", "o", "Ú", "u", "Ü", "u", "Ñ", "n",
)

var (
	// "8+256gb" / "16+1Tb" / "12+512": capacidad doble, RAM + almacenamiento.
	// La unidad es OPCIONAL porque catálogos reales publican "POCO X7 PRO
	// 12+512" sin ella; sin este caso esos productos quedaban con 0 GB y el
	// número se colaba como token del modelo.
	reRamRom = regexp.MustCompile(`(\d+)\s*\+\s*(\d+)\s*(gb|tb|g)?\b`)
	// "256gb", "1tb", "256 gb", y "256g" sin la b (aparece en catálogos reales).
	reCap = regexp.MustCompile(`(\d+)\s*(gb|tb|g)\b`)
	// Ruido de ficha técnica: "6000mah", "50mp", "120hz", "ip65". Cada retailer
	// mete unos u otros en el título, así que dejarlos partiría el mismo
	// teléfono en tantas claves como formas de describirlo hay.
	reSpecNoise  = regexp.MustCompile(`^(\d+(mah|mp|hz|w|mm|ghz|nits|kg|g)|ip\d+)$`)
	reNonAlnum   = regexp.MustCompile(`[^a-z0-9+]+`)
	reMultiSpace = regexp.MustCompile(`\s+`)
)

// minStorageGB es el umbral por debajo del cual un "<n>g" NO es almacenamiento.
// Sin él, "5G" y "4G" (generación de red) se leen como capacidades de 5 y 4 GB:
// se destruye el token y se contamina el cálculo. No existe un smartphone con
// menos de 16 GB en catálogo hoy, así que el umbral es seguro.
const minStorageGB = 16

func toGB(value int, unit string) int {
	if unit == "tb" {
		return value * 1024
	}
	return value
}

// extractCapacities devuelve todas las capacidades del texto y el texto ya sin
// ellas, para que no contaminen los tokens del modelo.
func extractCapacities(s string) ([]int, string) {
	var caps []int

	s = reRamRom.ReplaceAllStringFunc(s, func(m string) string {
		g := reRamRom.FindStringSubmatch(m)
		ram, _ := strconv.Atoi(g[1])
		rom, _ := strconv.Atoi(g[2])
		if g[3] == "" && rom < minStorageGB*2 {
			// Sin unidad y con un segundo número pequeño no hay evidencia de que
			// sea una capacidad. Se deja el texto intacto antes que inventar.
			return m
		}
		// La unidad rige SÓLO al segundo número: "16+1Tb" son 16 GB de RAM y
		// 1 TB de almacenamiento, no 16 TB. Aplicarla a ambos daba 16384 GB.
		caps = append(caps, ram, toGB(rom, g[3]))
		return " "
	})

	s = reCap.ReplaceAllStringFunc(s, func(m string) string {
		g := reCap.FindStringSubmatch(m)
		v, _ := strconv.Atoi(g[1])
		if g[2] == "g" && v < minStorageGB {
			return m // "5g" es una red, no una capacidad: se deja en el título.
		}
		caps = append(caps, toGB(v, g[2]))
		return " "
	})

	return caps, s
}

// storageFrom elige el ALMACENAMIENTO entre las capacidades halladas.
//
// Se toma el máximo, no el primero. Los títulos reales mezclan RAM y ROM en
// cualquier orden — "8GB RAM+ 256GB Memoria" y "256GB (12GB RAM)" aparecen los
// dos en el mismo catálogo — y en un smartphone la RAM siempre es menor que el
// almacenamiento. Quedarse con el primer match devuelve 8 GB para un teléfono
// de 256 GB, que además de ser falso parte la clave en dos.
func storageFrom(caps []int) int {
	best := 0
	for _, c := range caps {
		if c > best {
			best = c
		}
	}
	return best
}

func isRefurbished(lower string) bool {
	return strings.Contains(lower, "reacondicionad") ||
		strings.Contains(lower, "refurbished") ||
		strings.Contains(lower, "seminuevo")
}

// Identify convierte (título, marca declarada) en una identidad canónica.
//
// declaredBrand es la marca estructurada del catálogo del retailer. Se prefiere
// al texto porque está presente en el 100% de los productos, mientras que el
// 27% de los títulos no contiene ningún token de marca ("Celular 15T 512GB").
func Identify(title, declaredBrand string) Identity {
	lower := strings.ToLower(accents.Replace(title))

	condition := "nuevo"
	if isRefurbished(lower) {
		condition = "reacondicionado"
	}

	caps, stripped := extractCapacities(lower)
	storage := storageFrom(caps)

	// El "+" ya cumplió su función al separar RAM de almacenamiento; dejarlo
	// aquí produce tokens como "ram+" que ninguna lista de ruido atrapa.
	cleaned := strings.ReplaceAll(stripped, "+", " ")
	cleaned = reNonAlnum.ReplaceAllString(cleaned, " ")
	cleaned = reMultiSpace.ReplaceAllString(cleaned, " ")
	tokens := strings.Fields(cleaned)

	// Marca: campo estructurado si viene; si no, primer token que sea una marca
	// conocida; si tampoco, el primer token útil del título.
	brand := ""
	if declaredBrand != "" {
		key := strings.ToLower(accents.Replace(strings.TrimSpace(declaredBrand)))
		if canonical, ok := knownBrands[key]; ok {
			brand = canonical
		} else {
			brand = key
		}
	}
	if brand == "" {
		for _, t := range tokens {
			if canonical, ok := knownBrands[t]; ok {
				brand = canonical
				break
			}
		}
	}

	var model []string
	for _, t := range tokens {
		if _, isBrandToken := knownBrands[t]; isBrandToken {
			// "galaxy", "redmi" e "iphone" son marca o submarca, no modelo.
			continue
		}
		if noiseWords[t] || colorWords[t] {
			continue
		}
		if reSpecNoise.MatchString(t) {
			continue
		}
		if len(t) == 0 {
			continue
		}
		model = append(model, t)
	}

	if brand == "" && len(model) > 0 {
		// Marca desconocida: el primer token útil hace de marca. Evita que dos
		// retailers con la misma marca nueva queden en claves distintas.
		brand = model[0]
		model = model[1:]
	}

	// Se probó descartar los números sueltos pequeños que sobreviven a una frase
	// de ficha técnica ya despalabrada ("Snapdragon 8 Elite Gen 5" deja un "8" y
	// un "5"). Se revirtió: el test de "Galaxy Z Flip 8" lo refutó — ahí el 8 ES
	// el modelo, y no hay forma barata de distinguir un número de modelo de un
	// número de chipset sin mirar la posición respecto a la palabra eliminada.
	// El coste de no hacerlo es una tarjeta duplicada; el de hacerlo, un nombre
	// de producto destruido. Queda en las limitaciones del README.

	// Orden estable: dos retailers que escriben los mismos atributos en distinto
	// orden ("Galaxy S25 Ultra" vs "S25 Ultra") deben producir la misma clave.
	sort.Strings(model)
	model = dedupe(model)

	return Identity{
		Brand:     brand,
		Model:     strings.Join(model, "-"),
		StorageGB: storage,
		Condition: condition,
	}
}

func dedupe(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := in[:0]
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}
