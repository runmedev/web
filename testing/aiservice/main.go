package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
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

	codexMu                sync.Mutex
	codexBridgeMessages    []capturedCodexBridgeMessage
	codexAppServerMessages []capturedCodexAppServerMessage
	codexUpdateDone        bool
	codexTurnStarted       bool
	codexCurrentThread     *fakeCodexThread
)

type capturedCodexBridgeMessage struct {
	Timestamp string `json:"timestamp"`
	Direction string `json:"direction"`
	Type      string `json:"type,omitempty"`
	Body      string `json:"body"`
}

type capturedCodexAppServerMessage struct {
	Timestamp string `json:"timestamp"`
	Direction string `json:"direction"`
	Method    string `json:"method,omitempty"`
	Body      string `json:"body"`
}

type fakeCodexThread struct {
	ID               string                   `json:"id"`
	Title            string                   `json:"title"`
	UpdatedAt        string                   `json:"updated_at,omitempty"`
	Cwd              string                   `json:"cwd,omitempty"`
	PreviousResponse string                   `json:"previous_response_id,omitempty"`
	LastTurnID       string                   `json:"last_turn_id,omitempty"`
	Items            []map[string]any         `json:"items"`
}

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

func appendCodexBridgeMessage(direction string, messageType string, body string) {
	codexMu.Lock()
	defer codexMu.Unlock()
	codexBridgeMessages = append(codexBridgeMessages, capturedCodexBridgeMessage{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Direction: direction,
		Type:      messageType,
		Body:      body,
	})
}

func appendCodexAppServerMessage(direction string, method string, body string) {
	codexMu.Lock()
	defer codexMu.Unlock()
	codexAppServerMessages = append(codexAppServerMessages, capturedCodexAppServerMessage{
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
		Direction: direction,
		Method:    method,
		Body:      body,
	})
}

func snapshotCodexBridgeMessages() []capturedCodexBridgeMessage {
	codexMu.Lock()
	defer codexMu.Unlock()
	out := make([]capturedCodexBridgeMessage, len(codexBridgeMessages))
	copy(out, codexBridgeMessages)
	return out
}

func snapshotCodexAppServerMessages() []capturedCodexAppServerMessage {
	codexMu.Lock()
	defer codexMu.Unlock()
	out := make([]capturedCodexAppServerMessage, len(codexAppServerMessages))
	copy(out, codexAppServerMessages)
	return out
}

func resetCodexState() {
	codexMu.Lock()
	defer codexMu.Unlock()
	codexBridgeMessages = nil
	codexAppServerMessages = nil
	codexUpdateDone = false
	codexTurnStarted = false
	codexCurrentThread = nil
}

func noteCodexTurnStarted() {
	codexMu.Lock()
	codexTurnStarted = true
	codexMu.Unlock()
}

func waitForCodexTurnStarted(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		codexMu.Lock()
		started := codexTurnStarted
		codexMu.Unlock()
		if started {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
}

func noteCodexUpdateComplete() {
	codexMu.Lock()
	codexUpdateDone = true
	codexMu.Unlock()
}

func waitForCodexUpdateComplete(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		codexMu.Lock()
		done := codexUpdateDone
		codexMu.Unlock()
		if done {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return false
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

	if strings.Contains(string(body), `"type":"threads.list"`) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
		return
	}

	w.Header().Set("content-type", "text/event-stream")
	w.Header().Set("cache-control", "no-cache")
	w.Header().Set("connection", "keep-alive")
	w.Header().Set("x-accel-buffering", "no")
	w.WriteHeader(http.StatusOK)

	if r.URL.Path == "/chatkit-codex" {
		writeCodexChatkitSSE(w)
		return
	}
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

func writeCodexChatkitSSE(w http.ResponseWriter) {
	firstRespID := "resp_cuj_codex_1"
	secondRespID := "resp_cuj_codex_2"
	firstItemID := "msg_cuj_codex_1"
	secondItemID := "msg_cuj_codex_2"
	firstText := `Ok, I'll add a cell to print("hello world").`
	secondText := `Cell has been added.`
	firstEvents := []string{
		fmt.Sprintf(`{"type":"response.created","response":{"id":"%s"}}`, firstRespID),
		fmt.Sprintf(`{"type":"response.output_item.added","response_id":"%s","output_index":0,"item":{"id":"%s","type":"message","status":"in_progress","role":"assistant","content":[]}}`, firstRespID, firstItemID),
		fmt.Sprintf(`{"type":"response.content_part.added","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"part":{"type":"output_text","text":""}}`, firstRespID, firstItemID),
		fmt.Sprintf(`{"type":"response.output_text.delta","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"delta":%q}`, firstRespID, firstItemID, firstText),
		fmt.Sprintf(`{"type":"response.output_text.done","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"text":%q}`, firstRespID, firstItemID, firstText),
		fmt.Sprintf(`{"type":"response.content_part.done","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"part":{"type":"output_text","text":%q}}`, firstRespID, firstItemID, firstText),
		fmt.Sprintf(`{"type":"response.output_item.done","response_id":"%s","output_index":0,"item":{"id":"%s","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":%q}]}}`, firstRespID, firstItemID, firstText),
		fmt.Sprintf(`{"type":"aisre.chatkit.state","item":{"state":{"threadId":"thread_cuj","previousResponseId":"%s"}}}`, firstRespID),
		fmt.Sprintf(`{"type":"response.completed","response":{"id":"%s"}}`, firstRespID),
	}
	for _, event := range firstEvents {
		writeSSE(w, event)
		time.Sleep(8 * time.Millisecond)
	}
	time.Sleep(1200 * time.Millisecond)
	if !waitForCodexUpdateComplete(30 * time.Second) {
		writeSSE(w, `{"type":"response.created","response":{"id":"resp_cuj_codex_error"}}`)
		writeSSE(w, `{"type":"response.output_text.delta","delta":"Failed to add the cell in time."}`)
		writeSSE(w, `{"type":"response.completed","response":{"id":"resp_cuj_codex_error"}}`)
		return
	}
	secondEvents := []string{
		fmt.Sprintf(`{"type":"response.created","response":{"id":"%s"}}`, secondRespID),
		fmt.Sprintf(`{"type":"response.output_item.added","response_id":"%s","output_index":0,"item":{"id":"%s","type":"message","status":"in_progress","role":"assistant","content":[]}}`, secondRespID, secondItemID),
		fmt.Sprintf(`{"type":"response.content_part.added","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"part":{"type":"output_text","text":""}}`, secondRespID, secondItemID),
		fmt.Sprintf(`{"type":"response.output_text.delta","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"delta":%q}`, secondRespID, secondItemID, secondText),
		fmt.Sprintf(`{"type":"response.output_text.done","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"text":%q}`, secondRespID, secondItemID, secondText),
		fmt.Sprintf(`{"type":"response.content_part.done","response_id":"%s","output_index":0,"item_id":"%s","content_index":0,"part":{"type":"output_text","text":%q}}`, secondRespID, secondItemID, secondText),
		fmt.Sprintf(`{"type":"response.output_item.done","response_id":"%s","output_index":0,"item":{"id":"%s","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","text":%q}]}}`, secondRespID, secondItemID, secondText),
		fmt.Sprintf(`{"type":"aisre.chatkit.state","item":{"state":{"threadId":"thread_cuj","previousResponseId":"%s"}}}`, secondRespID),
		fmt.Sprintf(`{"type":"response.completed","response":{"id":"%s"}}`, secondRespID),
	}
	for _, event := range secondEvents {
		writeSSE(w, event)
		time.Sleep(8 * time.Millisecond)
	}
}

type wsConn struct {
	netConn net.Conn
	reader  *bufio.Reader
	writer  *bufio.Writer
	writeMu sync.Mutex
}

func upgradeWebSocket(w http.ResponseWriter, r *http.Request) (*wsConn, error) {
	if !headerContainsToken(r.Header, "Connection", "upgrade") ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, fmt.Errorf("missing websocket upgrade headers")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, fmt.Errorf("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, fmt.Errorf("response writer does not support hijacking")
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, fmt.Errorf("hijack failed: %w", err)
	}
	accept := websocketAccept(key)
	response := "" +
		"HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n" +
		"\r\n"
	if _, err := rw.WriteString(response); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("handshake write failed: %w", err)
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("handshake flush failed: %w", err)
	}
	return &wsConn{
		netConn: conn,
		reader:  rw.Reader,
		writer:  rw.Writer,
	}, nil
}

func headerContainsToken(h http.Header, key string, want string) bool {
	value := h.Get(key)
	if value == "" {
		return false
	}
	for _, part := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(part), want) {
			return true
		}
	}
	return false
}

func websocketAccept(key string) string {
	sum := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func (c *wsConn) Close() error {
	return c.netConn.Close()
}

func (c *wsConn) writeFrame(opcode byte, payload []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	header := []byte{0x80 | (opcode & 0x0f)}
	length := len(payload)
	switch {
	case length <= 125:
		header = append(header, byte(length))
	case length <= 65535:
		header = append(header, 126, byte(length>>8), byte(length))
	default:
		header = append(header, 127,
			byte(uint64(length)>>56),
			byte(uint64(length)>>48),
			byte(uint64(length)>>40),
			byte(uint64(length)>>32),
			byte(uint64(length)>>24),
			byte(uint64(length)>>16),
			byte(uint64(length)>>8),
			byte(uint64(length)),
		)
	}
	if _, err := c.writer.Write(header); err != nil {
		return err
	}
	if _, err := c.writer.Write(payload); err != nil {
		return err
	}
	return c.writer.Flush()
}

func (c *wsConn) WriteText(message string) error {
	return c.writeFrame(0x1, []byte(message))
}

func (c *wsConn) writeClose() error {
	return c.writeCloseWithCode(1000)
}

func (c *wsConn) writeCloseWithCode(code uint16) error {
	payload := []byte{byte(code >> 8), byte(code)}
	return c.writeFrame(0x8, payload)
}

func (c *wsConn) ReadText() (string, error) {
	for {
		opcode, payload, err := c.readFrame()
		if err != nil {
			return "", err
		}
		switch opcode {
		case 0x1:
			return string(payload), nil
		case 0x8:
			_ = c.writeClose()
			return "", io.EOF
		case 0x9:
			_ = c.writeFrame(0xA, payload)
		case 0xA:
			// Pong; ignore.
		default:
			// Ignore unsupported opcodes for this fake server.
		}
	}
}

func (c *wsConn) readFrame() (byte, []byte, error) {
	b0, err := c.reader.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	b1, err := c.reader.ReadByte()
	if err != nil {
		return 0, nil, err
	}
	masked := (b1 & 0x80) != 0
	payloadLen := uint64(b1 & 0x7f)
	switch payloadLen {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(c.reader, ext[:]); err != nil {
			return 0, nil, err
		}
		payloadLen = uint64(ext[0])<<8 | uint64(ext[1])
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(c.reader, ext[:]); err != nil {
			return 0, nil, err
		}
		payloadLen = uint64(ext[0])<<56 |
			uint64(ext[1])<<48 |
			uint64(ext[2])<<40 |
			uint64(ext[3])<<32 |
			uint64(ext[4])<<24 |
			uint64(ext[5])<<16 |
			uint64(ext[6])<<8 |
			uint64(ext[7])
	}
	if payloadLen > 10<<20 {
		return 0, nil, fmt.Errorf("payload too large: %d", payloadLen)
	}
	var maskKey [4]byte
	if masked {
		if _, err := io.ReadFull(c.reader, maskKey[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, payloadLen)
	if _, err := io.ReadFull(c.reader, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= maskKey[i%4]
		}
	}
	return b0 & 0x0f, payload, nil
}

type jsonRPCRequest struct {
	JSONRPC string         `json:"jsonrpc"`
	ID      any            `json:"id,omitempty"`
	Method  string         `json:"method"`
	Params  map[string]any `json:"params,omitempty"`
}

func fakeSeededThread() *fakeCodexThread {
	return &fakeCodexThread{
		ID:        "thread_seeded",
		Title:     "Earlier conversation",
		UpdatedAt: "2026-02-26T18:00:00Z",
		Cwd:       ".",
		Items: []map[string]any{
			{
				"id":     "seed_user",
				"type":   "message",
				"role":   "user",
				"status": "completed",
				"content": []map[string]any{
					{"type": "input_text", "text": "What changed in this notebook?"},
				},
			},
			{
				"id":     "seed_assistant",
				"type":   "message",
				"role":   "assistant",
				"status": "completed",
				"content": []map[string]any{
					{"type": "output_text", "text": "Previous assistant answer."},
				},
			},
		},
	}
}

func snapshotCurrentThread() *fakeCodexThread {
	codexMu.Lock()
	defer codexMu.Unlock()
	if codexCurrentThread == nil {
		return nil
	}
	threadCopy := *codexCurrentThread
	threadCopy.Items = append([]map[string]any(nil), codexCurrentThread.Items...)
	return &threadCopy
}

func upsertCurrentThread(thread *fakeCodexThread) {
	codexMu.Lock()
	defer codexMu.Unlock()
	codexCurrentThread = thread
}

func appendCurrentThreadItem(item map[string]any) {
	codexMu.Lock()
	defer codexMu.Unlock()
	if codexCurrentThread == nil {
		return
	}
	codexCurrentThread.Items = append(codexCurrentThread.Items, item)
	codexCurrentThread.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func completeCurrentThreadTurn(turnID string, responseID string, messages ...string) {
	codexMu.Lock()
	defer codexMu.Unlock()
	if codexCurrentThread == nil {
		return
	}
	for index, message := range messages {
		codexCurrentThread.Items = append(codexCurrentThread.Items, map[string]any{
			"id":     fmt.Sprintf("assistant_%s_%d", turnID, index+1),
			"type":   "message",
			"role":   "assistant",
			"status": "completed",
			"content": []map[string]any{
				{"type": "output_text", "text": message},
			},
		})
	}
	codexCurrentThread.PreviousResponse = responseID
	codexCurrentThread.LastTurnID = turnID
	codexCurrentThread.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func sendJSONRPCResult(ws *wsConn, id any, result any) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"result":  result,
	})
	if err != nil {
		return err
	}
	appendCodexAppServerMessage("outbound", "result", string(payload))
	return ws.WriteText(string(payload))
}

func sendJSONRPCNotification(ws *wsConn, method string, params map[string]any) error {
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"method":  method,
		"params":  params,
	})
	if err != nil {
		return err
	}
	appendCodexAppServerMessage("outbound", method, string(payload))
	return ws.WriteText(string(payload))
}

func filterThreadsForCwd(cwd string) []map[string]any {
	threads := make([]map[string]any, 0, 2)
	seeded := fakeSeededThread()
	if cwd == "" || cwd == seeded.Cwd {
		threads = append(threads, map[string]any{
			"id":                  seeded.ID,
			"title":               seeded.Title,
			"updated_at":          seeded.UpdatedAt,
			"cwd":                 seeded.Cwd,
			"previous_response_id": seeded.PreviousResponse,
			"last_turn_id":        seeded.LastTurnID,
		})
	}
	if current := snapshotCurrentThread(); current != nil {
		if cwd == "" || cwd == current.Cwd {
			threads = append(threads, map[string]any{
				"id":                  current.ID,
				"title":               current.Title,
				"updated_at":          current.UpdatedAt,
				"cwd":                 current.Cwd,
				"previous_response_id": current.PreviousResponse,
				"last_turn_id":        current.LastTurnID,
			})
		}
	}
	return threads
}

func readThread(threadID string) *fakeCodexThread {
	if threadID == "thread_seeded" {
		return fakeSeededThread()
	}
	current := snapshotCurrentThread()
	if current != nil && current.ID == threadID {
		return current
	}
	return nil
}

func handleCodexAppServerWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := upgradeWebSocket(w, r)
	if err != nil {
		log.Printf("[cuj-chatkit] /codex/app-server/ws upgrade failed: %v", err)
		http.Error(w, "websocket upgrade failed", http.StatusBadRequest)
		return
	}
	defer func() {
		_ = ws.Close()
	}()
	log.Printf("[cuj-chatkit] codex app-server websocket connected")
	appendCodexAppServerMessage("meta", "connect", `{"status":"connected"}`)

	for {
		raw, err := ws.ReadText()
		if err != nil {
			if err != io.EOF {
				appendCodexAppServerMessage("meta", "error", err.Error())
				log.Printf("[cuj-chatkit] codex app-server read error: %v", err)
			}
			return
		}
		var request jsonRPCRequest
		if err := json.Unmarshal([]byte(raw), &request); err != nil {
			appendCodexAppServerMessage("inbound", "invalid", raw)
			_ = sendJSONRPCResult(ws, nil, map[string]any{
				"error": "invalid_json",
			})
			continue
		}
		appendCodexAppServerMessage("inbound", request.Method, raw)
		switch request.Method {
		case "thread/list":
			cwd, _ := request.Params["cwd"].(string)
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"threads": filterThreadsForCwd(cwd),
			}); err != nil {
				return
			}
		case "thread/read":
			threadID, _ := request.Params["threadId"].(string)
			if threadID == "" {
				threadID, _ = request.Params["thread_id"].(string)
			}
			thread := readThread(threadID)
			if thread == nil {
				_ = sendJSONRPCResult(ws, request.ID, map[string]any{
					"thread": map[string]any{},
					"items":  []any{},
				})
				continue
			}
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"thread": map[string]any{
					"id":                   thread.ID,
					"title":                thread.Title,
					"updated_at":           thread.UpdatedAt,
					"cwd":                  thread.Cwd,
					"previous_response_id": thread.PreviousResponse,
					"last_turn_id":         thread.LastTurnID,
				},
				"items": thread.Items,
			}); err != nil {
				return
			}
		case "thread/start":
			cwd, _ := request.Params["cwd"].(string)
			thread := &fakeCodexThread{
				ID:        "thread_cuj",
				Title:     "Codex notebook edit",
				Cwd:       cwd,
				UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
				Items:     []map[string]any{},
			}
			upsertCurrentThread(thread)
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"threadId": thread.ID,
				"title":    thread.Title,
				"cwd":      thread.Cwd,
			}); err != nil {
				return
			}
		case "thread/resume":
			threadID, _ := request.Params["threadId"].(string)
			if threadID == "" {
				threadID, _ = request.Params["thread_id"].(string)
			}
			thread := readThread(threadID)
			if thread == nil {
				thread = &fakeCodexThread{
					ID:        threadID,
					Title:     "Resumed thread",
					Cwd:       ".",
					UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
					Items:     []map[string]any{},
				}
				upsertCurrentThread(thread)
			}
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"threadId": thread.ID,
				"title":    thread.Title,
				"cwd":      thread.Cwd,
			}); err != nil {
				return
			}
		case "turn/start":
			threadID, _ := request.Params["threadId"].(string)
			input, _ := request.Params["input"].(string)
			turnID := "turn_cuj_1"
			appendCurrentThreadItem(map[string]any{
				"id":     "user_turn_cuj_1",
				"type":   "message",
				"role":   "user",
				"status": "completed",
				"content": []map[string]any{
					{"type": "input_text", "text": input},
				},
			})
			noteCodexTurnStarted()
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"turnId": turnID,
			}); err != nil {
				return
			}
			go func() {
				firstResponseID := "resp_cuj_codex_1"
				firstItemID := "item_cuj_codex_1"
				finalResponseID := "resp_cuj_codex_2"
				finalItemID := "item_cuj_codex_2"
				firstText := `Ok, I'll add a cell to print("hello world").`
				finalText := "Cell has been added."
				time.Sleep(200 * time.Millisecond)
				_ = sendJSONRPCNotification(ws, "turn.message.started", map[string]any{
					"threadId":   threadID,
					"turnId":     turnID,
					"responseId": firstResponseID,
					"itemId":     firstItemID,
				})
				_ = sendJSONRPCNotification(ws, "turn.output_text.delta", map[string]any{
					"threadId":   threadID,
					"turnId":     turnID,
					"responseId": firstResponseID,
					"itemId":     firstItemID,
					"delta":      firstText,
				})
				_ = sendJSONRPCNotification(ws, "turn.output_text.done", map[string]any{
					"threadId":   threadID,
					"turnId":     turnID,
					"responseId": firstResponseID,
					"itemId":     firstItemID,
					"text":       firstText,
				})
				if !waitForCodexUpdateComplete(30 * time.Second) {
					_ = sendJSONRPCNotification(ws, "turn.completed", map[string]any{
						"threadId": threadID,
						"turnId":   turnID,
					})
					return
				}
				_ = sendJSONRPCNotification(ws, "turn.message.started", map[string]any{
					"threadId":   threadID,
					"turnId":     turnID,
					"responseId": finalResponseID,
					"itemId":     finalItemID,
				})
				_ = sendJSONRPCNotification(ws, "turn.output_text.delta", map[string]any{
					"threadId":   threadID,
					"turnId":     turnID,
					"responseId": finalResponseID,
					"itemId":     finalItemID,
					"delta":      finalText,
				})
				_ = sendJSONRPCNotification(ws, "turn.output_text.done", map[string]any{
					"threadId":   threadID,
					"turnId":     turnID,
					"responseId": finalResponseID,
					"itemId":     finalItemID,
					"text":       finalText,
				})
				completeCurrentThreadTurn(turnID, finalResponseID, firstText, finalText)
				_ = sendJSONRPCNotification(ws, "turn.completed", map[string]any{
					"threadId": threadID,
					"turnId":   turnID,
				})
			}()
		case "turn/interrupt":
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"ok": true,
			}); err != nil {
				return
			}
		default:
			if err := sendJSONRPCResult(ws, request.ID, map[string]any{
				"ok": true,
			}); err != nil {
				return
			}
		}
	}
}

func handleCodexWebSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := upgradeWebSocket(w, r)
	if err != nil {
		log.Printf("[cuj-chatkit] /codex/ws upgrade failed: %v", err)
		http.Error(w, "websocket upgrade failed", http.StatusBadRequest)
		return
	}
	defer func() {
		_ = ws.Close()
	}()
	log.Printf("[cuj-chatkit] codex websocket connected")
	appendCodexBridgeMessage("meta", "connect", `{"status":"connected"}`)
	authMessage, err := ws.ReadText()
	if err != nil {
		appendCodexBridgeMessage("meta", "error", "missing auth envelope: "+err.Error())
		log.Printf("[cuj-chatkit] codex websocket auth read error: %v", err)
		return
	}
	appendCodexBridgeMessage("inbound", "auth", authMessage)

	if err := runCodexScript(ws); err != nil {
		appendCodexBridgeMessage("meta", "error", err.Error())
		log.Printf("[cuj-chatkit] codex websocket script error: %v", err)
		return
	}
	appendCodexBridgeMessage("meta", "done", `{"status":"ok"}`)
	_ = ws.writeCloseWithCode(1000)
	time.Sleep(10 * time.Millisecond)
}

func runCodexScript(ws *wsConn) error {
	if !waitForCodexTurnStarted(30 * time.Second) {
		return fmt.Errorf("timed out waiting for codex turn/start request")
	}
	if err := sendCodexToolRequest(ws, "bridge_list", map[string]any{
		"callId":             "call_list",
		"previousResponseId": "resp_cuj",
		"listCells":          map[string]any{},
	}); err != nil {
		return err
	}
	listRespRaw, err := ws.ReadText()
	if err != nil {
		return fmt.Errorf("read listCells response: %w", err)
	}
	appendCodexBridgeMessage("inbound", "NotebookToolCallResponse", listRespRaw)
	targetCell, err := buildAddedCellFromListResponse(listRespRaw)
	if err != nil {
		return err
	}

	if err := sendCodexToolRequest(ws, "bridge_update", map[string]any{
		"callId":             "call_update",
		"previousResponseId": "resp_cuj",
		"updateCells": map[string]any{
			"cells": []any{targetCell},
		},
	}); err != nil {
		return err
	}
	updateRespRaw, err := ws.ReadText()
	if err != nil {
		return fmt.Errorf("read updateCells response: %w", err)
	}
	appendCodexBridgeMessage("inbound", "NotebookToolCallResponse", updateRespRaw)
	noteCodexUpdateComplete()
	return nil
}

func sendCodexToolRequest(ws *wsConn, bridgeCallID string, toolCallInput map[string]any) error {
	envelope := map[string]any{
		"type":            "NotebookToolCallRequest",
		"bridge_call_id":  bridgeCallID,
		"tool_call_input": toolCallInput,
	}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return fmt.Errorf("marshal codex request: %w", err)
	}
	appendCodexBridgeMessage("outbound", "NotebookToolCallRequest", string(payload))
	return ws.WriteText(string(payload))
}

func buildAddedCellFromListResponse(raw string) (map[string]any, error) {
	var envelope map[string]any
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return nil, fmt.Errorf("unmarshal listCells response envelope: %w", err)
	}
	output := mapField(envelope, "tool_call_output", "toolCallOutput")
	if output == nil {
		return nil, fmt.Errorf("listCells response missing tool_call_output")
	}
	listCells := mapField(output, "listCells", "list_cells")
	if listCells == nil {
		return nil, fmt.Errorf("listCells response missing listCells payload")
	}
	cellsAny, ok := listCells["cells"].([]any)
	if !ok || len(cellsAny) == 0 {
		return nil, fmt.Errorf("listCells response missing cells")
	}
	for _, item := range cellsAny {
		cell, ok := item.(map[string]any)
		if !ok {
			continue
		}
		refID, _ := cell["refId"].(string)
		if refID == "" {
			if alt, _ := cell["ref_id"].(string); alt != "" {
				refID = alt
			}
		}
		if refID == "" {
			continue
		}
		added := deepCopyMap(cell)
		added["refId"] = "cell_ai_codex_added"
		added["value"] = `print("hello world")`
		added["languageId"] = "python"
		added["outputs"] = []any{}
		if _, ok := added["kind"]; !ok {
			added["kind"] = float64(2)
		}
		metadata := mapField(added, "metadata")
		if metadata == nil {
			metadata = map[string]any{}
			added["metadata"] = metadata
		}
		metadata["runner"] = "local"
		return added, nil
	}
	return nil, fmt.Errorf("could not find cell with refId in listCells response")
}

func mapField(m map[string]any, keys ...string) map[string]any {
	for _, key := range keys {
		value, ok := m[key]
		if !ok {
			continue
		}
		if typed, ok := value.(map[string]any); ok {
			return typed
		}
	}
	return nil
}

func deepCopyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = deepCopyValue(v)
	}
	return out
}

func deepCopyValue(v any) any {
	switch typed := v.(type) {
	case map[string]any:
		return deepCopyMap(typed)
	case []any:
		out := make([]any, len(typed))
		for i := range typed {
			out[i] = deepCopyValue(typed[i])
		}
		return out
	default:
		return typed
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
		case "/codex/app-server/ws":
			handleCodexAppServerWebSocket(w, r)
		case "/codex/ws":
			handleCodexWebSocket(w, r)
		case "/requests":
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(snapshotRequests())
		case "/codex/requests":
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(snapshotCodexBridgeMessages())
		case "/codex/app-server/requests":
			if r.Method != http.MethodGet {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(snapshotCodexAppServerMessages())
		case "/reset":
			if r.Method != http.MethodPost {
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			resetRequests()
			resetCodexState()
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
