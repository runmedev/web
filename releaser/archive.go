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
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/spf13/cobra"
)

const archiveManifestName = "archive.json"
const immutableCacheControl = "public, max-age=31536000, immutable"

var commitPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var archivePathPattern = regexp.MustCompile(`^[A-Za-z0-9_@+.,() -]+$`)

// releaseArchive describes preserved build bytes, not permission to activate a
// release. A future release.json will carry loader/owner compatibility checks.
// Keeping these separate prevents legacy builds from becoming rollback choices.
type releaseArchive struct {
	Format         int            `json:"format"`
	Kind           string         `json:"kind"`
	ReleaseID      string         `json:"releaseId"`
	WebCommit      string         `json:"webCommit"`
	ArtifactDigest string         `json:"artifactDigest"`
	BuildID        string         `json:"buildId,omitempty"`
	BuildInputs    *buildInputs   `json:"buildInputs,omitempty"`
	Assets         []archiveAsset `json:"assets"`
}

type archiveAsset struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type archiveConfig struct {
	dist   string
	bucket string
	dryRun bool
	inputs *buildInputs
}

// newArchiveCmd adds an opt-in publication path for already-built artifacts.
// It never changes the root app, release catalog, or channel pointers.
func newArchiveCmd() *cobra.Command {
	cfg := archiveConfig{}
	cmd := &cobra.Command{
		Use:   "archive --dist=<dir> --bucket=<destination>",
		Short: "Preserve a built release under an immutable version prefix (no activation)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runArchive(cmd.Context(), cfg, cmd.OutOrStdout())
		},
	}
	cmd.Flags().StringVar(&cfg.dist, "dist", "", "built app directory containing version.yaml")
	cmd.Flags().StringVar(&cfg.bucket, "bucket", "", "destination gs:// bucket or local directory (required; no production default)")
	cmd.Flags().BoolVar(&cfg.dryRun, "dry-run", false, "hash and report the archive without writing anything")
	_ = cmd.MarkFlagRequired("dist")
	_ = cmd.MarkFlagRequired("bucket")
	return cmd
}

// runArchive snapshots the completed build before publication so changes after
// hashing cannot alter uploaded bytes. Do not rebuild dist during the snapshot.
// The manifest is published last.
func runArchive(ctx context.Context, cfg archiveConfig, out io.Writer) error {
	if strings.TrimSpace(cfg.bucket) == "" {
		return errors.New("archive destination is required")
	}
	// gcloud treats wildcard/version suffixes specially even without a shell.
	if strings.ContainsAny(cfg.bucket, "*?[]#\r\n") || (strings.Contains(cfg.bucket, "://") && !strings.HasPrefix(cfg.bucket, "gs://")) {
		return errors.New("expected a literal gs:// bucket/prefix or local directory")
	}
	if !strings.HasPrefix(cfg.bucket, "gs://") {
		dist, err := filepath.Abs(cfg.dist)
		if err != nil {
			return err
		}
		bucket, err := filepath.Abs(cfg.bucket)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(dist, bucket)
		if err != nil || rel == "." || (!strings.HasPrefix(rel, ".."+string(filepath.Separator)) && rel != "..") {
			return errors.New("archive destination must be outside the build directory")
		}
	}
	staging, err := os.MkdirTemp("", "runme-release-archive-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	manifest, err := snapshotArchive(cfg.dist, staging)
	if err != nil {
		return err
	}
	if cfg.inputs != nil {
		buildID, err := cfg.inputs.id()
		if err != nil {
			return err
		}
		version, _, err := readVersion(ctx, staging)
		if err != nil || version.WebCommit != cfg.inputs.WebCommit || version.WebRepo != cfg.inputs.WebRepo || version.WebBranch != cfg.inputs.WebBranch || version.Bucket != cfg.inputs.Bucket {
			return fmt.Errorf("build version does not match declared inputs: %v", err)
		}
		manifest.BuildID, manifest.BuildInputs = buildID, cfg.inputs
		manifest.ReleaseID = cfg.inputs.WebCommit + "-" + buildID
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	encoded = append(encoded, '\n')
	manifestPath := filepath.Join(staging, archiveManifestName)
	if err := os.WriteFile(manifestPath, encoded, 0o644); err != nil {
		return err
	}
	manifestAsset, err := hashArchiveFile(manifestPath, archiveManifestName)
	if err != nil {
		return err
	}
	prefix := "version/" + manifest.ReleaseID + "/"
	assets := append(append([]archiveAsset{}, manifest.Assets...), manifestAsset)
	for _, asset := range assets {
		if err := ctx.Err(); err != nil {
			return err
		}
		if cfg.dryRun {
			fmt.Fprintf(out, "would archive %s sha256=%s bytes=%d\n", destinationURL(cfg.bucket, prefix+asset.Path), asset.SHA256, asset.Bytes)
			continue
		}
		if err := publishArchiveAsset(ctx, cfg.bucket, prefix, staging, asset); err != nil {
			return fmt.Errorf("archive %s: %w", asset.Path, err)
		}
	}
	fmt.Fprintf(out, "release archive %s (activation unavailable; no channel changed)\n", manifest.ReleaseID)
	return nil
}

// snapshotArchive copies regular build files, then hashes the snapshot. The
// release ID includes the complete inventory digest so rebuilding one commit
// with different environment/configuration/bytes creates a different archive.
func snapshotArchive(dist, staging string) (releaseArchive, error) {
	if err := assertDir(dist); err != nil {
		return releaseArchive{}, err
	}
	assets := []archiveAsset{}
	err := filepath.WalkDir(dist, func(source string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("archive requires regular files, found %s", source)
		}
		rel, err := filepath.Rel(dist, source)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !validArchivePath(rel) {
			return fmt.Errorf("unsupported archive asset path %q", rel)
		}
		if rel == archiveManifestName || rel == "release.json" {
			return fmt.Errorf("reserved archive asset path %q", rel)
		}
		target := filepath.Join(staging, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := copyFile(source, target); err != nil {
			return err
		}
		asset, err := hashArchiveFile(target, rel)
		if err != nil {
			return err
		}
		assets = append(assets, asset)
		return nil
	})
	if err != nil {
		return releaseArchive{}, err
	}
	if err := assertFile(filepath.Join(staging, "index.html")); err != nil {
		return releaseArchive{}, fmt.Errorf("archive requires index.html: %w", err)
	}
	version, exists, err := readVersion(context.Background(), staging)
	if err != nil || !exists || !commitPattern.MatchString(version.WebCommit) {
		return releaseArchive{}, fmt.Errorf("archive requires version.yaml with a full lowercase webCommit SHA (read error: %v)", err)
	}
	sort.Slice(assets, func(i, j int) bool { return assets[i].Path < assets[j].Path })
	inventory, err := json.Marshal(assets)
	if err != nil {
		return releaseArchive{}, err
	}
	digest := sha256.Sum256(inventory)
	fingerprint := hex.EncodeToString(digest[:])
	return releaseArchive{
		Format: 1, Kind: "runme-build-archive", WebCommit: version.WebCommit,
		ReleaseID: version.WebCommit + "-" + fingerprint, ArtifactDigest: fingerprint,
		Assets: assets,
	}, nil
}

// validArchivePath rejects traversal, URL syntax and gcloud wildcard syntax.
func validArchivePath(path string) bool {
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." || !archivePathPattern.MatchString(segment) {
			return false
		}
	}
	return true
}

// hashArchiveFile streams bytes so large WASM/source map assets stay bounded.
func hashArchiveFile(path, rel string) (archiveAsset, error) {
	f, err := os.Open(path)
	if err != nil {
		return archiveAsset{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return archiveAsset{Path: rel, SHA256: hex.EncodeToString(h.Sum(nil)), Bytes: n}, err
}

// publishArchiveAsset uses create-only writes and verifies persisted bytes even
// after an upload error. An identical retry succeeds; conflicting bytes fail and
// are never replaced. GCS metadata must also retain immutable caching semantics.
func publishArchiveAsset(ctx context.Context, bucket, prefix, staging string, asset archiveAsset) error {
	source := filepath.Join(staging, filepath.FromSlash(asset.Path))
	destination := destinationURL(bucket, prefix+asset.Path)
	if !strings.HasPrefix(bucket, "gs://") {
		if err := publishLocalArchiveFile(source, destination); err != nil {
			return err
		}
		actual, err := hashArchiveFile(destination, asset.Path)
		if err != nil {
			return err
		}
		if actual != asset {
			return fmt.Errorf("immutable object differs: %s", destination)
		}
		return nil
	}
	args := []string{"storage", "cp", "--if-generation-match=0", "--cache-control=" + immutableCacheControl}
	if asset.Path == archiveManifestName {
		args = append(args, "--content-type=application/json")
	}
	args = append(args, source, destination)
	_, uploadErr := runCmdOutput(ctx, "", nil, "gcloud", args...)
	if err := verifyGCSArchiveAsset(ctx, destination, asset); err != nil {
		return errors.Join(uploadErr, err)
	}
	return nil
}

// publishLocalArchiveFile links a fully written temporary file into place. Link
// fails if the name exists, unlike rename; readers never see a partial object.
func publishLocalArchiveFile(source, destination string) error {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(destination), ".archive-")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Close(); err != nil {
		return err
	}
	if err := copyFile(source, tempPath); err != nil {
		return err
	}
	if err := os.Link(tempPath, destination); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return nil
}

// verifyGCSArchiveAsset reads the persisted generation, then its bytes. The
// generation-qualified URL avoids combining metadata and content from two
// generations if an external writer violates the archive's immutability.
func verifyGCSArchiveAsset(ctx context.Context, destination string, asset archiveAsset) error {
	metadata, err := runCmdOutput(ctx, "", nil, "gcloud", "storage", "objects", "describe", destination, "--raw", "--format=json")
	if err != nil {
		return err
	}
	var object struct {
		Generation   string `json:"generation"`
		CacheControl string `json:"cacheControl"`
		ContentType  string `json:"contentType"`
	}
	if err := json.Unmarshal(metadata, &object); err != nil {
		return err
	}
	if object.Generation == "" || strings.Trim(object.Generation, "0123456789") != "" || object.CacheControl != immutableCacheControl {
		return fmt.Errorf("unexpected archive metadata at %s", destination)
	}
	if asset.Path == archiveManifestName && object.ContentType != "application/json" {
		return fmt.Errorf("unexpected manifest content type at %s", destination)
	}
	h := sha256.New()
	counter := &countingWriter{writer: h}
	cmd := exec.CommandContext(ctx, "gcloud", "storage", "cat", destination+"#"+object.Generation)
	cmd.Stdout = counter
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("verify archive object: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	if counter.bytes != asset.Bytes || hex.EncodeToString(h.Sum(nil)) != asset.SHA256 {
		return fmt.Errorf("immutable object differs: %s", destination)
	}
	return nil
}

// countingWriter checks persisted length and digest in one bounded-memory pass.
type countingWriter struct {
	writer io.Writer
	bytes  int64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	n, err := w.writer.Write(p)
	w.bytes += int64(n)
	return n, err
}
