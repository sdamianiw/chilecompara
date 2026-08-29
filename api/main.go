package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

var (
	rdb *redis.Client
	ctx = context.Background()
)

func main() {
	url := os.Getenv("REDIS_URL")
	if url == "" {
		url = "redis://redis:6379"
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		log.Fatalf("REDIS_URL inválida: %v", err)
	}
	rdb = redis.NewClient(opt)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/api/products", handleProducts)
	http.HandleFunc("/api/status", handleStatus)
	http.HandleFunc("/api/health", handleHealth)

	srv := &http.Server{
		Addr:         ":" + port,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 20 * time.Second,
	}
	log.Printf("[api] escuchando en :%s", port)
	log.Fatal(srv.ListenAndServe())
}

// handleProducts sirve el catálogo ya unificado. La API no unifica nada: leer y
// calcular son responsabilidades distintas y viven en contenedores distintos.
func handleProducts(w http.ResponseWriter, r *http.Request) {
	blob, err := rdb.Get(ctx, "catalog").Result()
	if err == redis.Nil {
		// Todavía no hay catálogo: es un estado normal durante los primeros
		// segundos, no un error. El portal muestra "cargando", no una pantalla rota.
		writeJSON(w, http.StatusOK, map[string]any{
			"updatedAt": nil, "productCount": 0, "offerCount": 0,
			"multiRetailer": 0, "products": []any{},
		})
		return
	}
	if err != nil {
		log.Printf("[api] GET catalog: %v", err)
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "redis no disponible"})
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(blob))
}

// handleStatus expone qué scraper respondió y cuál no. Un retailer bloqueado es
// información que el usuario merece ver, no algo que se esconde.
func handleStatus(w http.ResponseWriter, r *http.Request) {
	raw, err := rdb.HGetAll(ctx, "scrape:status").Result()
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "redis no disponible"})
		return
	}
	out := make(map[string]json.RawMessage, len(raw))
	for k, v := range raw {
		out[k] = json.RawMessage(v)
	}
	writeJSON(w, http.StatusOK, out)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	if err := rdb.Ping(ctx).Err(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "sin redis"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}
