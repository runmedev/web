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

func TestV3RecoveryRetainsInterveningRevisionWithoutETag(t *testing.T) {
	store := newDriveStore()
	store.intervening[seedFileID] = "collaborator content"
	server := httptest.NewServer(newDriveHandler(store))
	defer server.Close()
	request, _ := http.NewRequest(http.MethodPatch, server.URL+"/upload/drive/v3/files/"+seedFileID, bytes.NewBufferString("our content"))
	request.Header.Set("If-Match", "unsupported-stale-condition")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || response.Header.Get("ETag") != "" {
		t.Fatalf("unexpected upload: %s", response.Status)
	}
	var receipt driveFile
	if err := json.NewDecoder(response.Body).Decode(&receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.HeadRev != store.files[seedFileID].HeadRev {
		t.Fatal("upload receipt did not identify own revision")
	}
	response, err = http.Get(server.URL + "/drive/v3/files/" + seedFileID + "/revisions")
	if err != nil {
		t.Fatal(err)
	}
	var page struct {
		Revisions     []driveRevision `json:"revisions"`
		NextPageToken string          `json:"nextPageToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(page.Revisions) != 2 || page.NextPageToken == "" {
		t.Fatalf("expected paginated history: %#v", page)
	}
	revisionURL := server.URL + "/drive/v3/files/" + seedFileID + "/revisions/" + page.Revisions[1].ID
	response, _ = http.Get(revisionURL + "?alt=media")
	if response.StatusCode != 403 {
		t.Fatal("unpinned download was accepted")
	}
	response.Body.Close()
	request, _ = http.NewRequest(http.MethodPatch, revisionURL, bytes.NewBufferString(`{"keepForever":true}`))
	response, _ = http.DefaultClient.Do(request)
	if response.StatusCode != 200 {
		t.Fatal("pin failed")
	}
	response.Body.Close()
	response, _ = http.Get(revisionURL + "?alt=media")
	content, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(content) != "collaborator content" {
		t.Fatalf("lost intervening revision: %q", content)
	}
	response, _ = http.Get(server.URL + "/drive/v3/files/" + seedFileID + "/revisions?pageToken=" + page.NextPageToken)
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if len(page.Revisions) != 1 || page.Revisions[0].ID != receipt.HeadRev {
		t.Fatal("second page did not contain our head")
	}
}

func TestMetadataDoesNotCreateContentRevisionAndRetentionLimit(t *testing.T) {
	store := newDriveStore()
	before, _ := store.get(seedFileID)
	after, _ := store.updateMetadata(seedFileID, map[string]any{"name": "renamed.runme"}, "", "")
	if after.HeadRev != before.HeadRev || after.Version <= before.Version {
		t.Fatal("metadata update changed content revision or failed to increment version")
	}
	for i := 0; i < 200; i++ {
		file, _ := store.setContent(seedFileID, "bytes")
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodPatch, "/", bytes.NewBufferString(`{"keepForever":true}`))
		store.serveRevisions(recorder, request, seedFileID, file.HeadRev)
		if recorder.Code != 200 {
			t.Fatalf("pin %d failed", i)
		}
	}
	file, _ := store.setContent(seedFileID, "overflow")
	recorder := httptest.NewRecorder()
	store.serveRevisions(recorder, httptest.NewRequest(http.MethodPatch, "/", bytes.NewBufferString(`{"keepForever":true}`)), seedFileID, file.HeadRev)
	if recorder.Code != 403 {
		t.Fatal("retention limit was not enforced")
	}
}
