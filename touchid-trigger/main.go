package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

type confirmRequest struct {
	Text string `json:"text"`
}

type confirmResponse struct {
	Confirmed bool   `json:"confirmed"`
	Error     string `json:"error,omitempty"`
}

func main() {
	addr := flag.String("addr", "127.0.0.1:8765", "HTTP listen address")
	token := flag.String("token", os.Getenv("TOUCHID_TRIGGER_TOKEN"), "optional bearer token; defaults to TOUCHID_TRIGGER_TOKEN")
	confirmText := flag.String("confirm", "", "request one Touch ID confirmation with this reason, write JSON to stdout, then exit")
	flag.Parse()

	if strings.TrimSpace(*confirmText) != "" {
		confirmed, err := requestBiometricConfirmation(strings.TrimSpace(*confirmText))
		response := confirmResponse{Confirmed: confirmed}
		if err != nil {
			response.Error = err.Error()
		}
		if encodeErr := json.NewEncoder(os.Stdout).Encode(response); encodeErr != nil {
			log.Fatal(encodeErr)
		}
		if err != nil || !confirmed {
			os.Exit(1)
		}
		return
	}

	if err := listenAndServe(*addr, *token); err != nil {
		log.Fatal(err)
	}
}

func listenAndServe(addr, token string) error {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /touch_id_confirm", withAuth(token, handleTouchIDConfirm))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	server := &http.Server{
		Addr:              addr,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("parse listen address: %w", err)
	}
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		log.Printf("warning: listening on %s allows non-local clients to trigger Touch ID prompts", addr)
	}
	if token == "" {
		log.Printf("warning: no token configured; any local process can call POST /touch_id_confirm")
	}

	log.Printf("listening on http://%s", addr)
	return server.ListenAndServe()
}

func handleTouchIDConfirm(w http.ResponseWriter, r *http.Request) {
	var req confirmRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, confirmResponse{Error: "invalid JSON body"})
		return
	}

	reason := strings.TrimSpace(req.Text)
	if reason == "" {
		writeJSON(w, http.StatusBadRequest, confirmResponse{Error: "text is required"})
		return
	}

	confirmed, err := requestBiometricConfirmation(reason)
	if err != nil {
		status := http.StatusForbidden
		if errors.Is(err, errBiometricsUnavailable) {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, confirmResponse{Confirmed: false, Error: err.Error()})
		return
	}

	writeJSON(w, http.StatusOK, confirmResponse{Confirmed: confirmed})
}

func withAuth(token string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if token == "" {
			next(w, r)
			return
		}

		if r.Header.Get("Authorization") != "Bearer "+token {
			writeJSON(w, http.StatusUnauthorized, confirmResponse{Error: "missing or invalid bearer token"})
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
	})
}
