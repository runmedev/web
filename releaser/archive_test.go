package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const archiveTestCommit = "0123456789012345678901234567890123456789"

func archiveFixture(t *testing.T) string {
	t.Helper()
	dist := t.TempDir()
	writeArchiveFixture(t, dist, "index.html", "<script src='/app.js'></script>")
	writeArchiveFixture(t, dist, "app.js", "console.log('A')")
	writeArchiveFixture(t, dist, "assets/lazy.js", "export default 'lazy'")
	writeArchiveFixture(t, dist, "version.yaml", "webCommit: "+archiveTestCommit+"\nbuildDate: 2026-10-24T00:00:00Z\n")
	return dist
}

func writeArchiveFixture(t *testing.T, root, name, value string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readArchive(t *testing.T, bucket string) (releaseArchive, string) {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(bucket, "version", "*", archiveManifestName))
	if err != nil || len(matches) != 1 {
		t.Fatalf("expected one completed archive, got %v (%v)", matches, err)
	}
	data, err := os.ReadFile(matches[0])
	if err != nil {
		t.Fatal(err)
	}
	var manifest releaseArchive
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest, filepath.Dir(matches[0])
}

func TestArchiveCommandPreservesRootAndIsRepeatable(t *testing.T) {
	dist, bucket := archiveFixture(t), t.TempDir()
	writeArchiveFixture(t, bucket, "index.html", "current production app")
	writeArchiveFixture(t, bucket, "channels/stable.json", "existing stable pointer")
	writeArchiveFixture(t, bucket, "channels/latest.json", "existing latest pointer")
	var output bytes.Buffer
	cmd := newRootCmd()
	cmd.SetOut(&output)
	// The new subcommand requires neither --web nor a production destination.
	cmd.SetArgs([]string{"archive", "--dist", dist, "--bucket", bucket})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	manifest, directory := readArchive(t, bucket)
	if manifest.Kind != "runme-build-archive" || manifest.Format != 1 || manifest.WebCommit != archiveTestCommit || len(manifest.Assets) != 4 {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
	inventory, _ := json.Marshal(manifest.Assets)
	digest := sha256.Sum256(inventory)
	if manifest.ArtifactDigest != hex.EncodeToString(digest[:]) || manifest.ReleaseID != archiveTestCommit+"-"+manifest.ArtifactDigest {
		t.Fatalf("manifest does not identify its inventory: %+v", manifest)
	}
	for _, asset := range manifest.Assets {
		got, err := hashArchiveFile(filepath.Join(directory, asset.Path), asset.Path)
		if err != nil || got != asset {
			t.Fatalf("persisted asset differs: %+v (%v)", asset, err)
		}
	}
	before, _ := os.ReadFile(filepath.Join(directory, archiveManifestName))
	if err := runArchive(context.Background(), archiveConfig{dist: dist, bucket: bucket}, io.Discard); err != nil {
		t.Fatalf("identical retry failed: %v", err)
	}
	after, _ := os.ReadFile(filepath.Join(directory, archiveManifestName))
	if !bytes.Equal(before, after) {
		t.Fatal("retry changed manifest")
	}
	for name, want := range map[string]string{
		"index.html": "current production app", "channels/stable.json": "existing stable pointer", "channels/latest.json": "existing latest pointer",
	} {
		got, _ := os.ReadFile(filepath.Join(bucket, name))
		if string(got) != want {
			t.Fatalf("archive changed %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(directory, "release.json")); !os.IsNotExist(err) {
		t.Fatal("archive must not advertise an activatable release")
	}
}

func TestArchiveIdentityTracksBytesNotOnlyCommit(t *testing.T) {
	dist := archiveFixture(t)
	a, err := snapshotArchive(dist, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	writeArchiveFixture(t, dist, "assets/lazy.js", "export default 'changed build input'")
	b, err := snapshotArchive(dist, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if a.ReleaseID == b.ReleaseID || a.WebCommit != b.WebCommit {
		t.Fatal("rebuilding one commit with different bytes must get a different ID")
	}
}

func TestArchiveDryRunWritesNothing(t *testing.T) {
	bucket := filepath.Join(t.TempDir(), "not-created")
	var out bytes.Buffer
	if err := runArchive(context.Background(), archiveConfig{dist: archiveFixture(t), bucket: bucket, dryRun: true}, &out); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bucket); !os.IsNotExist(err) {
		t.Fatal("dry run wrote a destination")
	}
	if !strings.Contains(out.String(), "would archive") {
		t.Fatal("missing dry-run inventory")
	}
}

func TestArchiveRejectsInvalidBuilds(t *testing.T) {
	for _, test := range []struct {
		name  string
		alter func(*testing.T, string)
	}{
		{"missing version", func(t *testing.T, d string) { os.Remove(filepath.Join(d, "version.yaml")) }},
		{"missing index", func(t *testing.T, d string) { os.Remove(filepath.Join(d, "index.html")) }},
		{"short commit", func(t *testing.T, d string) { writeArchiveFixture(t, d, "version.yaml", "webCommit: abcd") }},
		{"reserved manifest", func(t *testing.T, d string) { writeArchiveFixture(t, d, "release.json", "{}") }},
		{"existing archive manifest", func(t *testing.T, d string) { writeArchiveFixture(t, d, archiveManifestName, "{}") }},
		{"URL syntax", func(t *testing.T, d string) { writeArchiveFixture(t, d, "asset#1.js", "bad path") }},
		{"symlink", func(t *testing.T, d string) {
			if err := os.Symlink("app.js", filepath.Join(d, "link.js")); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			dist, bucket := archiveFixture(t), t.TempDir()
			test.alter(t, dist)
			if err := runArchive(context.Background(), archiveConfig{dist: dist, bucket: bucket}, io.Discard); err == nil {
				t.Fatal("invalid build accepted")
			}
			entries, _ := os.ReadDir(bucket)
			if len(entries) != 0 {
				t.Fatal("invalid build wrote destination")
			}
		})
	}
}

func TestArchiveRejectsUnsafeDestinationsAndPaths(t *testing.T) {
	dist := archiveFixture(t)
	for _, bucket := range []string{"", dist, filepath.Join(dist, "nested"), "gs://bucket/prefix*", "https://example.com", "gs://bucket/a#1"} {
		if err := runArchive(context.Background(), archiveConfig{dist: dist, bucket: bucket}, io.Discard); err == nil {
			t.Errorf("accepted destination %q", bucket)
		}
	}
	for _, path := range []string{"", "/index.html", "../index.html", "x/./y", "x//y", "x\\y", "a?b", "a#b", "a%2fb", "a*b", "[ab]"} {
		if validArchivePath(path) {
			t.Errorf("accepted path %q", path)
		}
	}
}

func TestArchiveConflictAndInterruptedPublication(t *testing.T) {
	dist, staging, bucket := archiveFixture(t), t.TempDir(), t.TempDir()
	manifest, err := snapshotArchive(dist, staging)
	if err != nil {
		t.Fatal(err)
	}
	prefix := "version/" + manifest.ReleaseID + "/"
	// Simulate a prior interrupted upload with a conflicting second asset.
	conflict := prefix + manifest.Assets[1].Path
	writeArchiveFixture(t, bucket, conflict, "existing bytes must survive")
	if err := runArchive(context.Background(), archiveConfig{dist: dist, bucket: bucket}, io.Discard); err == nil {
		t.Fatal("conflicting object accepted")
	}
	got, _ := os.ReadFile(filepath.Join(bucket, conflict))
	if string(got) != "existing bytes must survive" {
		t.Fatal("conflict overwritten")
	}
	if _, err := os.Stat(filepath.Join(bucket, prefix, archiveManifestName)); !os.IsNotExist(err) {
		t.Fatal("failed publication advertised complete archive")
	}
	// A matching partial upload is resumable.
	if err := os.Remove(filepath.Join(bucket, conflict)); err != nil {
		t.Fatal(err)
	}
	if err := runArchive(context.Background(), archiveConfig{dist: dist, bucket: bucket}, io.Discard); err != nil {
		t.Fatal(err)
	}
	readArchive(t, bucket)
}

func TestConcurrentArchivePublication(t *testing.T) {
	dist, bucket := archiveFixture(t), t.TempDir()
	var wg sync.WaitGroup
	errs := make(chan error, 3)
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- runArchive(context.Background(), archiveConfig{dist: dist, bucket: bucket}, io.Discard)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	readArchive(t, bucket)
}

// TestMain also serves as a Go fake for the gcloud command boundary. It checks
// the actual CLI arguments, preconditions and remote readback without credentials.
func TestMain(m *testing.M) {
	if root := os.Getenv("RUNME_ARCHIVE_TEST_GCLOUD"); root != "" {
		if err := fakeArchiveGcloud(root, os.Args[1:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeArchiveGcloud(root string, args []string) error {
	if len(args) < 3 || args[0] != "storage" {
		return fmt.Errorf("unexpected arguments %v", args)
	}
	remotePath := func(url string) string {
		return filepath.Join(root, strings.TrimPrefix(strings.Split(url, "#")[0], "gs://"))
	}
	switch args[1] {
	case "cp":
		if len(args) < 6 || args[2] != "--if-generation-match=0" || args[3] != "--cache-control="+immutableCacheControl {
			return fmt.Errorf("missing create-only precondition %v", args)
		}
		source, target := args[len(args)-2], remotePath(args[len(args)-1])
		if _, err := os.Stat(target); err == nil {
			return fmt.Errorf("412 precondition failed")
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return copyFile(source, target)
	case "objects":
		if len(args) != 6 || args[2] != "describe" || args[4] != "--raw" || args[5] != "--format=json" {
			return fmt.Errorf("unexpected describe %v", args)
		}
		if _, err := os.Stat(remotePath(args[3])); err != nil {
			return err
		}
		cache := immutableCacheControl
		if os.Getenv("RUNME_ARCHIVE_TEST_BAD_METADATA") != "" {
			cache = "no-cache"
		}
		return json.NewEncoder(os.Stdout).Encode(map[string]string{"generation": "1", "cacheControl": cache, "contentType": "application/json"})
	case "cat":
		if os.Getenv("RUNME_ARCHIVE_TEST_DENIED") != "" {
			return fmt.Errorf("403 permission denied")
		}
		if !strings.HasSuffix(args[2], "#1") && !strings.HasSuffix(args[2], "/"+archiveManifestName) {
			return fmt.Errorf("expected generation-qualified read")
		}
		f, err := os.Open(remotePath(args[2]))
		if err != nil {
			if os.IsNotExist(err) {
				return fmt.Errorf("No URLs matched")
			}
			return err
		}
		defer f.Close()
		_, err = io.Copy(os.Stdout, f)
		return err
	default:
		return fmt.Errorf("unexpected gcloud operation %v", args)
	}
}

func setupArchiveGcloud(t *testing.T) string {
	t.Helper()
	bin, root := t.TempDir(), t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(exe, filepath.Join(bin, "gcloud")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("RUNME_ARCHIVE_TEST_GCLOUD", root)
	return root
}

func TestGCSArchiveRetryAndConflict(t *testing.T) {
	root := setupArchiveGcloud(t)
	dist := archiveFixture(t)
	cfg := archiveConfig{dist: dist, bucket: "gs://test-bucket/releases"}
	for i := 0; i < 2; i++ {
		if err := runArchive(context.Background(), cfg, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	_, directory := readArchive(t, filepath.Join(root, "test-bucket/releases"))
	writeArchiveFixture(t, directory, "app.js", "unexpected remote bytes")
	if err := runArchive(context.Background(), cfg, io.Discard); err == nil || !strings.Contains(err.Error(), "immutable object differs") {
		t.Fatalf("expected conflict, got %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(directory, "app.js"))
	if string(got) != "unexpected remote bytes" {
		t.Fatal("conflict overwritten")
	}
}

func TestGCSArchiveRejectsMetadataBeforeManifest(t *testing.T) {
	root := setupArchiveGcloud(t)
	t.Setenv("RUNME_ARCHIVE_TEST_BAD_METADATA", "1")
	if err := runArchive(context.Background(), archiveConfig{dist: archiveFixture(t), bucket: "gs://test-bucket"}, io.Discard); err == nil {
		t.Fatal("bad metadata accepted")
	}
	matches, _ := filepath.Glob(filepath.Join(root, "test-bucket/version/*", archiveManifestName))
	if len(matches) != 0 {
		t.Fatal("manifest published before object validation")
	}
}
