package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestGeneratedIDCreateAndOperationSearch(t *testing.T) {
	server := httptest.NewServer(newDriveHandler(newDriveStore()))
	defer server.Close()

	response, err := http.Get(server.URL + "/drive/v3/files/generateIds?count=1&space=drive&type=files")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var generated struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(response.Body).Decode(&generated); err != nil {
		t.Fatal(err)
	}
	if len(generated.IDs) != 1 || generated.IDs[0] == "" {
		t.Fatalf("expected one generated id, got %#v", generated.IDs)
	}

	resource := map[string]any{
		"id":       generated.IDs[0],
		"name":     "direct.json",
		"mimeType": notebookJSONMime,
		"parents":  []string{seedFolderID},
		"appProperties": map[string]string{
			"runmeCreateOperationId": "operation-1",
		},
	}
	body, err := json.Marshal(resource)
	if err != nil {
		t.Fatal(err)
	}
	response, err = http.Post(
		server.URL+"/drive/v3/files",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("create returned %s", response.Status)
	}

	query := "'" + seedFolderID + "' in parents and trashed = false and " +
		"appProperties has { key='runmeCreateOperationId' and value='operation-1' }"
	response, err = http.Get(server.URL + "/drive/v3/files?q=" + url.QueryEscape(query))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var listed struct {
		Files []driveFile `json:"files"`
	}
	if err := json.NewDecoder(response.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Files) != 1 || listed.Files[0].ID != generated.IDs[0] {
		t.Fatalf("operation search returned %#v", listed.Files)
	}
}

func TestConditionalContentUploadUsesVersionedETag(t *testing.T) {
	server := httptest.NewServer(newDriveHandler(newDriveStore()))
	defer server.Close()

	response, err := http.Get(server.URL + "/drive/v3/files/" + seedFileID)
	if err != nil {
		t.Fatal(err)
	}
	etag := response.Header.Get("ETag")
	response.Body.Close()
	if etag == "" {
		t.Fatal("metadata response did not expose an ETag")
	}

	request, err := http.NewRequest(
		http.MethodPatch,
		server.URL+"/upload/drive/v3/files/"+seedFileID+"?uploadType=media",
		bytes.NewBufferString("updated content"),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-Match", "\"stale-version\"")
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusPreconditionFailed {
		t.Fatalf("stale upload returned %s", response.Status)
	}

	request, err = http.NewRequest(
		http.MethodPatch,
		server.URL+"/upload/drive/v3/files/"+seedFileID+"?uploadType=media",
		bytes.NewBufferString("updated content"),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("If-Match", etag)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("matching upload returned %s", response.Status)
	}
	if response.Header.Get("ETag") == etag {
		t.Fatal("successful upload did not advance the ETag")
	}

	response, err = http.Get(
		server.URL + "/drive/v3/files/" + seedFileID + "?alt=media",
	)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "updated content" {
		t.Fatalf("unexpected stored content %q", content)
	}
}
