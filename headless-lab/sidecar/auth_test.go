package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/devgianlu/go-librespot/session"
)

type fakeSession struct{ closed atomic.Bool }

func (s *fakeSession) Username() string          { return "private-account" }
func (s *fakeSession) StoredCredentials() []byte { return []byte("private-credential") }
func (s *fakeSession) Close()                    { s.closed.Store(true) }

func waitAuth(t *testing.T, r *authRuntime, condition func(authStatus) bool) authStatus {
	t.Helper()
	for i := 0; i < 100; i++ {
		status := r.status()
		if condition(status) {
			return status
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("auth state did not advance")
	return authStatus{}
}
func TestPairingCodeCancelAndLateCompletionNeverPersist(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	runtime, err := newAuthRuntime(path, true)
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{})
	finish := make(chan struct{})
	s := &fakeSession{}
	runtime.connect = func(ctx context.Context, id string, credentials any) (*connectedSession, error) {
		code := credentials.(session.DeviceAuthCredentials)
		code.OnCode(&session.DeviceAuthCode{VerificationUrl: "https://accounts.spotify.com/pair", UserCode: "USER-CODE", ExpiresAt: time.Now().Add(time.Minute)})
		<-finish
		code.OnCode(nil)
		defer close(finished)
		return &connectedSession{session: s, backend: &backend{}}, nil
	}
	recorder := httptest.NewRecorder()
	runtime.startAuth(recorder, httptest.NewRequest("POST", "/auth/start", nil))
	if recorder.Code != 202 {
		t.Fatal("pairing did not start")
	}
	waitAuth(t, runtime, func(s authStatus) bool { return s.UserCode != "" })
	runtime.cancelAuth(httptest.NewRecorder(), httptest.NewRequest("DELETE", "/auth", nil))
	close(finish)
	<-finished
	waitAuth(t, runtime, func(s authStatus) bool { return s.Status == "idle" })
	for i := 0; i < 100 && !s.closed.Load(); i++ {
		time.Sleep(time.Millisecond)
	}
	if !s.closed.Load() {
		t.Fatal("cancelled session not closed")
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("cancelled flow persisted credentials")
	}
	if runtime.status().UserCode != "" {
		t.Fatal("stale code survived cancellation")
	}
}
func TestSuccessfulPairingStoresPrivatelyAndProtectsAccount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	runtime, _ := newAuthRuntime(path, true)
	s := &fakeSession{}
	runtime.connect = func(context.Context, string, any) (*connectedSession, error) {
		return &connectedSession{session: s, backend: &backend{}}, nil
	}
	runtime.startAuth(httptest.NewRecorder(), httptest.NewRequest("POST", "/auth/start", nil))
	waitAuth(t, runtime, func(s authStatus) bool { return s.Authenticated })
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var state sessionState
	if json.Unmarshal(data, &state) != nil || state.Credentials.Username != "private-account" || string(state.Credentials.Data) != "private-credential" {
		t.Fatal("session was not persisted")
	}
	before := string(data)
	for _, action := range []func(*httptest.ResponseRecorder){
		func(w *httptest.ResponseRecorder) {
			runtime.startAuth(w, httptest.NewRequest("POST", "/auth/start", nil))
		},
		func(w *httptest.ResponseRecorder) { runtime.cancelAuth(w, httptest.NewRequest("DELETE", "/auth", nil)) },
	} {
		w := httptest.NewRecorder()
		action(w)
		if w.Code != 409 {
			t.Fatal("paired account can be replaced")
		}
	}
	status, _ := json.Marshal(runtime.status())
	if strings.Contains(string(status), "private-") {
		t.Fatal("credentials leaked in auth status")
	}
	after, _ := os.ReadFile(path)
	if string(after) != before {
		t.Fatal("existing account state changed")
	}
}
func TestSaveNewStateNeverOverwritesExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	os.WriteFile(path, []byte("original"), 0600)
	if saveNewState(path, sessionState{}) == nil {
		t.Fatal("existing state overwritten")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "original" {
		t.Fatal("state changed")
	}
}
func TestPairingUnavailableWithoutExplicitEnableAndUnauthenticatedToolsFail(t *testing.T) {
	if _, err := newAuthRuntime(filepath.Join(t.TempDir(), "missing"), false); err == nil {
		t.Fatal("pairing enabled implicitly")
	}
	runtime := &authRuntime{phase: "idle"}
	w := httptest.NewRecorder()
	runtime.startAuth(w, httptest.NewRequest("POST", "/auth/start", nil))
	if w.Code != 403 {
		t.Fatal("disabled pairing allowed")
	}
	w = httptest.NewRecorder()
	runtime.tools(w, httptest.NewRequest("POST", "/tools/call", strings.NewReader(`{}`)))
	if !strings.Contains(w.Body.String(), "spotify_not_authenticated") {
		t.Fatal("unauthenticated tools did not fail closed")
	}
}
