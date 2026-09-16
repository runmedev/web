package main

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type tokenPayload struct {
	IDToken     string `json:"id_token"`
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Scope       string `json:"scope"`
	ExpiresIn   int64  `json:"expires_in"`
	ExpiresAt   int64  `json:"expires_at"`
}

func envOrDefault(name, defaultValue string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return defaultValue
}

func envInt(name string, defaultValue int) int {
	raw := envOrDefault(name, fmt.Sprintf("%d", defaultValue))
	parsed, err := strconv.Atoi(raw)
	if err != nil {
		return defaultValue
	}
	return parsed
}

func base64URL(input []byte) string {
	return base64.RawURLEncoding.EncodeToString(input)
}

func signJWT(payload map[string]any, privateKey *rsa.PrivateKey, keyID string) (string, error) {
	header := map[string]string{
		"alg": "RS256",
		"typ": "JWT",
		"kid": keyID,
	}

	encodedHeaderBytes, err := json.Marshal(header)
	if err != nil {
		return "", err
	}
	encodedPayloadBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	signingInput := fmt.Sprintf(
		"%s.%s",
		base64URL(encodedHeaderBytes),
		base64URL(encodedPayloadBytes),
	)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, privateKey, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("%s.%s", signingInput, base64URL(signature)), nil
}

func main() {
	host := envOrDefault("CUJ_OIDC_HOST", "127.0.0.1")
	port := envInt("CUJ_OIDC_PORT", 9988)
	issuer := envOrDefault("CUJ_OIDC_ISSUER", fmt.Sprintf("http://%s:%d", host, port))
	clientID := envOrDefault("CUJ_OIDC_CLIENT_ID", "cuj-web-client")
	email := envOrDefault("CUJ_OIDC_EMAIL", "cuj-user@example.com")
	subject := envOrDefault("CUJ_OIDC_SUBJECT", "cuj-user")
	tokenFile := os.Getenv("CUJ_OIDC_TOKEN_FILE")
	tokenTTLSeconds := envInt("CUJ_OIDC_TOKEN_TTL_SECONDS", 300)
	keyID := envOrDefault("CUJ_OIDC_KEY_ID", "cuj-oidc-key-1")

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		log.Fatalf("failed to generate RSA key: %v", err)
	}

	now := time.Now()
	expiresAt := now.Add(time.Duration(tokenTTLSeconds) * time.Second)
	claims := map[string]any{
		"iss":   issuer,
		"aud":   clientID,
		"sub":   subject,
		"email": email,
		"iat":   now.Unix(),
		"exp":   expiresAt.Unix(),
	}
	idToken, err := signJWT(claims, privateKey, keyID)
	if err != nil {
		log.Fatalf("failed to sign JWT: %v", err)
	}

	if tokenFile != "" {
		if err := os.MkdirAll(filepath.Dir(tokenFile), 0o755); err != nil {
			log.Fatalf("failed to create token file directory: %v", err)
		}
		payload := tokenPayload{
			IDToken:     idToken,
			AccessToken: idToken,
			TokenType:   "Bearer",
			Scope:       "openid email",
			ExpiresIn:   int64(tokenTTLSeconds),
			ExpiresAt:   expiresAt.UnixNano() / int64(time.Millisecond),
		}
		raw, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			log.Fatalf("failed to encode token file JSON: %v", err)
		}
		if err := os.WriteFile(tokenFile, raw, 0o644); err != nil {
			log.Fatalf("failed to write token file: %v", err)
		}
	}

	n := base64URL(privateKey.PublicKey.N.Bytes())
	e := base64URL(big.NewInt(int64(privateKey.PublicKey.E)).Bytes())
	discoveryPath := "/.well-known/openid-configuration"
	jwksPath := "/jwks"
	authorizePath := "/authorize"
	tokenPath := "/token"

	discovery := map[string]any{
		"issuer":                                issuer,
		"authorization_endpoint":                issuer + authorizePath,
		"token_endpoint":                        issuer + tokenPath,
		"jwks_uri":                              issuer + jwksPath,
		"response_types_supported":              []string{"code", "id_token token"},
		"subject_types_supported":               []string{"public"},
		"id_token_signing_alg_values_supported": []string{"RS256"},
	}
	jwks := map[string]any{
		"keys": []map[string]string{
			{
				"kty": "RSA",
				"use": "sig",
				"alg": "RS256",
				"kid": keyID,
				"n":   n,
				"e":   e,
			},
		},
	}

	// This local fixture performs a real code+PKCE exchange for browser CUJs.
	var codesMu sync.Mutex
	codes := map[string]url.Values{}
	mint := func(nonce string) (tokenPayload, error) {
		access := "cuj-access-token"
		digest := sha256.Sum256([]byte(access))
		now := time.Now()
		jwt, err := signJWT(map[string]any{
			"iss": issuer, "aud": clientID, "sub": subject, "email": email,
			"iat": now.Unix(), "exp": now.Add(time.Duration(tokenTTLSeconds) * time.Second).Unix(),
			"nonce": nonce, "at_hash": base64URL(digest[:16]),
		}, privateKey, keyID)
		return tokenPayload{IDToken: jwt, AccessToken: access, TokenType: "Bearer", Scope: "openid email", ExpiresIn: int64(tokenTTLSeconds)}, err
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin, _ := url.Parse(r.Header.Get("Origin"))
		if origin != nil && (origin.Hostname() == "localhost" || origin.Hostname() == "127.0.0.1") {
			w.Header().Set("Access-Control-Allow-Origin", origin.String())
			w.Header().Set("Access-Control-Allow-Headers", "content-type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		switch r.URL.Path {
		case discoveryPath:
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(discovery)
		case jwksPath:
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(jwks)
		case authorizePath:
			q := r.URL.Query()
			callback, err := url.Parse(q.Get("redirect_uri"))
			if err != nil || callback.Scheme != "http" || (callback.Hostname() != "localhost" && callback.Hostname() != "127.0.0.1") || q.Get("client_id") != clientID || q.Get("state") == "" || q.Get("nonce") == "" {
				http.Error(w, "invalid authorization request", http.StatusBadRequest)
				return
			}
			response := url.Values{"state": {q.Get("state")}}
			switch q.Get("response_type") {
			case "code":
				if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
					http.Error(w, "PKCE required", 400)
					return
				}
				raw := make([]byte, 32)
				if _, err := rand.Read(raw); err != nil {
					http.Error(w, "random failed", 500)
					return
				}
				code := base64URL(raw)
				codesMu.Lock()
				codes[code] = q
				codesMu.Unlock()
				response.Set("code", code)
				callback.RawQuery = response.Encode()
			case "id_token token":
				token, err := mint(q.Get("nonce"))
				if err != nil {
					http.Error(w, "signing failed", 500)
					return
				}
				response.Set("id_token", token.IDToken)
				response.Set("access_token", token.AccessToken)
				response.Set("token_type", token.TokenType)
				response.Set("expires_in", strconv.FormatInt(token.ExpiresIn, 10))
				callback.Fragment = response.Encode()
			default:
				http.Error(w, "unsupported response type", 400)
				return
			}
			http.Redirect(w, r, callback.String(), http.StatusFound)
		case tokenPath:
			if err := r.ParseForm(); err != nil {
				http.Error(w, "invalid form", 400)
				return
			}
			codesMu.Lock()
			request := codes[r.Form.Get("code")]
			delete(codes, r.Form.Get("code"))
			codesMu.Unlock()
			digest := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if request == nil || r.Form.Get("grant_type") != "authorization_code" || request.Get("code_challenge") != base64URL(digest[:]) || request.Get("redirect_uri") != r.Form.Get("redirect_uri") || r.Form.Get("client_id") != clientID {
				http.Error(w, "invalid code exchange", 400)
				return
			}
			token, err := mint(request.Get("nonce"))
			if err != nil {
				http.Error(w, "signing failed", 500)
				return
			}
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(token)
		case "/healthz":
			w.Header().Set("content-type", "text/plain")
			_, _ = w.Write([]byte("ok"))
		default:
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not_found"})
		}
	})

	addr := fmt.Sprintf("%s:%d", host, port)
	log.Printf(
		"[cuj-oidc] listening on %s; discovery=%s%s; token_file=%s",
		issuer,
		issuer,
		discoveryPath,
		func() string {
			if tokenFile == "" {
				return "disabled"
			}
			return tokenFile
		}(),
	)
	if err := http.ListenAndServe(addr, handler); err != nil {
		log.Fatalf("oidc server exited: %v", err)
	}
}
