// Local Agents API fixture for the agent-monitor and message composer CUJ.
// Run: go run testing/fake-agents-server.go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

var demoMu sync.Mutex
var demoMessages = map[int]map[string]any{}
var demoSubmissions = map[string]string{}

// acceptDemoMessage persists synthetic user/reply items and deduplicates retries.
func acceptDemoMessage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Events []struct {
			Type  string `json:"type"`
			Input []struct {
				Role    string `json:"role"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"input"`
		} `json:"events"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body) != nil || len(body.Events) != 1 || body.Events[0].Type != "agent.session.input.message" || len(body.Events[0].Input) != 1 || len(body.Events[0].Input[0].Content) != 1 {
		http.Error(w, "Invalid input event", http.StatusBadRequest)
		return
	}
	text := body.Events[0].Input[0].Content[0].Text
	key := r.Header.Get("Idempotency-Key")
	if key == "" || strings.TrimSpace(text) == "" {
		http.Error(w, "Message and key required", http.StatusBadRequest)
		return
	}
	demoMu.Lock()
	defer demoMu.Unlock()
	if previous, exists := demoSubmissions[key]; exists {
		if previous != text {
			http.Error(w, "Idempotency conflict", http.StatusConflict)
			return
		}
	} else {
		demoSubmissions[key] = text
		for _, message := range []struct{ role, text string }{{"user", text}, {"assistant", "Received your message: " + text}} {
			id := 126 + len(demoMessages)
			contentType := "output_text"
			if message.role == "user" {
				contentType = "input_text"
			}
			demoMessages[id] = map[string]any{"id": fmt.Sprintf("msg_%d", id), "type": "message", "role": message.role, "status": "completed", "content": []map[string]any{{"type": contentType, "text": message.text}}}
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// main serves synthetic history and an SSE stream on loopback only.
func main() {
	http.HandleFunc("/v1/agents/sessions/sess_demo", serveAgentDemo)
	http.HandleFunc("/v1/agents/sessions/sess_demo/", serveAgentDemo)
	log.Fatal(http.ListenAndServe("127.0.0.1:8989", nil))
}

func serveAgentDemo(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "http://127.0.0.1:5173" || origin == "http://localhost:5173" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "OpenAI-Beta, Content-Type, Idempotency-Key")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	}
	if r.Method == "OPTIONS" {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/events") {
		acceptDemoMessage(w, r)
		return
	}
	if r.Method != "GET" {
		http.Error(w, "Read only", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.HasSuffix(r.URL.Path, "/events"):
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, ": connected\n\n")
		w.(http.Flusher).Flush()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		index := 0
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				index++
				payload, _ := json.Marshal(map[string]any{"type": "agent.session.turn.output_text.done", "event_id": fmt.Sprintf("event_%d", index), "session_id": "sess_demo", "turn_id": "turn_live", "item_id": "msg_live", "output_index": 0, "content_index": 0, "text": fmt.Sprintf("**Live update %d.** The monitor is receiving events.\n\n```sh\ngo test ./...\n```", index)})
				fmt.Fprintf(w, "data: %s\n\n", payload)
				w.(http.Flusher).Flush()
			}
		}
	case strings.HasSuffix(r.URL.Path, "/items"):
		demoMu.Lock()
		defer demoMu.Unlock()
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		if limit < 1 || limit > 100 {
			limit = 50
		}
		start := 125 + len(demoMessages)
		if after := r.URL.Query().Get("after"); after != "" {
			if after == "msg_live" {
				start = 125
			} else {
				value, _ := strconv.Atoi(strings.TrimPrefix(after, "msg_"))
				start = value - 1
			}
		}
		data := []map[string]any{}
		for i := start; i > 0 && len(data) < limit; i-- {
			if saved, ok := demoMessages[i]; ok {
				data = append(data, saved)
				continue
			}
			text := fmt.Sprintf("Saved message **%d**.\n\n| Check | Result |\n|---|---|\n| API request | Passed |", i)
			row := map[string]any{"id": fmt.Sprintf("msg_%d", i), "type": "message", "role": "assistant", "phase": "final_answer", "status": "completed", "content": []map[string]any{{"type": "output_text", "text": text}}}
			if i%5 == 0 {
				row = map[string]any{"id": fmt.Sprintf("msg_%d", i), "type": "shell_call", "status": "completed", "command": "go test ./...", "output": "PASS"}
			}
			data = append(data, row)
		}
		var last any = nil
		if len(data) > 0 {
			last = data[len(data)-1]["id"]
		}
		json.NewEncoder(w).Encode(map[string]any{"data": data, "has_more": start-len(data) > 0, "last_id": last})
	case strings.HasSuffix(r.URL.Path, "/turns"):
		json.NewEncoder(w).Encode(map[string]any{"data": []map[string]any{{"id": "turn_live", "subagent_id": nil, "status": "in_progress", "created_at": 1}}, "has_more": false, "last_id": "turn_live"})
	default:
		json.NewEncoder(w).Encode(map[string]any{"id": "sess_demo", "status": "in_progress", "required_actions": []any{}})
	}
}
