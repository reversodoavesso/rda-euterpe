// Experimental playlist backend. Credentials stay inside the container;
// only normalized tool results cross the private HTTP boundary.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/events"
	eventsimpl "github.com/devgianlu/go-librespot/events/impl"
	ext "github.com/devgianlu/go-librespot/proto/spotify/extendedmetadata"
	metadata "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	pb "github.com/devgianlu/go-librespot/proto/spotify/playlist4"
	"github.com/devgianlu/go-librespot/spclient"
	"google.golang.org/protobuf/proto"
)

var supported = []string{"get_playlists", "get_playlist_tracks", "create_playlist", "delete_playlist", "add_tracks", "remove_tracks", "replace_playlist_tracks", "set_playlist_details", "search_spotify", "get_saved_tracks", "get_several_tracks", "resolve_tracks"}
var base62 = regexp.MustCompile(`^[0-9A-Za-z]{22}$`)

func validEntityID(id string) bool {
	if !base62.MatchString(id) {
		return false
	}
	value, ok := new(big.Int).SetString(id, 62)
	return ok && value.BitLen() <= 128
}

type result struct {
	OK   bool   `json:"ok"`
	Data any    `json:"data,omitempty"`
	Code string `json:"code,omitempty"`
}
type arguments struct {
	PlaylistID  string            `json:"playlist_id"`
	PlaylistIDs []string          `json:"playlist_ids"`
	Name        *string           `json:"name"`
	Description *string           `json:"description"`
	Tracks      []json.RawMessage `json:"tracks"`
	URIs        []string          `json:"uris"`
	Limit       int               `json:"limit"`
	Offset      int               `json:"offset"`
	Q           string            `json:"q"`
	Types       string            `json:"types"`
	IDs         []string          `json:"ids"`
}
type requester interface {
	Request(context.Context, string, string, url.Values, http.Header, []byte) (*http.Response, error)
	RequestOnce(context.Context, string, string, url.Values, http.Header, []byte) (*http.Response, error)
	ExtendedMetadata(context.Context, *ext.BatchedEntityRequest) (*ext.BatchedExtensionResponse, error)
}
type backend struct {
	sp       requester
	username string
	mutation sync.Mutex
	searcher func(context.Context, string, int) (map[string]any, error)
}

func failure(code string) error { return errors.New(code) }
func playlistID(raw string) (string, error) {
	id := strings.TrimPrefix(raw, "spotify:playlist:")
	if !validEntityID(id) {
		return "", failure("invalid_playlist_id")
	}
	return id, nil
}
func trackURIs(uris []string, dedupe bool) ([]string, error) {
	out := []string{}
	seen := map[string]bool{}
	for _, uri := range uris {
		if !strings.HasPrefix(uri, "spotify:track:") || !validEntityID(strings.TrimPrefix(uri, "spotify:track:")) {
			return nil, failure("invalid_track_uri")
		}
		if !dedupe || !seen[uri] {
			out = append(out, uri)
			seen[uri] = true
		}
	}
	if len(out) > 10000 {
		return nil, failure("too_many_tracks")
	}
	return out, nil
}

// Read all pages at a single revision. Never return a truncated snapshot.
func (b *backend) read(ctx context.Context, path string) (*pb.SelectedListContent, error) {
	var all *pb.SelectedListContent
	for page := 0; page < 50; page++ {
		offset := 0
		if all != nil {
			offset = len(all.GetContents().GetItems())
		}
		query := url.Values{"decorate": {"revision,attributes,length,owner,capabilities"}, "from": {strconv.Itoa(offset)}, "length": {"1000"}}
		response, err := b.sp.Request(ctx, "GET", path, query, nil, nil)
		if err != nil {
			return nil, failure("headless_unavailable")
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
		response.Body.Close()
		if response.StatusCode != 200 {
			return nil, failure(fmt.Sprintf("spotify_status_%d", response.StatusCode))
		}
		if err != nil {
			return nil, failure("invalid_spotify_response")
		}
		current := new(pb.SelectedListContent)
		if proto.Unmarshal(data, current) != nil || current.Contents == nil {
			return nil, failure("invalid_spotify_response")
		}
		if all == nil {
			all = current
		} else {
			if !bytes.Equal(all.Revision, current.Revision) {
				return nil, failure("playlist_conflict")
			}
			all.Contents.Items = append(all.Contents.Items, current.Contents.Items...)
			all.Contents.MetaItems = append(all.Contents.MetaItems, current.Contents.MetaItems...)
		}
		if !current.GetContents().GetTruncated() {
			if all.Length != nil && int(all.GetLength()) != len(all.Contents.Items) {
				return nil, failure("incomplete_playlist")
			}
			return all, nil
		}
		if len(current.GetContents().GetItems()) == 0 {
			return nil, failure("incomplete_playlist")
		}
	}
	return nil, failure("playlist_page_limit")
}
func (b *backend) rootPath() string {
	return "/playlist/v2/user/" + url.PathEscape(b.username) + "/rootlist"
}
func playlistPath(id string) string { return "/playlist/v2/playlist/" + id }

func attributeOp(attrs *pb.ListAttributes) *pb.Op {
	return &pb.Op{Kind: pb.Op_UPDATE_LIST_ATTRIBUTES.Enum(), UpdateListAttributes: &pb.UpdateListAttributes{NewAttributes: &pb.ListAttributesPartialState{Values: attrs}}}
}
func addOp(uris []string) *pb.Op {
	items := []*pb.Item{}
	for _, uri := range uris {
		items = append(items, &pb.Item{Uri: proto.String(uri)})
	}
	return &pb.Op{Kind: pb.Op_ADD.Enum(), Add: &pb.Add{AddLast: proto.Bool(true), Items: items}}
}
func removeOp(position, length int) *pb.Op {
	return &pb.Op{Kind: pb.Op_REM.Enum(), Rem: &pb.Rem{FromIndex: proto.Int32(int32(position)), Length: proto.Int32(int32(length))}}
}
func replaceOps(old int, uris []string) []*pb.Op {
	ops := []*pb.Op{}
	if old > 0 {
		ops = append(ops, removeOp(0, old))
	}
	if len(uris) > 0 {
		ops = append(ops, addOp(uris))
	}
	return ops
}

// RequestOnce is essential: a timeout may occur AFTER a successful write.
func (b *backend) change(ctx context.Context, path string, revision []byte, ops []*pb.Op) error {
	if len(ops) == 0 {
		return nil
	}
	payload, err := proto.Marshal(&pb.ListChanges{BaseRevision: revision, WantResultingRevisions: proto.Bool(true), WantSyncResult: proto.Bool(true), Deltas: []*pb.Delta{{Ops: ops, Info: &pb.ChangeInfo{User: proto.String(b.username), Timestamp: proto.Int64(time.Now().UnixMilli())}}}})
	if err != nil {
		return failure("invalid_change")
	}
	response, err := b.sp.RequestOnce(ctx, "POST", path+"/changes", nil, nil, payload)
	if err != nil {
		return failure("headless_outcome_unknown")
	}
	defer response.Body.Close()
	if response.StatusCode == 409 || response.StatusCode == 412 {
		return failure("playlist_conflict")
	}
	if response.StatusCode >= 500 {
		return failure("headless_outcome_unknown")
	}
	if response.StatusCode != 200 {
		return failure(fmt.Sprintf("spotify_status_%d", response.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
	answer := new(pb.SelectedListContent)
	if err != nil || proto.Unmarshal(data, answer) != nil {
		return failure("headless_outcome_unknown")
	}
	// changes_require_resync is advisory even when the change was applied.
	// We keep no revision cache: every subsequent operation starts with a fresh
	// read. Reporting failure here encourages duplicate playlist creation.
	return nil
}

// Metadata is batched. Unavailable tracks retain their URI and position so
// snapshots and undo preserve local/unavailable entries and duplicates.
func (b *backend) tracks(ctx context.Context, items []*pb.Item) ([]map[string]any, error) {
	cache := map[string]map[string]any{}
	for start := 0; start < len(items); start += 50 {
		req := &ext.BatchedEntityRequest{}
		for _, item := range items[start:min(start+50, len(items))] {
			uri := item.GetUri()
			if strings.HasPrefix(uri, "spotify:track:") {
				req.EntityRequest = append(req.EntityRequest, &ext.EntityRequest{EntityUri: uri, Query: []*ext.ExtensionQuery{{ExtensionKind: ext.ExtensionKind_TRACK_V4}}})
			}
		}
		if len(req.EntityRequest) == 0 {
			continue
		}
		response, err := b.sp.ExtendedMetadata(ctx, req)
		if err != nil {
			return nil, failure("metadata_unavailable")
		}
		for _, group := range response.GetExtendedMetadata() {
			if group.GetExtensionKind() != ext.ExtensionKind_TRACK_V4 {
				continue
			}
			for _, entry := range group.GetExtensionData() {
				if entry.GetHeader().GetStatusCode() != 200 {
					continue
				}
				t := new(metadata.Track)
				if entry.GetExtensionData().UnmarshalTo(t) != nil {
					continue
				}
				artists := []string{}
				artistIDs := []string{}
				for _, a := range t.GetArtist() {
					artists = append(artists, a.GetName())
					id := ""
					if len(a.GetGid()) == 16 {
						id = librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeArtist, a.GetGid()).Base62()
					}
					artistIDs = append(artistIDs, id)
				}
				cache[entry.GetEntityUri()] = map[string]any{"id": strings.TrimPrefix(entry.GetEntityUri(), "spotify:track:"), "uri": entry.GetEntityUri(), "name": t.GetName(), "artists": artists, "artist_ids": artistIDs, "album": t.GetAlbum().GetName(), "duration_ms": t.GetDuration(), "explicit": t.GetExplicit()}
			}
		}
	}
	out := []map[string]any{}
	for _, item := range items {
		track, ok := cache[item.GetUri()]
		if !ok {
			track = map[string]any{"id": strings.TrimPrefix(item.GetUri(), "spotify:track:"), "uri": item.GetUri(), "name": nil, "artists": []string{}, "artist_ids": []string{}, "album": nil, "duration_ms": nil, "metadata_unavailable": true}
		}
		out = append(out, track)
	}
	return out, nil
}

func (b *backend) execute(ctx context.Context, name string, a arguments) (any, error) {
	switch name {
	case "get_saved_tracks":
		return b.savedTracks(ctx, a.Limit, a.Offset)
	case "get_several_tracks":
		return b.severalTracks(ctx, a.IDs)
	case "search_spotify":
		return b.search(ctx, a)
	case "resolve_tracks":
		return b.resolve(ctx, a.Tracks)
	}
	if name == "get_playlists" {
		root, err := b.read(ctx, b.rootPath())
		if err != nil {
			return nil, err
		}
		playlists := []map[string]any{}
		for i, item := range root.GetContents().GetItems() {
			if !strings.HasPrefix(item.GetUri(), "spotify:playlist:") {
				continue
			}
			var m *pb.MetaItem
			if i < len(root.GetContents().GetMetaItems()) {
				m = root.Contents.MetaItems[i]
			}
			playlists = append(playlists, map[string]any{"id": strings.TrimPrefix(item.GetUri(), "spotify:playlist:"), "uri": item.GetUri(), "name": m.GetAttributes().GetName(), "tracks": m.GetLength(), "owner": m.GetOwnerUsername(), "description": m.GetAttributes().GetDescription(), "image": nil, "can_edit": m.GetCapabilities().GetCanEditItems()})
		}
		total := len(playlists)
		limit := a.Limit
		if limit <= 0 {
			limit = 50
		}
		limit = min(limit, 50)
		if a.Offset < 0 {
			return nil, failure("invalid_offset")
		}
		start := min(a.Offset, total)
		return map[string]any{"source": "headless", "total": total, "offset": start, "limit": limit, "playlists": playlists[start:min(start+limit, total)]}, nil
	}
	if name == "create_playlist" {
		if a.Name == nil || strings.TrimSpace(*a.Name) == "" {
			return nil, failure("name_required")
		}
		resolved, err := b.resolve(ctx, a.Tracks)
		if err != nil {
			return nil, err
		}
		tracks := []string{}
		for _, row := range resolved["results"].([]map[string]any) {
			if row["matched"] != true {
				return nil, failure("unresolved_tracks")
			}
			// Creation must match the reviewed order, including repeated songs.
			tracks = append(tracks, row["uri"].(string))
		}
		gid := make([]byte, 16)
		if _, err = rand.Read(gid); err != nil {
			return nil, failure("random_failed")
		}
		id := librespot.SpotifyIdFromGid(librespot.SpotifyIdTypePlaylist, gid).Base62()
		created := map[string]any{"playlist_id": id, "uri": "spotify:playlist:" + id, "name": *a.Name, "url": "https://open.spotify.com/playlist/" + id, "added": len(tracks)}
		ops := []*pb.Op{attributeOp(&pb.ListAttributes{Name: a.Name, Description: a.Description, Collaborative: proto.Bool(false)})}
		if len(tracks) > 0 {
			ops = append(ops, addOp(tracks))
		}
		err = b.change(ctx, playlistPath(id), []byte{0, 0, 0, 0, 'r', 'o', 'o', 't'}, ops)
		if err != nil {
			return created, err
		}
		root, err := b.read(ctx, b.rootPath())
		if err != nil {
			return created, failure("created_but_follow_failed")
		}
		follow := addOp([]string{"spotify:playlist:" + id})
		follow.Add.AddLast = nil
		follow.Add.FromIndex = proto.Int32(0)
		follow.Add.Items[0].Attributes = &pb.ItemAttributes{Public: proto.Bool(false), Timestamp: proto.Int64(time.Now().UnixMilli())}
		if err = b.change(ctx, b.rootPath(), root.Revision, []*pb.Op{follow}); err != nil {
			created["follow_error"] = err.Error()
			return created, failure("created_but_follow_failed")
		}
		return created, nil
	}
	if name == "delete_playlist" {
		ids := a.PlaylistIDs
		if len(ids) == 0 && a.PlaylistID != "" {
			ids = []string{a.PlaylistID}
		}
		if len(ids) == 0 {
			return nil, failure("playlist_id_required")
		}
		targets := map[string]bool{}
		for _, raw := range ids {
			id, err := playlistID(raw)
			if err != nil {
				return nil, err
			}
			targets["spotify:playlist:"+id] = true
		}
		root, err := b.read(ctx, b.rootPath())
		if err != nil {
			return nil, err
		}
		ops := []*pb.Op{}
		deleted := []map[string]string{}
		for i := len(root.Contents.Items) - 1; i >= 0; i-- {
			uri := root.Contents.Items[i].GetUri()
			if targets[uri] {
				ops = append(ops, removeOp(i, 1))
				deleted = append(deleted, map[string]string{"id": strings.TrimPrefix(uri, "spotify:playlist:"), "uri": uri})
			}
		}
		if err = b.change(ctx, b.rootPath(), root.Revision, ops); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "deleted_count": len(deleted), "deleted": deleted, "failed_count": 0, "failed": []any{}}, nil
	}
	switch name {
	case "get_playlist_tracks", "add_tracks", "remove_tracks", "replace_playlist_tracks", "set_playlist_details":
	default:
		return nil, failure("unsupported_in_headless")
	}
	id, err := playlistID(a.PlaylistID)
	if err != nil {
		return nil, err
	}
	list, err := b.read(ctx, playlistPath(id))
	if err != nil {
		return nil, err
	}
	if name == "get_playlist_tracks" {
		return b.tracks(ctx, list.Contents.Items)
	}
	var ops []*pb.Op
	var data any
	switch name {
	case "set_playlist_details":
		if a.Name == nil && a.Description == nil {
			return nil, failure("no_modifications")
		}
		ops = []*pb.Op{attributeOp(&pb.ListAttributes{Name: a.Name, Description: a.Description})}
		data = map[string]any{"ok": true}
	default:
		uris, e := trackURIs(a.URIs, name != "replace_playlist_tracks")
		if e != nil {
			return nil, e
		}
		switch name {
		case "add_tracks":
			if len(uris) > 0 {
				ops = []*pb.Op{addOp(uris)}
			}
			data = map[string]any{"added": len(uris)}
		case "replace_playlist_tracks":
			ops = replaceOps(len(list.Contents.Items), uris)
			data = map[string]any{"replaced": len(uris)}
		case "remove_tracks":
			targets := map[string]bool{}
			for _, uri := range uris {
				targets[uri] = true
			}
			for i := len(list.Contents.Items) - 1; i >= 0; i-- {
				if targets[list.Contents.Items[i].GetUri()] {
					ops = append(ops, removeOp(i, 1))
				}
			}
			data = map[string]any{"removed": len(ops)}
		}
	}
	if err = b.change(ctx, playlistPath(id), list.Revision, ops); err != nil {
		return nil, err
	}
	return data, nil
}
func isMutation(name string) bool {
	switch name {
	case "create_playlist", "delete_playlist", "add_tracks", "remove_tracks", "replace_playlist_tracks", "set_playlist_details":
		return true
	}
	return false
}
func (b *backend) handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	var req struct {
		Name string    `json:"name"`
		Args arguments `json:"args"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if decoder.Decode(&req) != nil {
		w.WriteHeader(400)
		json.NewEncoder(w).Encode(result{Code: "invalid_request"})
		return
	}
	if isMutation(req.Name) {
		b.mutation.Lock()
		defer b.mutation.Unlock()
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	data, err := b.execute(ctx, req.Name, req.Args)
	answer := result{OK: err == nil, Data: data}
	if err != nil {
		answer.Code = err.Error()
	}
	json.NewEncoder(w).Encode(answer)
}
func main() {
	statePath := os.Getenv("SPOTIFY_STATE_FILE")
	if statePath == "" {
		statePath = "/config/state.json"
	}
	events.Plugin = eventsimpl.Impl{}
	runtime, err := newAuthRuntime(statePath, os.Getenv("SPOTIFY_PAIRING_ENABLED") == "true")
	if err != nil {
		log.Fatal("headless session authentication failed")
	}
	defer runtime.close()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /tools/call", runtime.tools)
	mux.HandleFunc("GET /health", runtime.health)
	mux.HandleFunc("GET /auth", runtime.getAuth)
	mux.HandleFunc("POST /auth/start", runtime.startAuth)
	mux.HandleFunc("DELETE /auth", runtime.cancelAuth)
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = ":3679"
	}
	log.Print("headless tool service ready")
	server := &http.Server{Addr: address, Handler: serviceAuth(os.Getenv("SPOTIFY_SERVICE_SECRET"), mux), ReadHeaderTimeout: 5 * time.Second}
	log.Fatal(server.ListenAndServe())
}

func serviceAuth(secret string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if secret != "" && r.URL.Path != "/health" && subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
			authReply(w, 401, result{Code: "authentication_required"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Ensure the pinned library still provides the interface we depend on.
var _ requester = (*spclient.Spclient)(nil)
