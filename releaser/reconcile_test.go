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

// buildInputsFixture supplies an explicit toolchain without invoking a real build.
func buildInputsFixture(bucket string) buildInputs {
	return buildInputs{Format: 1, WebRepo: "runmedev/web", WebCommit: archiveTestCommit,
		WebBranch: "main", Bucket: bucket, BuilderSHA256: strings.Repeat("a", 64),
		NodeVersion: "v20.19.0", PNPMVersion: "10.23.0", Platform: "linux/amd64",
		BuildRevision: "1", PublicEnv: map[string]string{"VITE_EXAMPLE": "public-setting"}}
}

// desiredBuildFixture attaches matching provenance to an otherwise ordinary build.
func desiredBuildFixture(t *testing.T, inputs buildInputs) string {
	t.Helper()
	dist := archiveFixture(t)
	if err := writeVersionYAML(dist, releaseVersion{WebRepo: inputs.WebRepo, WebBranch: inputs.WebBranch, WebCommit: inputs.WebCommit, Bucket: inputs.Bucket}); err != nil {
		t.Fatal(err)
	}
	return dist
}

func TestBuildIDDeterministicBeforeBuild(t *testing.T) {
	a := buildInputsFixture("gs://test-bucket")
	a.PublicEnv = map[string]string{"VITE_B": "b", "VITE_A": "a"}
	b := a
	b.PublicEnv = map[string]string{"VITE_A": "a", "VITE_B": "b"}
	first, err := a.id()
	if err != nil {
		t.Fatal(err)
	}
	second, err := b.id()
	if err != nil || first != second {
		t.Fatalf("map ordering changed ID: %v", err)
	}
	for name, alter := range map[string]func(*buildInputs){
		"source":               func(b *buildInputs) { b.WebCommit = strings.Repeat("f", 40) },
		"configuration":        func(b *buildInputs) { b.PublicEnv = map[string]string{"VITE_A": "different"} },
		"node":                 func(b *buildInputs) { b.NodeVersion = "v22.0.0" },
		"pnpm":                 func(b *buildInputs) { b.PNPMVersion = "11.0.0" },
		"builder":              func(b *buildInputs) { b.BuilderSHA256 = strings.Repeat("b", 64) },
		"platform":             func(b *buildInputs) { b.Platform = "darwin/arm64" },
		"revision":             func(b *buildInputs) { b.BuildRevision = "2" },
		"embedded destination": func(b *buildInputs) { b.Bucket = "gs://other" },
		"embedded branch":      func(b *buildInputs) { b.WebBranch = "release" },
	} {
		t.Run(name, func(t *testing.T) {
			changed := a
			alter(&changed)
			id, err := changed.id()
			if err != nil || id == first {
				t.Fatalf("changed input did not change ID: %v", err)
			}
		})
	}
}

func TestReconcileCreatesOnceAndRevisionCreatesAnother(t *testing.T) {
	inputs := buildInputsFixture(t.TempDir())
	calls := 0
	build := func() (string, error) { calls++; return desiredBuildFixture(t, inputs), nil }
	for i := 0; i < 2; i++ {
		if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("built %d times; want 1", calls)
	}
	manifest, _ := readArchive(t, inputs.Bucket)
	id, _ := inputs.id()
	if manifest.BuildID != id || manifest.ReleaseID != inputs.WebCommit+"-"+id {
		t.Fatal("archive did not use pre-build identity")
	}
	inputs.BuildRevision = "2"
	if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err != nil {
		t.Fatal(err)
	}
	manifests, _ := filepath.Glob(filepath.Join(inputs.Bucket, "version", "*", archiveManifestName))
	if calls != 2 || len(manifests) != 2 {
		t.Fatal("revision did not preserve both builds")
	}
}

func TestReconcileDoesNotBuildOnDryRunOrCorruption(t *testing.T) {
	inputs := buildInputsFixture(t.TempDir())
	calls := 0
	build := func() (string, error) { calls++; return desiredBuildFixture(t, inputs), nil }
	if err := ensureBuildArchive(context.Background(), inputs, true, io.Discard, build); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatal("dry-run built")
	}
	if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err != nil {
		t.Fatal(err)
	}
	_, dir := readArchive(t, inputs.Bucket)
	writeArchiveFixture(t, dir, "app.js", "corrupt")
	if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err == nil {
		t.Fatal("corruption accepted")
	}
	if calls != 1 {
		t.Fatal("corruption triggered rebuild")
	}
}

func TestDeclaredIdentityRejectsDifferentBytes(t *testing.T) {
	inputs := buildInputsFixture(t.TempDir())
	dist := desiredBuildFixture(t, inputs)
	cfg := archiveConfig{dist: dist, bucket: inputs.Bucket, inputs: &inputs}
	if err := runArchive(context.Background(), cfg, io.Discard); err != nil {
		t.Fatal(err)
	}
	_, dir := readArchive(t, inputs.Bucket)
	before, _ := os.ReadFile(filepath.Join(dir, archiveManifestName))
	writeArchiveFixture(t, dist, "app.js", "nondeterministic output")
	if err := runArchive(context.Background(), cfg, io.Discard); err == nil {
		t.Fatal("different bytes overwritten at same identity")
	}
	after, _ := os.ReadFile(filepath.Join(dir, archiveManifestName))
	if string(before) != string(after) {
		t.Fatal("conflict modified manifest")
	}
}

func TestReconcileRejectsFalseCompletion(t *testing.T) {
	for _, corruption := range []string{"identity", "missing asset", "inventory"} {
		t.Run(corruption, func(t *testing.T) {
			inputs := buildInputsFixture(t.TempDir())
			build := func() (string, error) { return desiredBuildFixture(t, inputs), nil }
			if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err != nil {
				t.Fatal(err)
			}
			manifest, dir := readArchive(t, inputs.Bucket)
			switch corruption {
			case "identity":
				manifest.BuildInputs.BuildRevision = "wrong"
			case "missing asset":
				os.Remove(filepath.Join(dir, "app.js"))
			case "inventory":
				manifest.Assets[0].SHA256 = strings.Repeat("0", 64)
			}
			data, _ := json.Marshal(manifest)
			writeArchiveFixture(t, dir, archiveManifestName, string(data))
			if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, func() (string, error) { t.Fatal("false completion caused build"); return "", nil }); err == nil {
				t.Fatal("false completion accepted")
			}
		})
	}
}

func TestReconcileGCS(t *testing.T) {
	setupArchiveGcloud(t)
	inputs := buildInputsFixture("gs://test-bucket")
	calls := 0
	build := func() (string, error) { calls++; return desiredBuildFixture(t, inputs), nil }
	for i := 0; i < 2; i++ {
		if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("built %d times", calls)
	}
	t.Setenv("RUNME_ARCHIVE_TEST_DENIED", "1")
	if err := ensureBuildArchive(context.Background(), inputs, false, io.Discard, build); err == nil {
		t.Fatal("access failure accepted")
	}
	if calls != 1 {
		t.Fatal("access failure caused build")
	}
}

func TestBuildEnvironmentExcludesAmbientBuildSwitches(t *testing.T) {
	t.Setenv("NODE_OPTIONS", "--require=/untracked.js")
	t.Setenv("VITE_UNDECLARED", "not-in-plan")
	t.Setenv("CI_RUN_ID", "1234")
	env := declarativeBuildEnv(buildInputsFixture("gs://test"), releaseVersion{})
	for _, entry := range env {
		if strings.HasPrefix(entry, "NODE_OPTIONS=") || strings.HasPrefix(entry, "VITE_UNDECLARED=") || strings.HasPrefix(entry, "CI_RUN_ID=") {
			t.Fatalf("untracked build switch: %s", entry)
		}
	}
}
