package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const (
	// Matches Cloud SDK defaults in googlecloudsdk/core/config.py.
	clientID     = "32555940559.apps.googleusercontent.com"
	clientSecret = "ZmssLNjJy2998hD4CTg2ejr2"

	authEndpoint  = "https://accounts.google.com/o/oauth2/auth"
	tokenEndpoint = "https://oauth2.googleapis.com/token"

	redirectHost = "localhost"
	redirectPath = "/"

	// Matches Cloud SDK loopback port probing in core/credentials/flow.py.
	portSearchStart = 8085
	portSearchEnd   = portSearchStart + 100
)

// Matches CLOUDSDK_SCOPES + REAUTH_SCOPE in googlecloudsdk/core/config.py and
// lib/surface/auth/login.py:GetScopes.
var gcloudScopes = []string{
	"openid",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/appengine.admin",
	"https://www.googleapis.com/auth/sqlservice.login",
	"https://www.googleapis.com/auth/compute",
	"https://www.googleapis.com/auth/accounts.reauth",
}

type callbackResult struct {
	Code             string
	State            string
	OAuthError       string
	OAuthDescription string
}

type tokenResponse struct {
	AccessToken      string `json:"access_token"`
	ExpiresIn        int    `json:"expires_in"`
	RefreshToken     string `json:"refresh_token"`
	Scope            string `json:"scope"`
	TokenType        string `json:"token_type"`
	IDToken          string `json:"id_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func main() {
	redirectPort, err := pickLoopbackPort(redirectHost, portSearchStart, portSearchEnd)
	if err != nil {
		log.Fatalf("failed to reserve local callback port: %v", err)
	}
	redirectURI := fmt.Sprintf("http://%s:%d%s", redirectHost, redirectPort, redirectPath)

	state := mustRandomBase64URL(24)
	codeVerifier := mustPKCECodeVerifier(128)
	codeChallenge := computeS256Challenge(codeVerifier)

	callbackCh := make(chan callbackResult, 1)
	server := newCallbackServer(state, redirectPort, callbackCh)

	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			callbackCh <- callbackResult{
				OAuthError:       "server_error",
				OAuthDescription: err.Error(),
			}
		}
	}()

	authURL := buildAuthURL(redirectURI, state, codeChallenge)
	fmt.Printf("Open this URL in your browser:\n\n%s\n\n", authURL)
	fmt.Printf("Waiting for callback on %s ...\n", redirectURI)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	var cb callbackResult
	select {
	case cb = <-callbackCh:
	case sig := <-sigCh:
		log.Fatalf("interrupted: %v", sig)
	case <-time.After(5 * time.Minute):
		log.Fatal("timed out waiting for OAuth callback")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShutdown()
	_ = server.Shutdown(shutdownCtx)

	if cb.OAuthError != "" {
		log.Fatalf("oauth callback error: %s (%s)", cb.OAuthError, cb.OAuthDescription)
	}
	if cb.State != state {
		log.Fatalf("state mismatch: got=%q want=%q", cb.State, state)
	}
	if cb.Code == "" {
		log.Fatal("callback did not include authorization code")
	}

	token, statusCode, rawBody, err := exchangeAuthorizationCode(
		context.Background(),
		cb.Code,
		codeVerifier,
		redirectURI,
	)
	if err != nil {
		log.Fatalf("token exchange request failed: %v", err)
	}

	if statusCode != http.StatusOK || token.Error != "" || token.AccessToken == "" {
		fmt.Println("TOKEN EXCHANGE FAILED")
		fmt.Printf("HTTP status: %d\n", statusCode)
		prettyPrintJSON(rawBody)
		os.Exit(1)
	}

	fmt.Println("TOKEN EXCHANGE SUCCEEDED")
	fmt.Printf("token_type: %s\n", token.TokenType)
	fmt.Printf("scope: %s\n", token.Scope)
	fmt.Printf("expires_in: %d\n", token.ExpiresIn)
	fmt.Printf("has_refresh_token: %t\n", strings.TrimSpace(token.RefreshToken) != "")
	fmt.Printf("has_id_token: %t\n", strings.TrimSpace(token.IDToken) != "")
	fmt.Printf("access_token: %s\n", token.AccessToken)
	fmt.Printf("access_token_prefix: %s\n", prefix(token.AccessToken, 24))
}

func newCallbackServer(
	expectedState string,
	redirectPort int,
	callbackCh chan<- callbackResult,
) *http.Server {
	mux := http.NewServeMux()
	mux.HandleFunc(redirectPath, func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cb := callbackResult{
			Code:             q.Get("code"),
			State:            q.Get("state"),
			OAuthError:       q.Get("error"),
			OAuthDescription: q.Get("error_description"),
		}

		if cb.OAuthError != "" {
			http.Error(w, "OAuth failed. Check terminal output.", http.StatusBadRequest)
		} else if cb.State != expectedState {
			http.Error(w, "State mismatch. Check terminal output.", http.StatusBadRequest)
			cb.OAuthError = "state_mismatch"
			cb.OAuthDescription = fmt.Sprintf("got=%q expected=%q", cb.State, expectedState)
		} else if cb.Code == "" {
			http.Error(w, "Authorization code missing. Check terminal output.", http.StatusBadRequest)
			cb.OAuthError = "missing_code"
			cb.OAuthDescription = "no code query parameter in callback"
		} else {
			_, _ = io.WriteString(w, "Authorization received. You can return to the terminal.")
		}

		select {
		case callbackCh <- cb:
		default:
		}
	})

	return &http.Server{
		Addr:              fmt.Sprintf("%s:%d", redirectHost, redirectPort),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
}

func buildAuthURL(redirectURI, state, codeChallenge string) string {
	u, err := url.Parse(authEndpoint)
	if err != nil {
		log.Fatalf("invalid auth endpoint: %v", err)
	}
	q := u.Query()
	q.Set("client_id", clientID)
	q.Set("redirect_uri", redirectURI)
	q.Set("response_type", "code")
	q.Set("scope", strings.Join(gcloudScopes, " "))
	q.Set("state", state)
	q.Set("code_challenge", codeChallenge)
	q.Set("code_challenge_method", "S256")
	q.Set("access_type", "offline")
	u.RawQuery = q.Encode()
	return u.String()
}

func exchangeAuthorizationCode(
	ctx context.Context,
	code, codeVerifier, redirectURI string,
) (tokenResponse, int, []byte, error) {
	form := url.Values{}
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("code", code)
	form.Set("code_verifier", codeVerifier)
	form.Set("redirect_uri", redirectURI)
	form.Set("grant_type", "authorization_code")

	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		tokenEndpoint,
		strings.NewReader(form.Encode()),
	)
	if err != nil {
		return tokenResponse{}, 0, nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return tokenResponse{}, 0, nil, err
	}
	defer resp.Body.Close()

	rawBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return tokenResponse{}, resp.StatusCode, nil, err
	}

	var token tokenResponse
	_ = json.Unmarshal(rawBody, &token)
	return token, resp.StatusCode, rawBody, nil
}

func mustRandomBase64URL(numBytes int) string {
	buf := make([]byte, numBytes)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("failed to read random bytes: %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func mustPKCECodeVerifier(length int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"
	if length < 43 || length > 128 {
		log.Fatalf("invalid PKCE verifier length %d", length)
	}
	out := make([]byte, length)
	randBuf := make([]byte, length)
	if _, err := rand.Read(randBuf); err != nil {
		log.Fatalf("failed to read random bytes: %v", err)
	}
	for i := range out {
		out[i] = chars[int(randBuf[i])%len(chars)]
	}
	return string(out)
}

func computeS256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func pickLoopbackPort(host string, startPort, endPort int) (int, error) {
	for p := startPort; p <= endPort; p++ {
		l, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, p))
		if err != nil {
			continue
		}
		if err := l.Close(); err != nil {
			return 0, err
		}
		return p, nil
	}
	return 0, fmt.Errorf("no open port found between %d and %d", startPort, endPort)
}

func prettyPrintJSON(raw []byte) {
	var anyVal any
	if err := json.Unmarshal(raw, &anyVal); err != nil {
		fmt.Printf("raw_response: %s\n", string(raw))
		return
	}
	pretty, err := json.MarshalIndent(anyVal, "", "  ")
	if err != nil {
		fmt.Printf("raw_response: %s\n", string(raw))
		return
	}
	fmt.Printf("response:\n%s\n", string(pretty))
}

func prefix(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
