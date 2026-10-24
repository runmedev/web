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
	"runtime"
	"strings"

	"github.com/spf13/cobra"
)

// buildInputs is the versioned pre-build identity. JSON field order and sorted
// map keys are part of format 1. Output hashes and publication times are separate.
// The source commit includes lockfiles, build scripts and checked-in config.
type buildInputs struct {
	Format        int               `json:"format"`
	WebRepo       string            `json:"webRepo"`
	WebCommit     string            `json:"webCommit"`
	WebBranch     string            `json:"webBranch"`
	Bucket        string            `json:"bucket"`
	BuilderSHA256 string            `json:"builderSha256"`
	NodeVersion   string            `json:"nodeVersion"`
	PNPMVersion   string            `json:"pnpmVersion"`
	Platform      string            `json:"platform"`
	BuildRevision string            `json:"buildRevision"`
	PublicEnv     map[string]string `json:"publicEnv"`
}

// id hashes declared inputs before compilation; no CI run ID or timestamp enters
// the identity. A revision bump deliberately requests a new build of one commit.
func (inputs buildInputs) id() (string, error) {
	if inputs.Format != 1 || !commitPattern.MatchString(inputs.WebCommit) || !validDigest(inputs.BuilderSHA256) || inputs.WebRepo == "" || inputs.WebBranch == "" || inputs.Bucket == "" || inputs.NodeVersion == "" || inputs.PNPMVersion == "" || inputs.Platform == "" || inputs.BuildRevision == "" || inputs.PublicEnv == nil {
		return "", errors.New("incomplete build inputs")
	}
	for name := range inputs.PublicEnv {
		if !strings.HasPrefix(name, "VITE_") || (strings.HasPrefix(name, "VITE_RUNME_VERSION_") || name == "VITE_RUNME_RELEASE_ID") || strings.ContainsAny(name, "=\x00") {
			return "", fmt.Errorf("unsupported public build variable %q", name)
		}
	}
	encoded, err := json.Marshal(inputs)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

// validDigest accepts the full lowercase SHA-256 used in persisted identities.
func validDigest(value string) bool {
	return len(value) == 64 && strings.Trim(value, "0123456789abcdef") == ""
}

// newReconcileCmd archives declarative builds and optionally publishes eligible
// releases after the caller supplies the exact acceptance-tested source commit.
func newReconcileCmd() *cobra.Command {
	cfg := config{}
	var revision, validatedCommit string
	var publish, followStable bool
	cmd := &cobra.Command{
		Use:   "reconcile --web=<branch> --bucket=<destination>",
		Short: "Ensure an immutable build exists for the resolved inputs (no activation)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if !publish {
				return runReconcile(cmd.Context(), cfg, revision, cmd.OutOrStdout())
			}
			if !cfg.dryRun && !commitPattern.MatchString(validatedCommit) {
				return errors.New("--validated-commit is required when publishing channels")
			}
			return reconcileRuntime(cmd.Context(), cfg, revision, followStable, validatedCommit, cmd.OutOrStdout())
		},
	}
	cmd.Flags().StringVar(&cfg.webBranch, "web", "", "source branch to resolve to an exact commit")
	cmd.Flags().StringVar(&cfg.webRepo, "web-repo", defaultWebRepo, "source repo slug, URL, or local path")
	cmd.Flags().StringVar(&cfg.bucket, "bucket", "", "destination gs:// bucket or local directory (required)")
	cmd.Flags().StringVar(&cfg.tmpBase, "tmpdir", os.TempDir(), "base temporary directory")
	cmd.Flags().StringVar(&revision, "build-revision", "1", "declarative rebuild revision; change to rebuild unchanged sources")
	cmd.Flags().BoolVar(&cfg.dryRun, "dry-run", false, "resolve and check desired state without building or uploading")
	cmd.Flags().StringVar(&validatedCommit, "validated-commit", "", "exact source commit whose release acceptance checks passed")
	cmd.Flags().BoolVar(&publish, "publish-channels", false, "publish eligible runtime manifest, channels and root loader")
	cmd.Flags().BoolVar(&followStable, "stable-follow-latest", true, "advance stable with latest; disable to retain the stable pointer")
	_ = cmd.MarkFlagRequired("web")
	_ = cmd.MarkFlagRequired("bucket")
	return cmd
}

// resolveBuildInputs fingerprints the actual releaser binary and tool versions.
// Only public VITE configuration is recorded, never credentials or arbitrary env.
func resolveBuildInputs(ctx context.Context, cfg config, source repoSource, sha, revision string) (buildInputs, error) {
	executable, err := os.Executable()
	if err != nil {
		return buildInputs{}, err
	}
	binary, err := hashArchiveFile(executable, "releaser")
	if err != nil {
		return buildInputs{}, err
	}
	node, err := runCmdOutput(ctx, "", nil, "node", "--version")
	if err != nil {
		return buildInputs{}, err
	}
	pnpm, err := runCmdOutput(ctx, "", nil, "pnpm", "--version")
	if err != nil {
		return buildInputs{}, err
	}
	public := map[string]string{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "VITE_") && !(strings.HasPrefix(name, "VITE_RUNME_VERSION_") || name == "VITE_RUNME_RELEASE_ID") {
			public[name] = value
		}
	}
	return buildInputs{Format: 1, WebRepo: source.identity, WebCommit: sha, WebBranch: cfg.webBranch, Bucket: cfg.bucket,
		BuilderSHA256: binary.SHA256, NodeVersion: strings.TrimSpace(string(node)), PNPMVersion: strings.TrimSpace(string(pnpm)),
		Platform: runtime.GOOS + "/" + runtime.GOARCH, BuildRevision: revision, PublicEnv: public}, nil
}

// runReconcile resolves desired identity before cloning or invoking the build.
func runReconcile(ctx context.Context, cfg config, revision string, out io.Writer) error {
	source, err := resolveRepoSource(cfg.webRepo)
	if err != nil {
		return err
	}
	sha, err := gitRemoteBranchHead(ctx, source.cloneSource, cfg.webBranch)
	if err != nil {
		return err
	}
	inputs, err := resolveBuildInputs(ctx, cfg, source, sha, revision)
	if err != nil {
		return err
	}
	return buildResolvedArchive(ctx, cfg, source, inputs, out)
}

// Build exactly the declared source; resolving the branch a second time would
// race a new commit and publish different inputs than those checked above.
func buildResolvedArchive(ctx context.Context, cfg config, source repoSource, inputs buildInputs, out io.Writer) error {
	var err error
	sha := inputs.WebCommit
	var workDir string
	defer func() {
		if workDir != "" {
			_ = os.RemoveAll(workDir)
		}
	}()
	return ensureBuildArchive(ctx, inputs, cfg.dryRun, out, func() (string, error) {
		workDir, err = os.MkdirTemp(cfg.tmpBase, "runme-reconcile-")
		if err != nil {
			return "", err
		}
		webDir := filepath.Join(workDir, "web")
		if err := gitCloneAndCheckout(ctx, webDir, source.cloneSource, cfg.webBranch, sha); err != nil {
			return "", err
		}
		// Corepack may select a repository-specific pnpm version after checkout.
		// Reject a mismatch instead of publishing under the wrong toolchain identity.
		actualPNPM, err := runCmdOutput(ctx, webDir, nil, "pnpm", "--version")
		if err != nil {
			return "", err
		}
		if strings.TrimSpace(string(actualPNPM)) != inputs.PNPMVersion {
			return "", fmt.Errorf("checkout selects pnpm %s; configure that version before reconciling", strings.TrimSpace(string(actualPNPM)))
		}
		// Commit time is stable across retries, unlike time.Now().
		date, err := runCmdOutput(ctx, webDir, nil, "git", "show", "-s", "--format=%cI", sha)
		if err != nil {
			return "", err
		}
		version := releaseVersion{BuildDate: strings.TrimSpace(string(date)), WebRepo: inputs.WebRepo, WebBranch: inputs.WebBranch, WebCommit: sha, Bucket: inputs.Bucket}
		env := declarativeBuildEnv(inputs, version)
		for _, args := range [][]string{{"install", "--frozen-lockfile"}, {"run", "build:renderers"}, {"run", "build:console"}, {"run", "build:app"}} {
			if err := runCmd(ctx, webDir, env, "pnpm", args...); err != nil {
				return "", err
			}
		}
		dist := filepath.Join(webDir, "app", "dist")
		if err := writeVersionYAML(dist, version); err != nil {
			return "", err
		}
		// Test a frozen snapshot. The driver builds other fixtures in app/dist,
		// so publishing that mutable directory would publish untested bytes.
		candidate := filepath.Join(workDir, "candidate")
		if _, err := snapshotArchive(dist, candidate); err != nil {
			return "", err
		}
		buildID, _ := inputs.id()
		receipt := releaseAcceptance{1, sha + "-" + buildID, "controlled-releases-v1"}
		raw, err := json.Marshal(receipt)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(candidate, "release-acceptance.json"), raw, 0644); err != nil {
			return "", err
		}
		testEnv := append(append([]string{}, env...), "RUNME_RELEASE_CANDIDATE="+candidate)
		if chromium := os.Getenv("CHROMIUM_PATH"); chromium != "" {
			testEnv = append(testEnv, "CHROMIUM_PATH="+chromium)
		}
		if err := runCmd(ctx, webDir, testEnv, "pnpm", "-C", "app", "run", "cuj:releases"); err != nil {
			return "", fmt.Errorf("candidate acceptance failed; nothing published: %w", err)
		}
		return candidate, nil
	})
}

// declarativeBuildEnv excludes ambient build switches such as NODE_OPTIONS and
// CI run metadata. Retained auth/proxy settings permit dependency installation;
// the frozen lockfile supplies dependency identity. This is not a hermetic build.
func declarativeBuildEnv(inputs buildInputs, version releaseVersion) []string {
	env := []string{"CI=true", "TZ=UTC"}
	for _, name := range []string{"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "NPM_TOKEN", "NODE_AUTH_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"} {
		if value, ok := os.LookupEnv(name); ok {
			env = append(env, name+"="+value)
		}
	}
	for name, value := range inputs.PublicEnv {
		env = append(env, name+"="+value)
	}
	buildID, _ := inputs.id()
	env = append(env, "VITE_RUNME_RELEASE_ID="+inputs.WebCommit+"-"+buildID)
	return append(env, versionBuildEnv(version)...)
}

// ensureBuildArchive reconciles desired identity against a fully verified archive.
// The callback must not run on a completed release or on a read/validation error.
func ensureBuildArchive(ctx context.Context, inputs buildInputs, dryRun bool, out io.Writer, build func() (string, error)) error {
	if strings.ContainsAny(inputs.Bucket, "*?[]#\r\n") || (strings.Contains(inputs.Bucket, "://") && !strings.HasPrefix(inputs.Bucket, "gs://")) {
		return errors.New("expected a literal gs:// bucket/prefix or local directory")
	}
	buildID, err := inputs.id()
	if err != nil {
		return err
	}
	releaseID := inputs.WebCommit + "-" + buildID
	exists, err := verifyBuildArchive(ctx, inputs, releaseID)
	if err != nil {
		return err
	}
	if exists {
		fmt.Fprintf(out, "release archive already complete: %s\n", releaseID)
		return nil
	}
	if dryRun {
		fmt.Fprintf(out, "would build and archive %s\n", releaseID)
		return nil
	}
	dist, err := build()
	if err != nil {
		return err
	}
	return runArchive(ctx, archiveConfig{dist: dist, bucket: inputs.Bucket, inputs: &inputs}, out)
}

// verifyBuildArchive treats only a missing manifest as absent. Corruption and
// permission errors fail closed, rather than triggering a rebuild or overwrite.
func verifyBuildArchive(ctx context.Context, inputs buildInputs, releaseID string) (bool, error) {
	prefix := "version/" + releaseID + "/"
	location := destinationURL(inputs.Bucket, prefix+archiveManifestName)
	var data []byte
	var err error
	if strings.HasPrefix(inputs.Bucket, "gs://") {
		data, err = runCmdOutput(ctx, "", nil, "gcloud", "storage", "cat", location)
		if err != nil && isMissingVersionMarkerError(err) {
			return false, nil
		}
	} else {
		data, err = os.ReadFile(location)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
	}
	if err != nil {
		return false, err
	}
	var manifest releaseArchive
	if err := json.Unmarshal(data, &manifest); err != nil {
		return false, err
	}
	want, _ := json.Marshal(inputs)
	got, _ := json.Marshal(manifest.BuildInputs)
	buildID, _ := inputs.id()
	if manifest.Format != 1 || manifest.Kind != "runme-build-archive" || manifest.ReleaseID != releaseID || manifest.WebCommit != inputs.WebCommit || manifest.BuildID != buildID || !bytes.Equal(want, got) || len(manifest.Assets) == 0 {
		return false, errors.New("published archive does not match desired build inputs")
	}
	inventory, _ := json.Marshal(manifest.Assets)
	digest := sha256.Sum256(inventory)
	if manifest.ArtifactDigest != hex.EncodeToString(digest[:]) {
		return false, errors.New("invalid archive inventory digest")
	}
	seen := map[string]bool{}
	previous := ""
	for _, asset := range manifest.Assets {
		if !validArchivePath(asset.Path) || asset.Path <= previous || asset.Path == archiveManifestName || asset.Path == "release.json" || !validDigest(asset.SHA256) || asset.Bytes < 0 {
			return false, errors.New("invalid archive asset inventory")
		}
		previous, seen[asset.Path] = asset.Path, true
	}
	if !seen["index.html"] || !seen[versionFileName] {
		return false, errors.New("archive missing required assets")
	}
	manifestHash := sha256.Sum256(data)
	assets := append(append([]archiveAsset{}, manifest.Assets...), archiveAsset{Path: archiveManifestName, SHA256: hex.EncodeToString(manifestHash[:]), Bytes: int64(len(data))})
	for _, asset := range assets {
		location := destinationURL(inputs.Bucket, prefix+asset.Path)
		if strings.HasPrefix(inputs.Bucket, "gs://") {
			if err := verifyGCSArchiveAsset(ctx, location, asset); err != nil {
				return false, err
			}
		} else {
			actual, err := hashArchiveFile(location, asset.Path)
			if err != nil {
				return false, err
			}
			if actual != asset {
				return false, fmt.Errorf("immutable object differs: %s", location)
			}
		}
	}
	return true, nil
}

// Resolve once for publication; a concurrent source advance is rejected.
func reconcileRuntime(ctx context.Context, cfg config, revision string, followStable bool, validatedCommit string, out io.Writer) error {
	source, err := resolveRepoSource(cfg.webRepo)
	if err != nil {
		return err
	}
	sha, err := gitRemoteBranchHead(ctx, source.cloneSource, cfg.webBranch)
	if err != nil {
		return err
	}
	if !cfg.dryRun && sha != validatedCommit {
		return errors.New("source advanced beyond the validated commit; refusing publication")
	}
	inputs, err := resolveBuildInputs(ctx, cfg, source, sha, revision)
	if err != nil {
		return err
	}
	if err = buildResolvedArchive(ctx, cfg, source, inputs, out); err != nil {
		return err
	}
	if cfg.dryRun {
		return nil
	}
	return publishRuntime(ctx, inputs, followStable, out)
}
