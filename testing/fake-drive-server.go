package main

import (
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
)

const (
	defaultDriveHost = "127.0.0.1"
	defaultDrivePort = "9090"
	seedFolderID     = "shared-folder-123"
	seedFileID       = "shared-file-123"
	seedFileName     = "shared-drive-notebook.json"
	driveFolderMime  = "application/vnd.google-apps.folder"
	notebookJSONMime = "application/json"
)

type driveFile struct {
	ID            string            `json:"id"`
	Name          string            `json:"name"`
	MimeType      string            `json:"mimeType"`
	Parents       []string          `json:"parents,omitempty"`
	AppProperties map[string]string `json:"appProperties,omitempty"`
	Content       string            `json:"-"`
	Version       int               `json:"version"`
	HeadRev       string            `json:"headRevisionId"`
	MD5Checksum   string            `json:"md5Checksum,omitempty"`
}

type driveStore struct {
	mu      sync.Mutex
	files   map[string]*driveFile
	counter int
}

func newDriveStore() *driveStore {
	store := &driveStore{
		files:   map[string]*driveFile{},
		counter: 1,
	}

	store.files[seedFolderID] = &driveFile{
		ID:       seedFolderID,
		Name:     "Shared Drive Folder",
		MimeType: driveFolderMime,
		Version:  1,
		HeadRev:  "rev-1",
	}

	store.files[seedFileID] = &driveFile{
		ID:       seedFileID,
		Name:     seedFileName,
		MimeType: notebookJSONMime,
		Parents:  []string{seedFolderID},
		Content:  `{"cells":[{"refId":"cell_shared_drive","kind":"CODE","languageId":"bash","value":"echo \"shared drive\"","metadata":{"runner":"default"},"outputs":[]}],"metadata":{}}`,
		Version:  1,
		HeadRev:  "rev-1",
	}
	store.refreshChecksum(seedFileID)

	return store
}

func (s *driveStore) refreshChecksum(id string) {
	file := s.files[id]
	if file == nil {
		return
	}
	sum := md5.Sum([]byte(file.Content))
	file.MD5Checksum = hex.EncodeToString(sum[:])
	file.HeadRev = fmt.Sprintf("rev-%d", file.Version)
}

func (s *driveStore) nextIDLocked() string {
	id := fmt.Sprintf("fake-drive-%d", s.counter)
	s.counter++
	return id
}

func (s *driveStore) generateID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nextIDLocked()
}

func (s *driveStore) create(resource map[string]any) (*driveFile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := stringValue(resource["id"], "")
	if id == "" {
		id = s.nextIDLocked()
	}
	if _, exists := s.files[id]; exists {
		return nil, false
	}

	file := &driveFile{
		ID:            id,
		Name:          stringValue(resource["name"], "Untitled item"),
		MimeType:      stringValue(resource["mimeType"], notebookJSONMime),
		Parents:       stringSlice(resource["parents"]),
		AppProperties: stringMap(resource["appProperties"]),
		Version:       1,
		HeadRev:       "rev-1",
	}
	s.files[id] = file
	s.refreshChecksum(id)
	return cloneFile(file), true
}

func (s *driveStore) updateMetadata(id string, resource map[string]any, addParents, removeParents string) (*driveFile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	file := s.files[id]
	if file == nil {
		return nil, false
	}

	if name, ok := resource["name"].(string); ok && strings.TrimSpace(name) != "" {
		file.Name = strings.TrimSpace(name)
	}
	if mimeType, ok := resource["mimeType"].(string); ok && strings.TrimSpace(mimeType) != "" {
		file.MimeType = strings.TrimSpace(mimeType)
	}
	if parents, ok := resource["parents"]; ok {
		file.Parents = stringSlice(parents)
	}
	if appProperties, ok := resource["appProperties"]; ok {
		file.AppProperties = stringMap(appProperties)
	}
	if addParents != "" && !containsString(file.Parents, addParents) {
		file.Parents = append(file.Parents, addParents)
	}
	if removeParents != "" {
		file.Parents = filterStrings(file.Parents, func(value string) bool {
			return value != removeParents
		})
	}
	file.Version++
	s.refreshChecksum(id)
	return cloneFile(file), true
}

func (s *driveStore) setContentIfMatch(id, content, expectedETag string) (*driveFile, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	file := s.files[id]
	if file == nil {
		return nil, false, false
	}
	if expectedETag != "" && expectedETag != driveFileETag(file) {
		return cloneFile(file), true, false
	}
	file.Content = content
	file.Version++
	s.refreshChecksum(id)
	return cloneFile(file), true, true
}

func driveFileETag(file *driveFile) string {
	return fmt.Sprintf("\"version-%d\"", file.Version)
}

func (s *driveStore) get(id string) (*driveFile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file := s.files[id]
	if file == nil {
		return nil, false
	}
	return cloneFile(file), true
}

func (s *driveStore) list(parentID, propertyKey, propertyValue string) []*driveFile {
	s.mu.Lock()
	defer s.mu.Unlock()

	files := make([]*driveFile, 0)
	for _, file := range s.files {
		if containsString(file.Parents, parentID) &&
			(propertyKey == "" || file.AppProperties[propertyKey] == propertyValue) {
			files = append(files, cloneFile(file))
		}
	}
	return files
}

func cloneFile(file *driveFile) *driveFile {
	if file == nil {
		return nil
	}
	parents := append([]string(nil), file.Parents...)
	appProperties := make(map[string]string, len(file.AppProperties))
	for key, value := range file.AppProperties {
		appProperties[key] = value
	}
	return &driveFile{
		ID:            file.ID,
		Name:          file.Name,
		MimeType:      file.MimeType,
		Parents:       parents,
		AppProperties: appProperties,
		Content:       file.Content,
		Version:       file.Version,
		HeadRev:       file.HeadRev,
		MD5Checksum:   file.MD5Checksum,
	}
}

func stringValue(value any, fallback string) string {
	if typed, ok := value.(string); ok && strings.TrimSpace(typed) != "" {
		return strings.TrimSpace(typed)
	}
	return fallback
}

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if typed, ok := item.(string); ok && strings.TrimSpace(typed) != "" {
			out = append(out, strings.TrimSpace(typed))
		}
	}
	return out
}

func stringMap(value any) map[string]string {
	items, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(items))
	for key, value := range items {
		if typed, ok := value.(string); ok {
			out[key] = typed
		}
	}
	return out
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func filterStrings(values []string, keep func(string) bool) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if keep(value) {
			out = append(out, value)
		}
	}
	return out
}

func newDriveHandler(store *driveStore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/drive/v3/files/generateIds", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, map[string]any{"ids": []string{store.generateID()}})
	})
	mux.HandleFunc("/drive/v3/files", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		switch r.Method {
		case http.MethodGet:
			q := r.URL.Query().Get("q")
			parentID := extractParentID(q)
			propertyKey, propertyValue := extractAppProperty(q)
			files := store.list(parentID, propertyKey, propertyValue)
			writeJSON(w, map[string]any{
				"files": files,
			})
		case http.MethodPost:
			var resource map[string]any
			_ = json.NewDecoder(r.Body).Decode(&resource)
			file, created := store.create(resource)
			if !created {
				http.Error(w, "file already exists", http.StatusConflict)
				return
			}
			writeJSON(w, file)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/drive/v3/files/", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/drive/v3/files/")
		if id == "" {
			http.NotFound(w, r)
			return
		}

		switch r.Method {
		case http.MethodGet:
			file, ok := store.get(id)
			if !ok {
				http.NotFound(w, r)
				return
			}
			if r.URL.Query().Get("alt") == "media" {
				w.Header().Set("Content-Type", "application/octet-stream")
				w.Header().Set("ETag", driveFileETag(file))
				_, _ = w.Write([]byte(file.Content))
				return
			}
			w.Header().Set("ETag", driveFileETag(file))
			writeJSON(w, file)
		case http.MethodPatch:
			var resource map[string]any
			_ = json.NewDecoder(r.Body).Decode(&resource)
			file, ok := store.updateMetadata(
				id,
				resource,
				r.URL.Query().Get("addParents"),
				r.URL.Query().Get("removeParents"),
			)
			if !ok {
				http.NotFound(w, r)
				return
			}
			writeJSON(w, file)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})

	mux.HandleFunc("/upload/drive/v3/files/", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		if r.Method != http.MethodPatch {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		id := strings.TrimPrefix(r.URL.Path, "/upload/drive/v3/files/")
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "failed to read body", http.StatusBadRequest)
			return
		}
		file, ok, matched := store.setContentIfMatch(
			id,
			string(body),
			r.Header.Get("If-Match"),
		)
		if !ok {
			http.NotFound(w, r)
			return
		}
		if !matched {
			http.Error(w, "precondition failed", http.StatusPreconditionFailed)
			return
		}
		w.Header().Set("ETag", driveFileETag(file))
		writeJSON(w, file)
	})

	return mux
}

func main() {
	host := envOrDefault("CUJ_DRIVE_FAKE_HOST", defaultDriveHost)
	port := envOrDefault("CUJ_DRIVE_FAKE_PORT", defaultDrivePort)
	store := newDriveStore()
	addr := fmt.Sprintf("%s:%s", host, port)
	log.Printf("[fake-drive] listening on http://%s", addr)
	log.Printf("[fake-drive] shared folder url: https://drive.google.com/drive/folders/%s", seedFolderID)
	log.Printf("[fake-drive] shared file url: https://drive.google.com/file/d/%s/view", seedFileID)
	if err := http.ListenAndServe(addr, newDriveHandler(store)); err != nil {
		log.Fatal(err)
	}
}

func allowCORS(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, If-Match")
	w.Header().Set("Access-Control-Expose-Headers", "ETag")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

var parentQueryPattern = regexp.MustCompile(`'([^']+)' in parents`)
var appPropertyQueryPattern = regexp.MustCompile(
	`appProperties has \{ key='([^']+)' and value='([^']*)' \}`,
)

func extractParentID(query string) string {
	matches := parentQueryPattern.FindStringSubmatch(query)
	if len(matches) == 2 {
		return matches[1]
	}
	return ""
}

func extractAppProperty(query string) (string, string) {
	matches := appPropertyQueryPattern.FindStringSubmatch(query)
	if len(matches) == 3 {
		return matches[1], matches[2]
	}
	return "", ""
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
