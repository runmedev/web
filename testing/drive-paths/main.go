// A read-only Drive fixture for the full-path picker CUJ. All data is synthetic.
package main

import (
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"strings"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9098", "listen address")
	flag.Parse()
	folders := []map[string]any{
		{"id": "personal-notebooks", "name": "Notebooks", "mimeType": "application/vnd.google-apps.folder", "parents": []string{"personal-projects"}},
		{"id": "team-notebooks", "name": "Notebooks", "mimeType": "application/vnd.google-apps.folder", "parents": []string{"team-projects"}, "driveId": "engineering"},
		{"id": "archive-notebooks", "name": "Notebooks", "mimeType": "application/vnd.google-apps.folder", "parents": []string{"restricted"}},
	}
	metadata := map[string]any{
		"root":              map[string]any{"id": "my-root"},
		"personal-projects": map[string]any{"id": "personal-projects", "name": "Projects", "parents": []string{"my-root"}},
		"team-projects":     map[string]any{"id": "team-projects", "name": "Runme", "parents": []string{"engineering"}, "driveId": "engineering"},
	}
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, X-Goog-Drive-Resource-Keys")
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var response any
		switch {
		case r.URL.Path == "/drive/v3/drives":
			response = map[string]any{"drives": []map[string]string{{"id": "engineering", "name": "Engineering"}}}
		case r.URL.Path == "/drive/v3/files":
			if strings.Contains(r.URL.Query().Get("q"), "name contains") {
				response = map[string]any{"files": folders}
			} else {
				response = map[string]any{"files": []any{}}
			}
		default:
			var ok bool
			response, ok = metadata[strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")]
			if !ok {
				w.WriteHeader(http.StatusNotFound)
				response = map[string]string{"error": "unavailable"}
			}
		}
		json.NewEncoder(w).Encode(response)
	})
	log.Fatal(http.ListenAndServe(*addr, nil))
}
