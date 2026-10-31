package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPointerCASAndIdempotence(t *testing.T) {
	ctx := context.Background()
	bucket := t.TempDir()
	id := strings.Repeat("a", 40) + "-" + strings.Repeat("b", 64)
	digest := strings.Repeat("c", 64)
	first, err := nextPointer(nil, id, digest)
	if err != nil {
		t.Fatal(err)
	}
	if err = writeMutable(ctx, bucket, "channels/latest.json", first, "0"); err != nil {
		t.Fatal(err)
	}
	if err = writeMutable(ctx, bucket, "channels/latest.json", []byte("stale"), "0"); err == nil {
		t.Fatal("stale writer overwrote pointer")
	}
	if value, err := nextPointer(first, id, digest); err != nil || value != nil {
		t.Fatal("identical release changed generation")
	}
	if _, err := nextPointer(first, id, strings.Repeat("d", 64)); err == nil {
		t.Fatal("changed immutable digest accepted")
	}
	if _, err := nextPointer([]byte(`{"format":99}`), id, digest); err == nil {
		t.Fatal("invalid pointer accepted")
	}
}

func TestRuntimePublicationAndStablePin(t *testing.T) {
	ctx := context.Background()
	repo := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		out, err := runCmdOutput(ctx, repo, nil, "git", args...)
		if err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(string(out))
	}
	git("init", "-b", "main")
	git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-s", "--allow-empty", "-m", "initial")
	inputs := buildInputsFixture(t.TempDir())
	inputs.WebRepo = repo
	inputs.WebCommit = git("rev-parse", "HEAD")
	publish := func(follow bool) string {
		t.Helper()
		dist := desiredBuildFixture(t, inputs)
		buildID, _ := inputs.id()
		id := inputs.WebCommit + "-" + buildID
		metadata := map[string]any{"recoveredControlFormat": 1, "tabRecoveryFormat": 1, "tabAdmissionFormat": 1, "releaseId": id, "appEntry": "app.js", "styles": []string{}, "requiredCapabilities": []string{"durable-prepare-v1", "epoch-fence-v1", "owner-lock-v1"}, "owner": map[string]any{"buildId": strings.Split(id, "-")[1], "entry": "storage-owner.js", "rpcMin": 8, "rpcMax": 8}, "launcherProtocol": map[string]any{"min": 1, "max": 1}, "storageCompatibilityId": "runme-schema9-oplog2-payload1-console1"}
		receipt, _ := json.Marshal(releaseAcceptance{1, id, "controlled-releases-v1"})
		writeArchiveFixture(t, dist, "release-acceptance.json", string(receipt))
		raw, _ := json.Marshal(metadata)
		writeArchiveFixture(t, dist, "release-metadata.json", string(raw))
		for _, name := range []string{"app.js", "storage-owner.js", "launcher.html", "launcher.json", "sw.js"} {
			writeArchiveFixture(t, dist, name, "fixture "+id)
		}
		if err := runArchive(ctx, archiveConfig{dist: dist, bucket: inputs.Bucket, inputs: &inputs}, io.Discard); err != nil {
			t.Fatal(err)
		}
		if err := publishRuntime(ctx, inputs, follow, io.Discard); err != nil {
			t.Fatal(err)
		}
		return id
	}
	first := publish(true)
	manifestRaw, _, err := readObject(ctx, inputs.Bucket, "version/"+first+"/release.json")
	if err != nil || !strings.Contains(string(manifestRaw), `"recoveredControlFormat": 1`) || !strings.Contains(string(manifestRaw), `"tabRecoveryFormat": 1`) || !strings.Contains(string(manifestRaw), `"tabAdmissionFormat": 1`) {
		t.Fatal("recovery capability missing from published manifest", err)
	}
	stable, _, err := readObject(ctx, inputs.Bucket, "channels/stable.json")
	if err != nil {
		t.Fatal(err)
	}
	latest, _, _ := readObject(ctx, inputs.Bucket, "channels/latest.json")
	if string(stable) != string(latest) {
		t.Fatal("stable did not initially follow latest")
	}
	if !strings.Contains(string(stable), first) {
		t.Fatal("wrong release")
	}
	// Reconciliation does not change channel generations or immutable artifacts.
	if err = publishRuntime(ctx, inputs, true, io.Discard); err != nil {
		t.Fatal(err)
	}
	same, _, _ := readObject(ctx, inputs.Bucket, "channels/stable.json")
	if string(same) != string(stable) {
		t.Fatal("no-op changed pointer")
	}
	inputs.BuildRevision = "2"
	second := publish(false)
	pinned, _, _ := readObject(ctx, inputs.Bucket, "channels/stable.json")
	if string(pinned) != string(stable) {
		t.Fatal("stable pin advanced")
	}
	latest, _, _ = readObject(ctx, inputs.Bucket, "channels/latest.json")
	if !strings.Contains(string(latest), second) {
		t.Fatal("latest failed to advance")
	}
	launcher, _, _ := readObject(ctx, inputs.Bucket, "launcher.json")
	if !strings.Contains(string(launcher), second) {
		t.Fatal("launcher must advance independently of pinned stable")
	}
	// An older source job is allowed to leave its archive, never regress pointers.
	git("-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-s", "--allow-empty", "-m", "new source")
	before, _ := os.ReadFile(filepath.Join(inputs.Bucket, "index.html"))
	if err = publishRuntime(ctx, inputs, true, io.Discard); err == nil {
		t.Fatal("stale source promoted")
	}
	after, _ := os.ReadFile(filepath.Join(inputs.Bucket, "index.html"))
	if string(before) != string(after) {
		t.Fatal("stale job overwrote launcher")
	}
}

func TestPublicationRequiresCandidateAcceptance(t *testing.T) {
	inputs := buildInputsFixture(t.TempDir())
	dist := desiredBuildFixture(t, inputs)
	if err := runArchive(context.Background(), archiveConfig{dist: dist, bucket: inputs.Bucket, inputs: &inputs}, io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := publishRuntime(context.Background(), inputs, true, io.Discard); err == nil || !strings.Contains(err.Error(), "acceptance receipt") {
		t.Fatalf("unaccepted archive was not rejected: %v", err)
	}
	if _, err := os.Stat(filepath.Join(inputs.Bucket, "channels", "latest.json")); !os.IsNotExist(err) {
		t.Fatal("unaccepted archive changed latest")
	}
}
