package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

// Runtime manifests are separate from archives: only lifecycle-aware builds can activate.
type runtimeManifest struct {
	TabRecoveryFormat      int      `json:"tabRecoveryFormat,omitempty"`
	RecoveredControlFormat int      `json:"recoveredControlFormat,omitempty"`
	Format                 int      `json:"format"`
	ReleaseID              string   `json:"releaseId"`
	WebCommit              string   `json:"webCommit"`
	BuildID                string   `json:"buildId"`
	BuildInputsDigest      string   `json:"buildInputsDigest"`
	PublishedAt            string   `json:"publishedAt"`
	RequiredCapabilities   []string `json:"requiredCapabilities"`
	TestedRollbackTargets  []string `json:"testedRollbackTargets"`
	AppEntry               string   `json:"appEntry"`
	Styles                 []string `json:"styles"`
	Owner                  struct {
		BuildID string `json:"buildId"`
		Entry   string `json:"entry"`
		RPCMin  int    `json:"rpcMin"`
		RPCMax  int    `json:"rpcMax"`
	} `json:"owner"`
	LauncherProtocol struct {
		Min int `json:"min"`
		Max int `json:"max"`
	} `json:"launcherProtocol"`
	StorageCompatibilityID string         `json:"storageCompatibilityId"`
	Assets                 []runtimeAsset `json:"assets"`
}
type runtimeAsset struct {
	archiveAsset
	RequiredOffline bool `json:"requiredOffline"`
}

// The catalog offers human identity and support metadata; manifests remain the
// authority for compatibility and complete verified asset inventories.
type catalogEntry struct {
	ReleaseID              string `json:"releaseId"`
	WebCommit              string `json:"webCommit"`
	BuildID                string `json:"buildId"`
	PublishedAt            string `json:"publishedAt"`
	StorageCompatibilityID string `json:"storageCompatibilityId"`
	Support                string `json:"support"`
	NotesURL               string `json:"notesUrl"`
}
type channelPointer struct {
	Format         int    `json:"format"`
	Generation     int64  `json:"generation"`
	ReleaseID      string `json:"releaseId"`
	ManifestSHA256 string `json:"manifestSha256"`
}

// Pin GCS reads to the observed generation for subsequent compare-and-swap writes.
func readObject(ctx context.Context, bucket, name string) ([]byte, string, error) {
	location := destinationURL(bucket, name)
	if !strings.HasPrefix(bucket, "gs://") {
		data, err := os.ReadFile(location)
		if errors.Is(err, os.ErrNotExist) {
			return nil, "0", nil
		}
		sum := sha256.Sum256(data)
		return data, hex.EncodeToString(sum[:]), err
	}
	metadata, err := runCmdOutput(ctx, "", nil, "gcloud", "storage", "objects", "describe", location, "--raw", "--format=json")
	if err != nil {
		if isMissingVersionMarkerError(err) {
			return nil, "0", nil
		}
		return nil, "", err
	}
	var object struct {
		Generation string `json:"generation"`
	}
	if err = json.Unmarshal(metadata, &object); err != nil {
		return nil, "", err
	}
	if object.Generation == "" || strings.Trim(object.Generation, "0123456789") != "" {
		return nil, "", errors.New("invalid object generation")
	}
	data, err := runCmdOutput(ctx, "", nil, "gcloud", "storage", "cat", location+"#"+object.Generation)
	return data, object.Generation, err
}

// Every mutable object uses CAS. Local publishing serializes writers with an
// exclusive file lock; abandoned locks fail visibly instead of forcing an overwrite.
func writeMutable(ctx context.Context, bucket, name string, data []byte, generation string) error {
	location := destinationURL(bucket, name)
	contentType := "application/json"
	if strings.HasSuffix(name, ".html") {
		contentType = "text/html; charset=utf-8"
	}
	if strings.HasSuffix(name, ".js") {
		contentType = "text/javascript"
	}
	if !strings.HasPrefix(bucket, "gs://") {
		if err := os.MkdirAll(filepath.Dir(location), 0755); err != nil {
			return err
		}
		lock, err := os.OpenFile(location+".lock", os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return fmt.Errorf("publication locked: %w", err)
		}
		defer os.Remove(lock.Name())
		defer lock.Close()
		_, actual, err := readObject(ctx, bucket, name)
		if err != nil {
			return err
		}
		if actual != generation {
			return errors.New("publication generation changed")
		}
		temp, err := os.CreateTemp(filepath.Dir(location), ".publish-")
		if err != nil {
			return err
		}
		defer os.Remove(temp.Name())
		if _, err = temp.Write(data); err != nil {
			temp.Close()
			return err
		}
		if err = temp.Close(); err != nil {
			return err
		}
		return os.Rename(temp.Name(), location)
	}
	temp, err := os.CreateTemp("", "runme-pointer-")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	_, err = runCmdOutput(ctx, "", nil, "gcloud", "storage", "cp", "--if-generation-match="+generation, "--cache-control=no-cache, max-age=0, must-revalidate", "--content-type="+contentType, temp.Name(), location)
	return err
}

// Verify the completed archive, publish the activatable manifest last, then
// advance channel pointers. Source-head checks plus CAS reject slower old jobs.
// Written into the candidate before testing, archived only after the suite passes.
type releaseAcceptance struct {
	Format    int    `json:"format"`
	ReleaseID string `json:"releaseId"`
	Suite     string `json:"suite"`
}

func publishRuntime(ctx context.Context, inputs buildInputs, followStable bool, out io.Writer) error {
	id, err := inputs.id()
	if err != nil {
		return err
	}
	id = inputs.WebCommit + "-" + id
	if ok, err := verifyBuildArchive(ctx, inputs, id); err != nil || !ok {
		return fmt.Errorf("release archive unavailable: %v", err)
	}
	prefix := "version/" + id + "/"
	acceptance, _, err := readObject(ctx, inputs.Bucket, prefix+"release-acceptance.json")
	if err != nil {
		return err
	}
	var receipt releaseAcceptance
	if err := json.Unmarshal(acceptance, &receipt); err != nil || receipt.Format != 1 || receipt.ReleaseID != id || receipt.Suite != "controlled-releases-v1" {
		return errors.New("release missing exact-candidate acceptance receipt")
	}

	raw, _, err := readObject(ctx, inputs.Bucket, prefix+archiveManifestName)
	if err != nil {
		return err
	}
	var archive releaseArchive
	if err = json.Unmarshal(raw, &archive); err != nil {
		return err
	}
	raw, _, err = readObject(ctx, inputs.Bucket, prefix+"release-metadata.json")
	if err != nil {
		return err
	}
	var manifest runtimeManifest
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return err
	}
	manifest.Format = 1
	manifest.WebCommit = inputs.WebCommit
	manifest.BuildID = archive.BuildID
	manifest.BuildInputsDigest = archive.BuildID
	manifest.PublishedAt = time.Now().UTC().Format(time.RFC3339)
	// Publication time does not affect build identity; retries retain the first
	// publication's value so an already-published manifest remains immutable.
	existing, _, err := readObject(ctx, inputs.Bucket, prefix+"release.json")
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		var prior runtimeManifest
		if err := json.Unmarshal(existing, &prior); err != nil {
			return err
		}
		if _, err := time.Parse(time.RFC3339, prior.PublishedAt); err != nil {
			return err
		}
		manifest.PublishedAt = prior.PublishedAt
	}
	if manifest.TestedRollbackTargets == nil {
		manifest.TestedRollbackTargets = []string{}
	}
	for _, asset := range archive.Assets {
		manifest.Assets = append(manifest.Assets, runtimeAsset{asset, true})
	}
	if manifest.Owner.BuildID != archive.BuildID || !slices.Equal(manifest.RequiredCapabilities, []string{"durable-prepare-v1", "epoch-fence-v1", "owner-lock-v1"}) {
		return errors.New("build missing lifecycle capabilities")
	}
	if manifest.ReleaseID != id || manifest.LauncherProtocol.Min != 1 || manifest.LauncherProtocol.Max != 1 || manifest.Owner.RPCMin != 8 || manifest.Owner.RPCMax != 8 || manifest.StorageCompatibilityID != "runme-schema9-oplog2-payload1-console1" {
		return errors.New("build does not implement the supported release contract")
	}
	paths := map[string]bool{}
	for _, asset := range archive.Assets {
		paths[asset.Path] = true
	}
	for _, path := range append([]string{manifest.AppEntry, manifest.Owner.Entry, "launcher.html", "launcher.json", "sw.js", "release-acceptance.json"}, manifest.Styles...) {
		if !paths[path] {
			return fmt.Errorf("missing runtime asset %s", path)
		}
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	staging, err := os.MkdirTemp("", "runme-manifest-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err = os.WriteFile(filepath.Join(staging, "release.json"), encoded, 0644); err != nil {
		return err
	}
	asset, err := hashArchiveFile(filepath.Join(staging, "release.json"), "release.json")
	if err != nil {
		return err
	}
	if err = publishArchiveAsset(ctx, inputs.Bucket, prefix, staging, asset); err != nil {
		return err
	}
	current := func() error {
		source, err := resolveRepoSource(inputs.WebRepo)
		if err != nil {
			return err
		}
		head, err := gitRemoteBranchHead(ctx, source.cloneSource, inputs.WebBranch)
		if err != nil {
			return err
		}
		if head != inputs.WebCommit {
			return errors.New("source branch advanced; retained archive without promoting stale build")
		}
		return nil
	}
	names := []string{"latest"}
	if followStable {
		names = append(names, "stable")
	}
	for _, name := range names {
		path := "channels/" + name + ".json"
		previous, generation, err := readObject(ctx, inputs.Bucket, path)
		if err != nil {
			return err
		}
		pointer, err := nextPointer(previous, id, asset.SHA256)
		if err != nil {
			return err
		}
		if err = current(); err != nil {
			return err
		}
		if pointer != nil {
			if err = writeMutable(ctx, inputs.Bucket, path, pointer, generation); err != nil {
				return err
			}
		}
	}
	catalogRaw, generation, err := readObject(ctx, inputs.Bucket, "releases/catalog.json")
	if err != nil {
		return err
	}
	catalog := struct {
		Format   int            `json:"format"`
		Releases []catalogEntry `json:"releases"`
	}{Format: 1}
	if len(catalogRaw) > 0 {
		if err = json.Unmarshal(catalogRaw, &catalog); err != nil {
			return err
		}
		if catalog.Format != 1 {
			return errors.New("unsupported catalog")
		}
	}
	found := false
	for _, old := range catalog.Releases {
		if old.ReleaseID == id {
			found = true
		}
	}
	if !found {
		catalog.Releases = append(catalog.Releases, catalogEntry{id, inputs.WebCommit, archive.BuildID, manifest.PublishedAt, manifest.StorageCompatibilityID, "lifecycle-v1", "https://github.com/" + inputs.WebRepo + "/commit/" + inputs.WebCommit})
		data, _ := json.Marshal(catalog)
		if err = writeMutable(ctx, inputs.Bucket, "releases/catalog.json", data, generation); err != nil {
			return err
		}
	}
	// The service worker embeds its matching shell. Partial root updates still
	// reference complete immutable bootstrap assets and never select an app version.
	for _, pair := range [][2]string{{"launcher.json", "launcher.json"}, {"sw.js", "sw.js"}, {"storage-owner.js", ""}, {"recovery.html", "launcher.html"}, {"index.html", "launcher.html"}} {
		var data []byte
		if pair[1] == "" {
			data = []byte("self.onconnect=e=>{const p=e.ports[0];p.onmessage=()=>p.postMessage('runme-legacy-owner-retired');p.start();p.postMessage('runme-legacy-owner-retired')}")
		} else {
			data, _, err = readObject(ctx, inputs.Bucket, prefix+pair[1])
			if err != nil {
				return err
			}
		}
		old, generation, err := readObject(ctx, inputs.Bucket, pair[0])
		if err != nil {
			return err
		}
		if err = current(); err != nil {
			return err
		}
		if !bytes.Equal(old, data) {
			if err = writeMutable(ctx, inputs.Bucket, pair[0], data, generation); err != nil {
				return err
			}
		}
	}
	fmt.Fprintf(out, "published eligible release %s; latest updated; stable follows latest=%v\n", id, followStable)
	return nil
}

// Identical reconciliation is a no-op, including pointer generation.
func nextPointer(previous []byte, id, digest string) ([]byte, error) {
	pointer := channelPointer{Format: 1}
	if len(previous) > 0 {
		if err := json.Unmarshal(previous, &pointer); err != nil {
			return nil, err
		}
		if pointer.Format != 1 || pointer.Generation < 1 || !validDigest(pointer.ManifestSHA256) {
			return nil, errors.New("invalid existing channel pointer")
		}
	}
	if pointer.ReleaseID == id {
		if pointer.ManifestSHA256 != digest {
			return nil, errors.New("immutable manifest changed")
		}
		return nil, nil
	}
	pointer.Generation++
	pointer.ReleaseID = id
	pointer.ManifestSHA256 = digest
	return json.Marshal(pointer)
}
