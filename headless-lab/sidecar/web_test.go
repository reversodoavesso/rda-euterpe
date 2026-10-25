package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	pb "github.com/devgianlu/go-librespot/proto/spotify/playlist4"
)

func TestPrivateServiceRequiresItsOwnBearer(t *testing.T) {
	handler := serviceAuth("account-a", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	for _, item := range []struct {
		path, token string
		status      int
	}{{"/auth", "", 401}, {"/tools/call", "account-b", 401}, {"/auth", "account-a", 204}, {"/health", "", 204}} {
		request := httptest.NewRequest("GET", item.path, nil)
		if item.token != "" {
			request.Header.Set("Authorization", "Bearer "+item.token)
		}
		reply := httptest.NewRecorder()
		handler.ServeHTTP(reply, request)
		if reply.Code != item.status {
			t.Fatalf("%s: %d", item.path, reply.Code)
		}
	}
}

func TestCreateKeepsReviewedOrderAndDuplicates(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("r", false)}}
	name := "Reviewed draft"
	items := []json.RawMessage{}
	for _, uri := range []string{b, a, b} {
		raw, _ := json.Marshal(uri)
		items = append(items, raw)
	}
	_, err := (&backend{sp: f}).execute(context.Background(), "create_playlist", arguments{Name: &name, Tracks: items})
	if err != nil {
		t.Fatal(err)
	}
	if len(f.writes) != 2 {
		t.Fatal("expected create and follow")
	}
	songs := f.writes[0].Deltas[0].Ops[1].Add.Items
	if len(songs) != 3 || songs[0].GetUri() != b || songs[1].GetUri() != a || songs[2].GetUri() != b {
		t.Fatal("reviewed duplicates/order lost")
	}
}

func TestLibraryPaginationDoesNotOmitBeyondFifty(t *testing.T) {
	rows := make([]string, 53)
	for i := range rows {
		rows[i] = "spotify:playlist:" + pid
	}
	f := &fake{pages: []*pb.SelectedListContent{page("r", false, rows...)}}
	service := &backend{sp: f}
	value, err := service.execute(context.Background(), "get_playlists", arguments{Limit: 50, Offset: 50})
	if err != nil {
		t.Fatal(err)
	}
	data := value.(map[string]any)
	if data["total"] != 53 || len(data["playlists"].([]map[string]any)) != 3 {
		t.Fatal("last page lost")
	}
	if _, err = service.execute(context.Background(), "get_playlists", arguments{Offset: -1}); err == nil {
		t.Fatal("negative offset accepted")
	}
}
