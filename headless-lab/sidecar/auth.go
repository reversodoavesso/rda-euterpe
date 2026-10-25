package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	devices "github.com/devgianlu/go-librespot/proto/spotify/connectstate/devices"
	"github.com/devgianlu/go-librespot/session"
)

type sessionState struct {
	DeviceID    string `json:"device_id"`
	Credentials struct {
		Username string `json:"username"`
		Data     []byte `json:"data"`
	} `json:"credentials"`
}
type authorizedSession interface {
	Username() string
	StoredCredentials() []byte
	Close()
}
type connectedSession struct {
	session authorizedSession
	backend *backend
}
type connectSession func(context.Context, string, any) (*connectedSession, error)
type authStatus struct {
	Status          string `json:"status"`
	Authenticated   bool   `json:"authenticated"`
	VerificationURL string `json:"verification_url,omitempty"`
	UserCode        string `json:"user_code,omitempty"`
	ExpiresAt       string `json:"expires_at,omitempty"`
	Error           string `json:"error,omitempty"`
}
type authRuntime struct {
	mu             sync.Mutex
	state          sessionState
	statePath      string
	pairingEnabled bool
	active         *connectedSession
	connect        connectSession
	phase          string
	code           *session.DeviceAuthCode
	lastError      string
	cancel         context.CancelFunc
	generation     uint64
}

func openSession(ctx context.Context, deviceID string, credentials any) (*connectedSession, error) {
	transport := &sessionTransport{base: http.DefaultTransport}
	client := &http.Client{Transport: transport, Timeout: 25 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	s, err := session.NewSessionFromOptions(ctx, &session.Options{Log: &librespot.NullLogger{}, DeviceType: devices.DeviceType_COMPUTER, DeviceId: deviceID, Credentials: credentials, PreferFirewallFriendlyPorts: true, Client: client})
	if err != nil {
		return nil, err
	}
	pathfinder := &pathfinderClient{client: client, token: s.Spclient().GetAccessToken, clientToken: transport.clientToken}
	b := &backend{sp: s.Spclient(), username: s.Username(), searcher: pathfinder.search}
	return &connectedSession{session: s, backend: b}, nil
}

func newAuthRuntime(path string, enabled bool) (*authRuntime, error) {
	r := &authRuntime{statePath: path, pairingEnabled: enabled, phase: "idle", connect: openSession}
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) || !enabled {
			return nil, failure("cannot_read_session_state")
		}
		device := make([]byte, 20)
		if _, err = rand.Read(device); err != nil {
			return nil, failure("device_id_failed")
		}
		r.state.DeviceID = hex.EncodeToString(device)
		return r, nil
	}
	if json.Unmarshal(data, &r.state) != nil || r.state.Credentials.Username == "" || len(r.state.Credentials.Data) == 0 {
		return nil, failure("invalid_session_state")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	active, err := r.connect(ctx, r.state.DeviceID, session.StoredCredentials{Username: r.state.Credentials.Username, Data: r.state.Credentials.Data})
	if err != nil {
		return nil, failure("stored_session_authentication_failed")
	}
	r.active = active
	r.phase = "authenticated"
	return r, nil
}
func (r *authRuntime) status() authStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	status := authStatus{Status: r.phase, Authenticated: r.active != nil, Error: r.lastError}
	if !r.pairingEnabled && r.active == nil {
		status.Status = "disabled"
	}
	if r.code != nil {
		status.VerificationURL = r.code.VerificationUrl
		status.UserCode = r.code.UserCode
		status.ExpiresAt = r.code.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return status
}
func authReply(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}
func (r *authRuntime) getAuth(w http.ResponseWriter, request *http.Request) {
	authReply(w, 200, r.status())
}
func (r *authRuntime) health(w http.ResponseWriter, request *http.Request) {
	status := r.status()
	authReply(w, 200, map[string]any{"ok": true, "authenticated": status.Authenticated, "supported_tools": supported})
}
func (r *authRuntime) tools(w http.ResponseWriter, request *http.Request) {
	r.mu.Lock()
	active := r.active
	r.mu.Unlock()
	if active == nil {
		authReply(w, 200, result{Code: "spotify_not_authenticated"})
		return
	}
	active.backend.handler(w, request)
}
func (r *authRuntime) startAuth(w http.ResponseWriter, request *http.Request) {
	r.mu.Lock()
	if r.active != nil {
		r.mu.Unlock()
		authReply(w, 409, authStatus{Status: "authenticated", Authenticated: true, Error: "already_authenticated"})
		return
	}
	if !r.pairingEnabled {
		r.mu.Unlock()
		authReply(w, 403, authStatus{Status: "disabled", Error: "pairing_disabled"})
		return
	}
	if r.cancel != nil {
		r.mu.Unlock()
		authReply(w, 202, r.status())
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	r.cancel = cancel
	r.generation++
	generation := r.generation
	r.phase = "pending"
	r.code = nil
	r.lastError = ""
	deviceID := r.state.DeviceID
	r.mu.Unlock()
	go r.pair(ctx, cancel, generation, deviceID)
	authReply(w, 202, r.status())
}
func (r *authRuntime) pair(ctx context.Context, cancel context.CancelFunc, generation uint64, deviceID string) {
	defer cancel()
	creds := session.DeviceAuthCredentials{OnCode: func(code *session.DeviceAuthCode) {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.generation != generation || r.cancel == nil {
			return
		}
		r.code = code
		if code == nil {
			r.phase = "authenticating"
		}
	}}
	active, err := r.connect(ctx, deviceID, creds)
	r.mu.Lock()
	defer r.mu.Unlock()
	if generation != r.generation || r.cancel == nil {
		if active != nil {
			active.session.Close()
		}
		return
	}
	r.cancel = nil
	r.code = nil
	if err != nil {
		r.phase = "error"
		r.lastError = "pairing_failed"
		return
	}
	state := sessionState{DeviceID: deviceID}
	state.Credentials.Username = active.session.Username()
	state.Credentials.Data = active.session.StoredCredentials()
	if err = saveNewState(r.statePath, state); err != nil {
		active.session.Close()
		r.phase = "error"
		r.lastError = "session_storage_failed"
		return
	}
	r.state = state
	r.active = active
	r.phase = "authenticated"
	r.lastError = ""
}
func saveNewState(path string, state sessionState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	// Never replace an account already stored by another instance.
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	data, err := json.Marshal(state)
	if err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		os.Remove(path)
		return err
	}
	return closeErr
}
func (r *authRuntime) cancelAuth(w http.ResponseWriter, request *http.Request) {
	r.mu.Lock()
	if r.active != nil {
		r.mu.Unlock()
		authReply(w, 409, authStatus{Status: "authenticated", Authenticated: true, Error: "already_authenticated"})
		return
	}
	if r.cancel != nil {
		r.cancel()
	}
	r.cancel = nil
	r.generation++
	r.code = nil
	r.lastError = ""
	r.phase = "idle"
	r.mu.Unlock()
	authReply(w, 200, r.status())
}
func (r *authRuntime) close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		r.cancel()
	}
	r.cancel = nil
	r.generation++
	if r.active != nil {
		r.active.session.Close()
	}
}
