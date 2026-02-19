package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type capturedRequest struct {
	Timestamp     string `json:"timestamp"`
	Method        string `json:"method"`
	Path          string `json:"path"`
	URL           string `json:"url"`
	Authorization string `json:"authorization,omitempty"`
	Body          string `json:"body"`
}

var (
	requestsMu sync.Mutex
	requests   []capturedRequest
)

func envOrDefault(name, defaultValue string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return defaultValue
}

func envInt(name string, defaultValue int) int {
	raw := envOrDefault(name, fmt.Sprintf("%d", defaultValue))
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return defaultValue
	}
	return parsed
}

func appendRequest(record capturedRequest) {
	requestsMu.Lock()
	defer requestsMu.Unlock()
	requests = append(requests, record)
}

func snapshotRequests() []capturedRequest {
	requestsMu.Lock()
	defer requestsMu.Unlock()
	out := make([]capturedRequest, len(requests))
	copy(out, requests)
	return out
}

func resetRequests() {
	requestsMu.Lock()
	defer requestsMu.Unlock()
	requests = nil
}

func writeSSE(w http.ResponseWriter, payload string) {
	_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
}

func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		origin = "*"
	}
	allowedHeaders := r.Header.Get("Access-Control-Request-Headers")
	if allowedHeaders == "" {
		allowedHeaders = "Authorization,Content-Type,OpenAIAccessToken,X-Requested-With,chatkit-frame-instance-id"
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin, Access-Control-Request-Headers")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", allowedHeaders)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
}

func handleChatkit(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "method_not_allowed"})
		return
	}

	body, _ := io.ReadAll(r.Body)
	_ = r.Body.Close()
	appendRequest(capturedRequest{
		Timestamp:     time.Now().UTC().Format(time.RFC3339Nano),
		Method:        r.Method,
		Path:          r.URL.Path,
		URL:           r.URL.String(),
		Authorization: r.Header.Get("Authorization"),
		Body:          string(body),
	})

	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("connection", "keep-alive")
	w.Header().Set("x-accel-buffering", "no")
	w.WriteHeader(http.StatusOK)

	events := []string{
		`{"type":"response.created","response":{"id":"resp_cuj"}}`,
		`{"type":"response.output_text.delta","delta":"Fake assistant response from CUJ server."}`,
		`{"type":"aisre.chatkit.state","item":{"state":{"threadId":"thread_cuj","previousResponseId":"resp_cuj"}}}`,
		`{"type":"response.completed","response":{"id":"resp_cuj"}}`,
	}
	for _, event := range events {
		writeSSE(w, event)
		time.Sleep(8 * time.Millisecond)
	}
}

func main() {
	host := envOrDefault("CUJ_FAKE_CHATKIT_HOST", "127.0.0.1")
	port := envInt("CUJ_FAKE_CHATKIT_PORT", 19989)
	addr := fmt.Sprintf("%s:%d", host, port)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		switch r.URL.Path {
		case "/chatkit", "/chatkit-codex":
			handleChatkit(w, r)
		case "/requests":
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(snapshotRequests())
		case "/reset":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			resetRequests()
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
		case "/healthz":
			w.Header().Set("content-type", "text/plain")
			_, _ = w.Write([]byte("ok"))
		default:
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not_found"})
		}
	})

	log.Printf("[cuj-chatkit] listening on http://%s", addr)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("chatkit server exited: %v", err)
	}
}
