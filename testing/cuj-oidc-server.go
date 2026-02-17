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
	"os"
	"path/filepath"
	"strconv"
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
		"response_types_supported":              []string{"code"},
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case discoveryPath:
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(discovery)
		case jwksPath:
			w.Header().Set("content-type", "application/json")
			_ = json.NewEncoder(w).Encode(jwks)
		case authorizePath, tokenPath:
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusNotImplemented)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "not_implemented_for_cuj"})
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
