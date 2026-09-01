package api

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed web/index.html web/app.js web/three.module.min.js
var webFS embed.FS

// webHandler serves the embedded single-page app. Each operator tab has a real
// route so dashboards and task views can be bookmarked or opened directly.
func webHandler() http.Handler {
	sub, err := fs.Sub(webFS, "web")
	if err != nil {
		panic(err) // embedded FS is known-good at build time
	}
	files := http.FileServer(http.FS(sub))
	mux := http.NewServeMux()
	mux.Handle("/app.js", noStore(files))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		noStoreHeaders(w)
		switch r.URL.Path {
		case "/", "/dashboard", "/active-job", "/jog", "/control", "/files":
			http.ServeFileFS(w, r, sub, "index.html")
			return
		}
		files.ServeHTTP(w, r)
	})
	return mux
}

func noStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		noStoreHeaders(w)
		next.ServeHTTP(w, r)
	})
}

func noStoreHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
}
