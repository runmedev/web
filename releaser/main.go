package main

import (
	"bytes"
	"context"
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
	"time"

	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

const (
	defaultWebRepo     = "runmedev/web"
	defaultCodexRepo   = "openai/codex"
	defaultCodexBranch = "dev/jlewi/wasm"
	defaultBucket      = "gs://runme-hosted"
	shortSHALen        = 8
	versionFileName    = "version.yaml"
)

var hashedAssetPattern = regexp.MustCompile(`\.[A-Za-z0-9_-]{8,}\.[^.]+$`)

type config struct {
	webBranch string

	codexBranch string

	webRepo   string
	codexRepo string
	bucket    string

	dryRun bool

	tmpBase string
}

type repoSource struct {
	identity    string
	cloneSource string
}

type releaseVersion struct {
	BuildDate   string `yaml:"buildDate"`
	WebRepo     string `yaml:"webRepo"`
	WebBranch   string `yaml:"webBranch"`
	WebCommit   string `yaml:"webCommit"`
	CodexRepo   string `yaml:"codexRepo"`
	CodexBranch string `yaml:"codexBranch"`
	CodexCommit string `yaml:"codexCommit"`
	Bucket      string `yaml:"bucket"`
}

type publishFile struct {
	src          string
	dst          string
	cacheControl string
	group        int
}

func main() {
	if err := newRootCmd().ExecuteContext(context.Background()); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
		os.Exit(1)
	}
}

func newRootCmd() *cobra.Command {
	cfg := config{}
	cmd := &cobra.Command{
		Use:   "releaser --web=<branch>",
		Short: "Build and publish web.runme.dev static assets",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run(cmd.Context(), cfg)
		},
	}

	cmd.Flags().StringVar(&cfg.webBranch, "web", "", "branch name in the web repo")
	cmd.Flags().StringVar(&cfg.codexBranch, "codex", defaultCodexBranch, "branch name in the codex repo")
	cmd.Flags().StringVar(&cfg.webRepo, "web-repo", defaultWebRepo, "web repo slug, URL, or local path")
	cmd.Flags().StringVar(&cfg.codexRepo, "codex-repo", defaultCodexRepo, "codex repo slug, URL, or local path")
	cmd.Flags().StringVar(&cfg.bucket, "bucket", defaultBucket, "destination bucket URL (gs://...) or local directory")
	cmd.Flags().BoolVar(&cfg.dryRun, "dry-run", false, "build and evaluate publish state without uploading")
	cmd.Flags().StringVar(&cfg.tmpBase, "tmpdir", os.TempDir(), "base temporary directory")
	_ = cmd.MarkFlagRequired("web")

	return cmd
}

func run(ctx context.Context, cfg config) error {
	webSource, err := resolveRepoSource(cfg.webRepo)
	if err != nil {
		return fmt.Errorf("resolve --web-repo: %w", err)
	}
	codexSource, err := resolveRepoSource(cfg.codexRepo)
	if err != nil {
		return fmt.Errorf("resolve --codex-repo: %w", err)
	}

	webSHA, err := gitRemoteBranchHead(ctx, webSource.cloneSource, cfg.webBranch)
	if err != nil {
		return fmt.Errorf("resolve web branch head: %w", err)
	}
	codexSHA, err := gitRemoteBranchHead(ctx, codexSource.cloneSource, cfg.codexBranch)
	if err != nil {
		return fmt.Errorf("resolve codex branch head: %w", err)
	}

	version := releaseVersion{
		BuildDate:   time.Now().Format(time.RFC3339),
		WebRepo:     webSource.identity,
		WebBranch:   cfg.webBranch,
		WebCommit:   webSHA,
		CodexRepo:   codexSource.identity,
		CodexBranch: cfg.codexBranch,
		CodexCommit: codexSHA,
		Bucket:      cfg.bucket,
	}

	current, exists, err := readVersion(ctx, cfg.bucket)
	if err != nil {
		return fmt.Errorf("read current version marker: %w", err)
	}
	if exists && versionMatches(version, current) {
		if cfg.dryRun {
			fmt.Printf("release already current (continuing due to dry-run): web=%s codex=%s bucket=%s\n", shortSHA(webSHA, shortSHALen), shortSHA(codexSHA, shortSHALen), cfg.bucket)
		} else {
			fmt.Printf("release already current: web=%s codex=%s bucket=%s\n", shortSHA(webSHA, shortSHALen), shortSHA(codexSHA, shortSHALen), cfg.bucket)
			return nil
		}
	}

	workDir := filepath.Join(cfg.tmpBase, fmt.Sprintf("web-%s-codex-%s", shortSHA(webSHA, shortSHALen), shortSHA(codexSHA, shortSHALen)))
	if err := os.RemoveAll(workDir); err != nil {
		return fmt.Errorf("clean working directory: %w", err)
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return fmt.Errorf("create working directory: %w", err)
	}
	fmt.Printf("working directory: %s\n", workDir)

	webDir := filepath.Join(workDir, "web")
	codexDir := filepath.Join(workDir, "codex")

	if err := gitCloneAndCheckout(ctx, webDir, webSource.cloneSource, cfg.webBranch, webSHA); err != nil {
		return fmt.Errorf("clone web repository: %w", err)
	}
	if err := gitCloneAndCheckout(ctx, codexDir, codexSource.cloneSource, cfg.codexBranch, codexSHA); err != nil {
		return fmt.Errorf("clone codex repository: %w", err)
	}

	if err := buildReleasePayload(ctx, webDir, codexDir); err != nil {
		return err
	}

	distDir := filepath.Join(webDir, "app", "dist")
	if err := assertDir(distDir); err != nil {
		return fmt.Errorf("validate build output: %w", err)
	}
	if err := assertFile(filepath.Join(distDir, "index.html")); err != nil {
		return fmt.Errorf("validate index.html: %w", err)
	}
	if err := assertFile(filepath.Join(distDir, "generated", "codex-wasm", "codex_wasm_harness.js")); err != nil {
		return fmt.Errorf("validate codex wasm JS asset: %w", err)
	}
	if err := assertFile(filepath.Join(distDir, "generated", "codex-wasm", "codex_wasm_harness_bg.wasm")); err != nil {
		return fmt.Errorf("validate codex wasm WASM asset: %w", err)
	}

	if err := writeVersionYAML(distDir, version); err != nil {
		return fmt.Errorf("write version file: %w", err)
	}

	files, err := collectPublishFiles(distDir)
	if err != nil {
		return fmt.Errorf("collect publish files: %w", err)
	}

	if cfg.dryRun {
		fmt.Printf("dry-run complete; would publish %d files to %s\n", len(files), cfg.bucket)
		for _, file := range files {
			fmt.Printf("  %s -> %s [%s]\n", file.src, destinationURL(cfg.bucket, file.dst), file.cacheControl)
		}
		return nil
	}

	for _, file := range files {
		if err := uploadFile(ctx, cfg.bucket, file); err != nil {
			return fmt.Errorf("upload %s: %w", file.dst, err)
		}
	}

	fmt.Printf("published %d files to %s\n", len(files), cfg.bucket)
	return nil
}

func buildReleasePayload(ctx context.Context, webDir, codexDir string) error {
	for _, cmdline := range []string{
		"pnpm install --frozen-lockfile",
		"pnpm run build:renderers",
	} {
		if err := runShell(ctx, webDir, nil, cmdline); err != nil {
			return fmt.Errorf("build web prerequisites (%q): %w", cmdline, err)
		}
	}

	if err := runCmd(ctx, codexDir, nil, "rustup", "target", "add", "wasm32-unknown-unknown"); err != nil {
		return fmt.Errorf("ensure wasm target: %w", err)
	}

	wasmHarnessDir := filepath.Join(codexDir, "codex-rs", "wasm-harness")
	if err := runShell(ctx, wasmHarnessDir, nil, "./scripts/build-browser-demo.sh"); err != nil {
		return fmt.Errorf("build codex wasm harness: %w", err)
	}

	wasmPkgDir := filepath.Join(wasmHarnessDir, "examples", "pkg")
	syncEnv := append(os.Environ(), "CODEX_WASM_PKG_DIR="+wasmPkgDir)
	if err := runShell(ctx, filepath.Join(webDir, "app"), syncEnv, "pnpm run sync:codex-wasm"); err != nil {
		return fmt.Errorf("sync codex wasm assets: %w", err)
	}

	if err := runShell(ctx, webDir, nil, "pnpm build:app"); err != nil {
		return fmt.Errorf("build web app: %w", err)
	}

	return nil
}

func collectPublishFiles(distDir string) ([]publishFile, error) {
	files := []publishFile{}
	err := filepath.WalkDir(distDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}

		rel, err := filepath.Rel(distDir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)

		cacheControl, group := classifyFile(rel)
		files = append(files, publishFile{
			src:          path,
			dst:          rel,
			cacheControl: cacheControl,
			group:        group,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Slice(files, func(i, j int) bool {
		if files[i].group == files[j].group {
			return files[i].dst < files[j].dst
		}
		return files[i].group < files[j].group
	})

	return files, nil
}

func classifyFile(rel string) (string, int) {
	name := filepath.Base(rel)
	switch {
	case rel == versionFileName:
		return "no-cache, max-age=0, must-revalidate", 3
	case rel == "index.html":
		return "no-cache, max-age=0, must-revalidate", 2
	case hashedAssetPattern.MatchString(name):
		return "public, max-age=31536000, immutable", 0
	default:
		return "no-cache, max-age=0, must-revalidate", 1
	}
}

func uploadFile(ctx context.Context, bucket string, file publishFile) error {
	if strings.HasPrefix(bucket, "gs://") {
		return runCmd(
			ctx,
			"",
			nil,
			"gcloud",
			"storage",
			"cp",
			"--cache-control="+file.cacheControl,
			file.src,
			destinationURL(bucket, file.dst),
		)
	}

	target := destinationURL(bucket, file.dst)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return copyFile(file.src, target)
}

func readVersion(ctx context.Context, bucket string) (releaseVersion, bool, error) {
	if strings.HasPrefix(bucket, "gs://") {
		out, err := runCmdOutput(ctx, "", nil, "gcloud", "storage", "cat", destinationURL(bucket, versionFileName))
		if err != nil {
			if strings.Contains(err.Error(), "No URLs matched") || strings.Contains(err.Error(), "404") {
				return releaseVersion{}, false, nil
			}
			return releaseVersion{}, false, err
		}
		return parseVersionYAML(out)
	}

	path := destinationURL(bucket, versionFileName)
	content, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return releaseVersion{}, false, nil
		}
		return releaseVersion{}, false, err
	}
	return parseVersionYAML(content)
}

func parseVersionYAML(content []byte) (releaseVersion, bool, error) {
	var version releaseVersion
	if err := yaml.Unmarshal(content, &version); err != nil {
		return releaseVersion{}, false, err
	}
	return version, true, nil
}

func writeVersionYAML(distDir string, version releaseVersion) error {
	content, err := yaml.Marshal(version)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(distDir, versionFileName), content, 0o644)
}

func versionMatches(desired, current releaseVersion) bool {
	return desired.WebRepo == current.WebRepo &&
		desired.WebBranch == current.WebBranch &&
		desired.WebCommit == current.WebCommit &&
		desired.CodexRepo == current.CodexRepo &&
		desired.CodexBranch == current.CodexBranch &&
		desired.CodexCommit == current.CodexCommit &&
		desired.Bucket == current.Bucket
}

func resolveRepoSource(value string) (repoSource, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return repoSource{}, errors.New("empty repo")
	}

	if strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "ssh://") || strings.HasPrefix(value, "git@") || strings.HasPrefix(value, "file://") {
		return repoSource{identity: value, cloneSource: value}, nil
	}

	if _, err := os.Stat(value); err == nil {
		abs, err := filepath.Abs(value)
		if err != nil {
			return repoSource{}, err
		}
		return repoSource{identity: abs, cloneSource: abs}, nil
	}

	if isGitHubSlug(value) {
		return repoSource{
			identity:    value,
			cloneSource: "https://github.com/" + value + ".git",
		}, nil
	}

	return repoSource{}, fmt.Errorf("unsupported repo value %q", value)
}

func isGitHubSlug(value string) bool {
	parts := strings.Split(value, "/")
	return len(parts) == 2 && parts[0] != "" && parts[1] != ""
}

func gitRemoteBranchHead(ctx context.Context, repo, branch string) (string, error) {
	out, err := runCmdOutput(ctx, "", nil, "git", "ls-remote", repo, "refs/heads/"+branch)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(out))
	if line == "" {
		return "", fmt.Errorf("branch %q not found in %s", branch, repo)
	}

	fields := strings.Fields(line)
	if len(fields) < 1 || fields[0] == "" {
		return "", fmt.Errorf("unexpected git ls-remote output for %s %s: %q", repo, branch, line)
	}
	return fields[0], nil
}

func gitCloneAndCheckout(ctx context.Context, dst, repo, branch, sha string) error {
	cloneSource := repo
	if isLocalPath(repo) {
		cloneSource = "file://" + filepath.ToSlash(repo)
	}
	if err := runCmd(ctx, "", nil, "git", "clone", "--depth", "1", "--branch", branch, cloneSource, dst); err != nil {
		return err
	}
	return runCmd(ctx, dst, nil, "git", "checkout", sha)
}

func destinationURL(bucket, rel string) string {
	rel = filepath.ToSlash(rel)
	if strings.HasPrefix(bucket, "gs://") {
		return strings.TrimRight(bucket, "/") + "/" + strings.TrimLeft(rel, "/")
	}
	return filepath.Join(bucket, filepath.FromSlash(rel))
}

func runShell(ctx context.Context, dir string, env []string, command string) error {
	return runCmd(ctx, dir, env, "/bin/sh", "-lc", command)
}

func runCmd(ctx context.Context, dir string, env []string, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(env) > 0 {
		cmd.Env = env
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func runCmdOutput(ctx context.Context, dir string, env []string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	if len(env) > 0 {
		cmd.Env = env
	}
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if stderr.Len() == 0 {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(stderr.String()))
	}
	return stdout.Bytes(), nil
}

func assertDir(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("not a directory: %s", path)
	}
	return nil
}

func assertFile(path string) error {
	st, err := os.Stat(path)
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fmt.Errorf("not a file: %s", path)
	}
	return nil
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	info, err := in.Stat()
	if err != nil {
		return err
	}

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
	if err != nil {
		return err
	}

	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func isLocalPath(value string) bool {
	if value == "" {
		return false
	}
	if strings.HasPrefix(value, "file://") {
		return false
	}
	if filepath.IsAbs(value) {
		return true
	}
	if strings.HasPrefix(value, ".") {
		return true
	}
	_, err := os.Stat(value)
	return err == nil
}

func shortSHA(sha string, n int) string {
	sha = strings.TrimSpace(sha)
	if n <= 0 || len(sha) <= n {
		return sha
	}
	return sha[:n]
}
