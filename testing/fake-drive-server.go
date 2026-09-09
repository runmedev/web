package main

import (
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
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
	DriveID       string            `json:"driveId,omitempty"`
	OwnedByMe     bool              `json:"ownedByMe"`
	Owners        []driveUser       `json:"owners,omitempty"`
	Capabilities  driveCapabilities `json:"capabilities"`
	AppProperties map[string]string `json:"appProperties,omitempty"`
	Content       string            `json:"-"`
	Version       int               `json:"version,string"`
	HeadRev       string            `json:"headRevisionId"`
	MD5Checksum   string            `json:"md5Checksum,omitempty"`
}

type driveUser struct {
	DisplayName  string `json:"displayName,omitempty"`
	EmailAddress string `json:"emailAddress,omitempty"`
	PermissionID string `json:"permissionId,omitempty"`
	Me           bool   `json:"me,omitempty"`
}

type driveCapabilities struct {
	CanDownload bool `json:"canDownload"`
}

// driveRevision keeps media separately so historical downloads never read head.
type driveRevision struct {
	ID          string `json:"id"`
	MD5Checksum string `json:"md5Checksum"`
	KeepForever bool   `json:"keepForever"`
	Content     string `json:"-"`
}

type driveStore struct {
	revisions   map[string][]*driveRevision
	intervening map[string]string
	mu          sync.Mutex
	files       map[string]*driveFile
	counter     int
}

func newDriveStore() *driveStore {
	store := &driveStore{
		files:       map[string]*driveFile{},
		revisions:   map[string][]*driveRevision{},
		intervening: map[string]string{},
		counter:     1,
	}

	store.files[seedFolderID] = &driveFile{
		ID:           seedFolderID,
		Name:         "Shared Drive Folder",
		MimeType:     driveFolderMime,
		OwnedByMe:    false,
		Capabilities: driveCapabilities{CanDownload: true},
		Version:      1,
		HeadRev:      "rev-1",
	}

	store.files[seedFileID] = &driveFile{
		ID:           seedFileID,
		Name:         seedFileName,
		MimeType:     notebookJSONMime,
		Parents:      []string{seedFolderID},
		OwnedByMe:    false,
		Owners:       []driveUser{{DisplayName: "Acme Notebook Owner", EmailAddress: "owner@acme.example", PermissionID: "owner-acme-1"}},
		Capabilities: driveCapabilities{CanDownload: true},
		Content:      `{"cells":[{"refId":"cell_shared_drive","kind":"CODE","languageId":"bash","value":"echo \"shared drive\"","metadata":{"runner":"default"},"outputs":[]}],"metadata":{}}`,
		Version:      1,
		HeadRev:      "rev-1",
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
	if file.MimeType != driveFolderMime {
		for _, revision := range s.revisions[id] {
			if revision.ID == file.HeadRev {
				return
			}
		}
		s.revisions[id] = append(s.revisions[id], &driveRevision{ID: file.HeadRev, MD5Checksum: file.MD5Checksum, Content: file.Content})
	}
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
		OwnedByMe:     true,
		Owners:        []driveUser{{DisplayName: "Fake Drive User", EmailAddress: "viewer@acme.example", PermissionID: "viewer-acme-1", Me: true}},
		Capabilities:  driveCapabilities{CanDownload: true},
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

// Uploads deliberately ignore If-Match: tests must exercise client reconciliation.
func (s *driveStore) setContent(id, content string) (*driveFile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file := s.files[id]
	if file == nil {
		return nil, false
	}
	write := func(bytes string) {
		file.Content = bytes
		file.Version += 7 // File.version is not a content-revision counter.
		file.HeadRev = fmt.Sprintf("opaque-content-%d", file.Version)
		s.refreshChecksum(id)
	}
	if intervening, ok := s.intervening[id]; ok {
		delete(s.intervening, id)
		write(intervening)
	}
	write(content)
	return cloneFile(file), true
}

// Revision media follows the documented retained-blob download contract.
func (s *driveStore) serveRevisions(w http.ResponseWriter, r *http.Request, id, revisionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	revisions, exists := s.revisions[id]
	if !exists {
		http.NotFound(w, r)
		return
	}
	if revisionID == "" && r.Method == http.MethodGet {
		offset, _ := strconv.Atoi(r.URL.Query().Get("pageToken"))
		if offset < 0 || offset > len(revisions) {
			http.Error(w, "invalid page", 400)
			return
		}
		end := offset + 2
		if end > len(revisions) {
			end = len(revisions)
		}
		result := map[string]any{"revisions": revisions[offset:end]}
		if end < len(revisions) {
			result["nextPageToken"] = strconv.Itoa(end)
		}
		writeJSON(w, result)
		return
	}
	for _, revision := range revisions {
		if revision.ID != revisionID {
			continue
		}
		switch r.Method {
		case http.MethodPatch:
			var request struct {
				KeepForever bool `json:"keepForever"`
			}
			if json.NewDecoder(r.Body).Decode(&request) != nil || !request.KeepForever {
				http.Error(w, "only permanent retention is supported", 400)
				return
			}
			count := 0
			for _, entry := range revisions {
				if entry.KeepForever {
					count++
				}
			}
			if !revision.KeepForever && count >= 200 {
				http.Error(w, "200 retained-revision limit", 403)
				return
			}
			revision.KeepForever = true
			writeJSON(w, revision)
		case http.MethodGet:
			if r.URL.Query().Get("alt") == "media" {
				if !revision.KeepForever {
					http.Error(w, "revision must be retained", 403)
					return
				}
				_, _ = w.Write([]byte(revision.Content))
			} else {
				writeJSON(w, revision)
			}
		default:
			http.Error(w, "method not allowed", 405)
		}
		return
	}
	http.NotFound(w, r)
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
	owners := append([]driveUser(nil), file.Owners...)
	appProperties := make(map[string]string, len(file.AppProperties))
	for key, value := range file.AppProperties {
		appProperties[key] = value
	}
	return &driveFile{
		ID:            file.ID,
		Name:          file.Name,
		MimeType:      file.MimeType,
		Parents:       parents,
		DriveID:       file.DriveID,
		OwnedByMe:     file.OwnedByMe,
		Owners:        owners,
		Capabilities:  file.Capabilities,
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
	serviceAccountKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(fmt.Sprintf("generate fake service-account key: %v", err))
	}
	serviceAccountKeyBytes, err := x509.MarshalPKCS8PrivateKey(serviceAccountKey)
	if err != nil {
		panic(fmt.Sprintf("marshal fake service-account key: %v", err))
	}
	serviceAccountPEM := string(pem.EncodeToMemory(&pem.Block{
		Type:  "PRIVATE KEY",
		Bytes: serviceAccountKeyBytes,
	}))
	mux.HandleFunc("/app-config.json", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		writeJSON(w, map[string]any{
			"googleDrive": map[string]any{
				"baseUrl":  "http://127.0.0.1:9090",
				"authFlow": "service_account",
				"serviceAccount": map[string]any{
					"clientEmail": "viewer@acme.example",
					"privateKey":  serviceAccountPEM,
					"tokenUri":    "http://127.0.0.1:9090/token",
				},
			},
		})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, map[string]any{
			"access_token": "fake-drive-access-token",
			"token_type":   "Bearer",
			"expires_in":   3600,
		})
	})
	// A one-shot test fault creates B's revision immediately before A's upload.
	mux.HandleFunc("/__test/intervening-write", func(w http.ResponseWriter, r *http.Request) {
		if allowCORS(w, r) {
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", 405)
			return
		}
		var request struct {
			FileID  string `json:"fileId"`
			Content string `json:"content"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "invalid request", 400)
			return
		}
		store.mu.Lock()
		defer store.mu.Unlock()
		if store.files[request.FileID] == nil {
			http.NotFound(w, r)
			return
		}
		store.intervening[request.FileID] = request.Content
		writeJSON(w, map[string]bool{"armed": true})
	})
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
		parts := strings.Split(id, "/")
		if len(parts) >= 2 && parts[1] == "revisions" {
			revisionID := ""
			if len(parts) == 3 {
				revisionID = parts[2]
			}
			store.serveRevisions(w, r, parts[0], revisionID)
			return
		}

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
				_, _ = w.Write([]byte(file.Content))
				return
			}
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
		file, ok := store.setContent(id, string(body))
		if !ok {
			http.NotFound(w, r)
			return
		}
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
