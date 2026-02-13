package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

const (
	githubAPI        = "https://api.github.com"
	defaultRunmeRepo = "runmedev/runme"
	defaultWebRepo   = "runmedev/web"
	shortSHALen      = 8
)

type config struct {
	runmeBranch string
	webBranch   string

	runmeRepo string
	webRepo   string

	runmeAssetsDir string

	tmpBase string
}

type githubBranchResponse struct {
	Commit struct {
		SHA string `json:"sha"`
	} `json:"commit"`
}

type registryAuthChallenge struct {
	Realm   string
	Service string
	Scope   string
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
		Use:   "releaser --runme=<branch> --web=<branch>",
		Short: "Build and publish runme image with embedded web static assets",
		RunE: func(cmd *cobra.Command, args []string) error {
			return run(cmd.Context(), cfg)
		},
	}

	cmd.Flags().StringVar(&cfg.runmeBranch, "runme", "", "branch name in runmedev/runme")
	cmd.Flags().StringVar(&cfg.webBranch, "web", "", "branch name in runmedev/web")
	cmd.Flags().StringVar(&cfg.runmeRepo, "runme-repo", defaultRunmeRepo, "GitHub repo in org/repo format")
	cmd.Flags().StringVar(&cfg.webRepo, "web-repo", defaultWebRepo, "GitHub repo in org/repo format")
	cmd.Flags().StringVar(&cfg.runmeAssetsDir, "runme-assets-dir", "", "relative path in runme repo to copy web assets into (auto-detected when empty)")
	cmd.Flags().StringVar(&cfg.tmpBase, "tmpdir", os.TempDir(), "base temporary directory")
	_ = cmd.MarkFlagRequired("runme")
	_ = cmd.MarkFlagRequired("web")

	return cmd
}

func run(ctx context.Context, cfg config) error {
	httpClient := &http.Client{Timeout: 30 * time.Second}
	ghToken := firstNonEmpty(os.Getenv("GITHUB_TOKEN"), os.Getenv("GH_TOKEN"))

	runmeOwner, runmeRepoName, err := parseGitHubRepo(cfg.runmeRepo)
	if err != nil {
		return fmt.Errorf("invalid --runme-repo: %w", err)
	}
	webOwner, webRepoName, err := parseGitHubRepo(cfg.webRepo)
	if err != nil {
		return fmt.Errorf("invalid --web-repo: %w", err)
	}

	runmeSHA, err := githubBranchHead(ctx, httpClient, runmeOwner, runmeRepoName, cfg.runmeBranch, ghToken)
	if err != nil {
		return fmt.Errorf("resolve runme branch head: %w", err)
	}
	webSHA, err := githubBranchHead(ctx, httpClient, webOwner, webRepoName, cfg.webBranch, ghToken)
	if err != nil {
		return fmt.Errorf("resolve web branch head: %w", err)
	}

	tag := fmt.Sprintf("runme-%s-web-%s", shortSHA(runmeSHA, shortSHALen), shortSHA(webSHA, shortSHALen))
	ghcrRepoRef := "ghcr.io/" + cfg.runmeRepo
	imageRef := fmt.Sprintf("%s:%s", ghcrRepoRef, tag)

	registryUser, registryToken := registryCredentials()
	exists, err := imageExists(ctx, httpClient, cfg.runmeRepo, tag, registryUser, registryToken)
	if err != nil {
		return fmt.Errorf("check image existence: %w", err)
	}
	if exists {
		fmt.Printf("image already exists: %s\n", imageRef)
		return nil
	}

	workDir := filepath.Join(cfg.tmpBase, fmt.Sprintf("runme-%s-web-%s", runmeSHA, webSHA))
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		return fmt.Errorf("create working directory: %w", err)
	}
	fmt.Printf("working directory: %s\n", workDir)

	runmeDir := filepath.Join(workDir, "runme")
	webDir := filepath.Join(workDir, "web")

	if err := gitCloneAndCheckout(ctx, runmeDir, runmeOwner, runmeRepoName, cfg.runmeBranch, runmeSHA); err != nil {
		return fmt.Errorf("clone runme repository: %w", err)
	}
	if err := gitCloneAndCheckout(ctx, webDir, webOwner, webRepoName, cfg.webBranch, webSHA); err != nil {
		return fmt.Errorf("clone web repository: %w", err)
	}

	for _, cmdline := range []string{
		"pnpm install --frozen-lockfile",
		"pnpm -C app run build",
	} {
		if err := runShell(ctx, webDir, nil, cmdline); err != nil {
			return fmt.Errorf("build web static assets (%q): %w", cmdline, err)
		}
	}

	srcAssets := filepath.Join(webDir, "app", "dist")
	if err := assertDir(srcAssets); err != nil {
		return fmt.Errorf("validate built web assets: %w", err)
	}

	destRel := cfg.runmeAssetsDir
	if destRel == "" {
		destRel, err = detectRunmeAssetsDir(runmeDir)
		if err != nil {
			return fmt.Errorf("detect runme static assets path (set --runme-assets-dir to override): %w", err)
		}
	}
	destAssets := filepath.Join(runmeDir, filepath.Clean(destRel))
	fmt.Printf("copying assets: %s -> %s\n", srcAssets, destAssets)
	if err := replaceDirContents(srcAssets, destAssets); err != nil {
		return fmt.Errorf("copy web assets into runme repo: %w", err)
	}
	if err := writeVersionYAML(destAssets, runmeSHA, cfg.runmeBranch, webSHA, cfg.webBranch); err != nil {
		return fmt.Errorf("write version file: %w", err)
	}

	koEnv, cleanup, err := koEnv(ghcrRepoRef, registryUser, registryToken)
	if err != nil {
		return fmt.Errorf("prepare ko auth env: %w", err)
	}
	defer cleanup()

	koArgs := []string{"build", "./", "--bare", "--platform=linux/amd64,linux/arm64", "--tags", tag, "--sbom=none"}
	if err := runCmd(ctx, runmeDir, mergeEnv(os.Environ(), koEnv), "ko", koArgs...); err != nil {
		return fmt.Errorf("publish multi-arch image with ko: %w", err)
	}

	fmt.Printf("published image: %s\n", imageRef)
	return nil
}

func githubBranchHead(ctx context.Context, client *http.Client, owner, repo, branch, token string) (string, error) {
	u := fmt.Sprintf("%s/repos/%s/%s/branches/%s", githubAPI, owner, repo, url.PathEscape(branch))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return "", fmt.Errorf("github branches API %s returned %d: %s", u, resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var payload githubBranchResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	if payload.Commit.SHA == "" {
		return "", errors.New("empty commit sha from github API")
	}
	return payload.Commit.SHA, nil
}

func imageExists(ctx context.Context, client *http.Client, repo, tag, user, token string) (bool, error) {
	manifestURL := fmt.Sprintf("https://ghcr.io/v2/%s/manifests/%s", repo, tag)
	challenge, status, err := headManifest(ctx, client, manifestURL, "")
	if err != nil {
		return false, err
	}
	switch status {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	case http.StatusUnauthorized:
		if challenge == nil {
			return false, errors.New("received 401 from ghcr without auth challenge")
		}
		bearer, err := fetchRegistryBearer(ctx, client, *challenge, user, token)
		if err != nil {
			return false, err
		}
		_, status, err = headManifest(ctx, client, manifestURL, bearer)
		if err != nil {
			return false, err
		}
		if status == http.StatusOK {
			return true, nil
		}
		if status == http.StatusNotFound {
			return false, nil
		}
		return false, fmt.Errorf("unexpected ghcr manifest response status %d", status)
	default:
		return false, fmt.Errorf("unexpected ghcr manifest response status %d", status)
	}
}

func headManifest(ctx context.Context, client *http.Client, manifestURL, bearer string) (*registryAuthChallenge, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, manifestURL, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", strings.Join([]string{
		"application/vnd.oci.image.index.v1+json",
		"application/vnd.docker.distribution.manifest.list.v2+json",
		"application/vnd.oci.image.manifest.v1+json",
		"application/vnd.docker.distribution.manifest.v2+json",
	}, ","))
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		challenge := parseWWWAuthenticate(resp.Header.Get("Www-Authenticate"))
		return challenge, resp.StatusCode, nil
	}
	return nil, resp.StatusCode, nil
}

func fetchRegistryBearer(ctx context.Context, client *http.Client, c registryAuthChallenge, user, token string) (string, error) {
	if c.Realm == "" {
		return "", errors.New("empty auth realm")
	}
	u, err := url.Parse(c.Realm)
	if err != nil {
		return "", err
	}
	q := u.Query()
	if c.Service != "" {
		q.Set("service", c.Service)
	}
	if c.Scope != "" {
		q.Set("scope", c.Scope)
	}
	u.RawQuery = q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	if token != "" {
		req.SetBasicAuth(firstNonEmpty(user, "oauth2"), token)
	}

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
		return "", fmt.Errorf("ghcr token service returned %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var body struct {
		Token       string `json:"token"`
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	out := firstNonEmpty(body.Token, body.AccessToken)
	if out == "" {
		return "", errors.New("token service returned empty token")
	}
	return out, nil
}

func parseWWWAuthenticate(h string) *registryAuthChallenge {
	h = strings.TrimSpace(h)
	if !strings.HasPrefix(strings.ToLower(h), "bearer ") {
		return nil
	}
	params := strings.TrimSpace(h[len("Bearer "):])
	re := regexp.MustCompile(`(\w+)="([^"]*)"`)
	matches := re.FindAllStringSubmatch(params, -1)
	if len(matches) == 0 {
		return nil
	}
	out := &registryAuthChallenge{}
	for _, m := range matches {
		switch strings.ToLower(m[1]) {
		case "realm":
			out.Realm = m[2]
		case "service":
			out.Service = m[2]
		case "scope":
			out.Scope = m[2]
		}
	}
	return out
}

func gitCloneAndCheckout(ctx context.Context, dst, owner, repo, branch, sha string) error {
	repoURL := fmt.Sprintf("https://github.com/%s/%s.git", owner, repo)
	if err := runCmd(ctx, "", nil, "git", "clone", "--depth", "1", "--branch", branch, repoURL, dst); err != nil {
		return err
	}
	return runCmd(ctx, dst, nil, "git", "checkout", sha)
}

func detectRunmeAssetsDir(runmeDir string) (string, error) {
	if fromWorkflow := detectFromWorkflowFiles(runmeDir); fromWorkflow != "" {
		return fromWorkflow, nil
	}
	if fromEmbed := detectFromEmbedPatterns(runmeDir); fromEmbed != "" {
		return fromEmbed, nil
	}

	candidates := []string{
		"assets",
		"web/assets",
		"web/dist",
		"pkg/web/assets",
		"pkg/web/dist",
		"internal/web/assets",
		"internal/web/dist",
	}
	for _, rel := range candidates {
		if dirExists(filepath.Join(runmeDir, rel)) {
			return rel, nil
		}
	}
	return "", errors.New("unable to infer destination for static assets")
}

func detectFromWorkflowFiles(runmeDir string) string {
	workflowDir := filepath.Join(runmeDir, ".github", "workflows")
	entries, err := os.ReadDir(workflowDir)
	if err != nil {
		return ""
	}

	dests := map[string]struct{}{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || (!strings.HasSuffix(name, ".yml") && !strings.HasSuffix(name, ".yaml")) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(workflowDir, name))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(content), "\n") {
			if !strings.Contains(line, "app/dist") {
				continue
			}
			if rel := extractDestinationPath(line); rel != "" {
				dests[rel] = struct{}{}
			}
		}
	}

	if len(dests) == 1 {
		for k := range dests {
			return k
		}
	}
	return ""
}

func detectFromEmbedPatterns(runmeDir string) string {
	type dirScore struct {
		dir   string
		score int
	}
	scores := map[string]int{}
	err := filepath.WalkDir(runmeDir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if strings.Contains(path, "/.git") || strings.Contains(path, "/vendor") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		for _, line := range strings.Split(string(b), "\n") {
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "//go:embed ") {
				continue
			}
			patterns := strings.Fields(strings.TrimPrefix(line, "//go:embed "))
			for _, p := range patterns {
				if !strings.Contains(p, "assets") && !strings.Contains(p, "dist") && !strings.Contains(p, "web") {
					continue
				}
				p = strings.Trim(p, "\"`")
				abs := filepath.Clean(filepath.Join(filepath.Dir(path), p))
				rel, err := filepath.Rel(runmeDir, abs)
				if err != nil {
					continue
				}
				rel = strings.TrimSuffix(rel, "/*")
				rel = strings.TrimSuffix(rel, "/")
				if rel == "." || strings.HasPrefix(rel, "..") {
					continue
				}
				scores[filepath.ToSlash(rel)]++
			}
		}
		return nil
	})
	if err != nil || len(scores) == 0 {
		return ""
	}

	all := make([]dirScore, 0, len(scores))
	for k, v := range scores {
		all = append(all, dirScore{dir: k, score: v})
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].score == all[j].score {
			return all[i].dir < all[j].dir
		}
		return all[i].score > all[j].score
	})

	return all[0].dir
}

func extractDestinationPath(line string) string {
	line = strings.TrimSpace(line)
	line = strings.ReplaceAll(line, "\t", " ")
	line = strings.ReplaceAll(line, "\"", "")
	line = strings.ReplaceAll(line, "'", "")
	parts := strings.Fields(line)
	if len(parts) < 3 {
		return ""
	}
	last := parts[len(parts)-1]
	last = strings.TrimSuffix(last, "/")
	last = strings.TrimSuffix(last, "/.")

	prefixes := []string{"$RUNME_DIR/", "${RUNME_DIR}/", "$GITHUB_WORKSPACE/", "${GITHUB_WORKSPACE}/runme/", "runme/"}
	for _, p := range prefixes {
		if strings.HasPrefix(last, p) {
			last = strings.TrimPrefix(last, p)
			break
		}
	}
	if last == "" || strings.HasPrefix(last, "$") || strings.Contains(last, "${") {
		return ""
	}
	if strings.HasPrefix(last, "/") {
		return ""
	}
	if strings.HasPrefix(last, "./") {
		last = strings.TrimPrefix(last, "./")
	}
	return filepath.ToSlash(last)
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

func replaceDirContents(src, dst string) error {
	if err := assertDir(src); err != nil {
		return err
	}
	if err := os.MkdirAll(dst, 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(dst)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(dst, e.Name())); err != nil {
			return err
		}
	}
	return copyDir(src, dst)
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}

		info, err := d.Info()
		if err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode())
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		closeErr := out.Close()
		if err != nil {
			return err
		}
		return closeErr
	})
}

func dirExists(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

func registryCredentials() (string, string) {
	user := firstNonEmpty(
		os.Getenv("GHCR_USERNAME"),
		os.Getenv("GITHUB_ACTOR"),
		os.Getenv("GITHUB_REPOSITORY_OWNER"),
	)
	token := firstNonEmpty(
		os.Getenv("GHCR_TOKEN"),
		os.Getenv("CR_PAT"),
		os.Getenv("GITHUB_TOKEN"),
	)
	return user, token
}

func koEnv(ghcrRepoRef, user, token string) ([]string, func(), error) {
	if token == "" {
		return []string{"KO_DOCKER_REPO=" + ghcrRepoRef}, func() {}, nil
	}

	cfgDir, err := os.MkdirTemp("", "releaser-docker-config-")
	if err != nil {
		return nil, nil, err
	}
	cleanup := func() { _ = os.RemoveAll(cfgDir) }

	username := firstNonEmpty(user, "oauth2")
	auth := base64.StdEncoding.EncodeToString([]byte(username + ":" + token))

	content := bytes.NewBuffer(nil)
	fmt.Fprintf(content, "{\n  \"auths\": {\n    \"ghcr.io\": {\n      \"auth\": \"%s\"\n    }\n  }\n}\n", auth)

	if err := os.WriteFile(filepath.Join(cfgDir, "config.json"), content.Bytes(), 0o600); err != nil {
		cleanup()
		return nil, nil, err
	}

	env := []string{
		"KO_DOCKER_REPO=" + ghcrRepoRef,
		"DOCKER_CONFIG=" + cfgDir,
	}
	return env, cleanup, nil
}

func parseGitHubRepo(v string) (string, string, error) {
	v = strings.TrimSpace(v)
	parts := strings.Split(v, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("expected org/repo, got %q", v)
	}
	return parts[0], parts[1], nil
}

func mergeEnv(base, extra []string) []string {
	kv := map[string]string{}
	for _, e := range base {
		if k, v, ok := strings.Cut(e, "="); ok {
			kv[k] = v
		}
	}
	for _, e := range extra {
		if k, v, ok := strings.Cut(e, "="); ok {
			kv[k] = v
		}
	}
	out := make([]string, 0, len(kv))
	for k, v := range kv {
		out = append(out, k+"="+v)
	}
	sort.Strings(out)
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func shortSHA(sha string, n int) string {
	sha = strings.TrimSpace(sha)
	if n <= 0 || len(sha) <= n {
		return sha
	}
	return sha[:n]
}

func writeVersionYAML(assetsDir, runmeSHA, runmeBranch, webSHA, webBranch string) error {
	loc, err := time.LoadLocation("America/Los_Angeles")
	if err != nil {
		return err
	}
	buildDate := time.Now().In(loc).Format("2006-01-02-15:04:05 MST")
	content := fmt.Sprintf(
		"buildDate: %s\nrunmeCommit: %s\nrunmeBranch: %s\nwebCommit: %s\nwebBranch: %s\n",
		buildDate,
		runmeSHA,
		runmeBranch,
		webSHA,
		webBranch,
	)
	return os.WriteFile(filepath.Join(assetsDir, "version.yaml"), []byte(content), 0o644)
}
