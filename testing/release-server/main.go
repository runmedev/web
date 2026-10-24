// Serve real emitted releases for the controlled-upgrade CUJ. This server only
// serves static build bytes and deliberately mutable channel pointers.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func main() {
	a := flag.String("a", "", "first emitted build")
	b := flag.String("b", "", "second emitted build")
	broken := flag.String("broken", "", "optional broken application release")
	brokenOwner := flag.String("broken-owner", "", "optional broken storage owner release")
	addr := flag.String("addr", "127.0.0.1:5198", "listen address")
	flag.Parse()
	type release struct {
		dir, id  string
		manifest []byte
	}
	load := func(dir string) release {
		raw, err := os.ReadFile(filepath.Join(dir, "release-metadata.json"))
		if err != nil {
			log.Fatal(err)
		}
		var m map[string]any
		if err = json.Unmarshal(raw, &m); err != nil {
			log.Fatal(err)
		}
		id := m["releaseId"].(string)
		m["format"] = 1
		m["webCommit"] = strings.Split(id, "-")[0]
		m["buildId"] = strings.Split(id, "-")[1]
		m["buildInputsDigest"] = m["buildId"]
		m["publishedAt"] = "2026-10-24T00:00:00Z"
		assets := []map[string]any{}
		err = filepath.WalkDir(dir, func(path string, e os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if e.IsDir() {
				return nil
			}
			rel, _ := filepath.Rel(dir, path)
			if rel == "release.json" {
				return nil
			}
			bytes, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(bytes)
			assets = append(assets, map[string]any{"path": filepath.ToSlash(rel), "sha256": hex.EncodeToString(sum[:]), "bytes": len(bytes), "requiredOffline": true})
			return nil
		})
		if err != nil {
			log.Fatal(err)
		}
		m["assets"] = assets
		// Match production's formatted bytes so reserializing a cached marker
		// cannot accidentally satisfy a channel's manifest digest in this CUJ.
		manifest, _ := json.MarshalIndent(m, "", "  ")
		return release{dir, id, manifest}
	}
	first, second := load(*a), load(*b)
	releases := []release{first, second}
	if *broken != "" {
		releases = append(releases, load(*broken))
	}
	var ownerFailure release
	if *brokenOwner != "" {
		ownerFailure = load(*brokenOwner)
		releases = append(releases, ownerFailure)
	}
	current := first
	var mu sync.RWMutex
	mux := http.NewServeMux()
	mux.HandleFunc("/test/releases", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]string{"a": first.id, "b": second.id})
	})
	mux.HandleFunc("/test/promote", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" {
			w.WriteHeader(405)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if r.URL.Query().Get("release") == "a" {
			current = first
		} else if r.URL.Query().Get("release") == "broken-owner" && ownerFailure.id != "" {
			current = ownerFailure
		} else if r.URL.Query().Get("release") == "broken" && len(releases) > 2 {
			current = releases[2]
		} else {
			current = second
		}
		w.WriteHeader(204)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		mu.RLock()
		selected := current
		mu.RUnlock()
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/test/legacy-page" {
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, "<!doctype html><title>Legacy Runme</title><p>Uncontrolled historical app window</p>")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/channels/") {
			sum := sha256.Sum256(selected.manifest)
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{"format": 1, "generation": 1, "releaseId": selected.id, "manifestSha256": hex.EncodeToString(sum[:])})
			return
		}
		if r.URL.Path == "/storage-owner.js" {
			w.Header().Set("Content-Type", "text/javascript")
			fmt.Fprint(w, "self.onconnect=e=>{const p=e.ports[0];p.onmessage=()=>p.postMessage('runme-legacy-owner-retired');p.start();p.postMessage('runme-legacy-owner-retired')}")
			return
		}
		for _, rel := range releases {
			prefix := "/version/" + rel.id + "/"
			if strings.HasPrefix(r.URL.Path, prefix) {
				path := strings.TrimPrefix(r.URL.Path, prefix)
				if path == "release.json" {
					w.Header().Set("Content-Type", "application/json")
					w.Write(rel.manifest)
					return
				}
				serve(w, rel.dir, path)
				return
			}
		}
		if r.URL.Path == "/sw.js" {
			serve(w, selected.dir, "sw.js")
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			http.NotFound(w, r)
			return
		}
		serve(w, selected.dir, "launcher.html")
	})
	log.Printf("Serving emitted releases on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

// Avoid platform sendfile differences in the test harness; bytes are unchanged.
func serve(w http.ResponseWriter, dir, name string) {
	if !fs.ValidPath(name) {
		http.Error(w, "Invalid asset path", 400)
		return
	}
	data, err := fs.ReadFile(os.DirFS(dir), name)
	if err != nil {
		http.Error(w, "Not found", 404)
		return
	}
	kind := mime.TypeByExtension(filepath.Ext(name))
	if kind != "" {
		w.Header().Set("Content-Type", kind)
	}
	w.Write(data)
}
