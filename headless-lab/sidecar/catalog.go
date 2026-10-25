package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	collection "github.com/devgianlu/go-librespot/proto/spotify/collection/v2"
	pb "github.com/devgianlu/go-librespot/proto/spotify/playlist4"
	"google.golang.org/protobuf/proto"
)

// Keep the session's client token in memory for Pathfinder. Login5 puts this
// header on its own requests; no token extraction endpoint is exposed.
type sessionTransport struct {
	base  http.RoundTripper
	mu    sync.RWMutex
	value string
}

func (t *sessionTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if token := r.Header.Get("Client-Token"); token != "" {
		t.mu.Lock()
		t.value = token
		t.mu.Unlock()
	}
	return t.base.RoundTrip(r)
}
func (t *sessionTransport) clientToken() string { t.mu.RLock(); defer t.mu.RUnlock(); return t.value }

type pathfinderClient struct {
	client      *http.Client
	token       func(context.Context, bool) (string, error)
	clientToken func() string
}

// Query identifier already verified by the NTify protocol/public probes. We
// implement the wire request here; NTify is not linked into the service.
const searchHash = "fcad5a3e0d5af727fb76966f06971c19cfa2275e6ff7671196753e008611873c"

func (p *pathfinderClient) search(ctx context.Context, q string, limit int) (map[string]any, error) {
	payload, _ := json.Marshal(map[string]any{
		"operationName": "searchDesktop",
		"variables":     map[string]any{"searchTerm": q, "offset": 0, "limit": limit, "numberOfTopResults": 5, "includeAudiobooks": false, "includeArtistHasConcertsField": false, "includePreReleases": false, "includeAuthors": false},
		"extensions":    map[string]any{"persistedQuery": map[string]any{"version": 1, "sha256Hash": searchHash}},
	})
	for attempt := 0; attempt < 2; attempt++ {
		token, err := p.token(ctx, attempt == 1)
		if err != nil {
			return nil, failure("headless_auth_unavailable")
		}
		req, _ := http.NewRequestWithContext(ctx, "POST", "https://api-partner.spotify.com/pathfinder/v2/query", bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Client-Token", p.clientToken())
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		req.Header.Set("App-Platform", "WebPlayer")
		req.Header.Set("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")
		response, err := p.client.Do(req)
		if err != nil {
			return nil, failure("search_unavailable")
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 16<<20))
		response.Body.Close()
		if response.StatusCode == 401 && attempt == 0 {
			continue
		}
		if response.StatusCode != 200 {
			return nil, failure(fmt.Sprintf("spotify_status_%d", response.StatusCode))
		}
		if readErr != nil {
			return nil, failure("invalid_search_response")
		}
		var root struct {
			Data   map[string]json.RawMessage `json:"data"`
			Errors []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		if json.Unmarshal(data, &root) != nil {
			return nil, failure("invalid_search_response")
		}
		if len(root.Errors) > 0 {
			for _, e := range root.Errors {
				if strings.Contains(e.Message, "PersistedQueryNotFound") {
					return nil, failure("search_query_outdated")
				}
			}
			return nil, failure("search_graphql_error")
		}
		return normalizeSearch(root.Data["searchV2"], limit)
	}
	return nil, failure("headless_auth_unavailable")
}

// Each category is parsed on its own. Walking the whole response recursively
// would turn a track's album/artists into unrelated search results.
func normalizeSearch(raw json.RawMessage, limit int) (map[string]any, error) {
	var categories map[string]json.RawMessage
	if json.Unmarshal(raw, &categories) != nil || categories == nil {
		return nil, failure("invalid_search_response")
	}
	out := map[string]any{"source": "headless_pathfinder"}
	keys := map[string][]string{"tracks": {"tracksV2", "tracks"}, "artists": {"artists"}, "albums": {"albumsV2", "albums"}, "playlists": {"playlists"}}
	recognized := false
	for bucket, alternatives := range keys {
		rows := []map[string]any{}
		seen := map[string]bool{}
		prefix := "spotify:" + strings.TrimSuffix(bucket, "s") + ":"
		for _, key := range alternatives {
			rawPage, exists := categories[key]
			if !exists {
				continue
			}
			recognized = true
			var page struct {
				Items []json.RawMessage `json:"items"`
			}
			if json.Unmarshal(rawPage, &page) != nil {
				return nil, failure("invalid_search_response")
			}
			for _, item := range page.Items {
				var node map[string]json.RawMessage
				if json.Unmarshal(item, &node) != nil {
					return nil, failure("invalid_search_response")
				}
				// TrackItem uses item.data; other categories usually use data.
				for depth := 0; depth < 4; depth++ {
					var uri, name string
					json.Unmarshal(node["uri"], &uri)
					json.Unmarshal(node["name"], &name)
					if name == "" {
						var profile struct {
							Name string `json:"name"`
						}
						json.Unmarshal(node["profile"], &profile)
						name = profile.Name
					}
					if strings.HasPrefix(uri, prefix) && name != "" {
						if !seen[uri] && len(rows) < limit {
							rows = append(rows, map[string]any{"id": strings.TrimPrefix(uri, prefix), "uri": uri, "name": name})
							seen[uri] = true
						}
						break
					}
					wrapped := node["data"]
					if len(wrapped) == 0 {
						wrapped = node["item"]
					}
					if len(wrapped) == 0 {
						break
					}
					var next map[string]json.RawMessage
					if json.Unmarshal(wrapped, &next) != nil {
						break
					}
					node = next
				}
			}
			break
		}
		out[bucket] = rows
	}
	if !recognized {
		return nil, failure("invalid_search_response")
	}
	return out, nil
}

func (b *backend) search(ctx context.Context, a arguments) (map[string]any, error) {
	if strings.TrimSpace(a.Q) == "" || len(a.Q) > 1000 {
		return nil, failure("invalid_search_query")
	}
	limit := a.Limit
	if limit <= 0 {
		limit = 20
	}
	limit = min(limit, 50)
	allowed := map[string]bool{"track": true, "artist": true, "album": true, "playlist": true}
	if a.Types != "" {
		for _, kind := range strings.Split(a.Types, ",") {
			if !allowed[strings.TrimSpace(kind)] {
				return nil, failure("unsupported_search_type")
			}
		}
	}
	if b.searcher == nil {
		return nil, failure("search_unavailable")
	}
	return b.searcher(ctx, a.Q, limit)
}

func (b *backend) savedTracks(ctx context.Context, limit, offset int) ([]map[string]any, error) {
	if offset < 0 || offset > 50000 {
		return nil, failure("invalid_offset")
	}
	if limit <= 0 {
		limit = 25000
	}
	if limit > 25000 {
		return nil, failure("too_many_tracks")
	}
	token := ""
	seen := map[string]bool{}
	latest := map[string]*collection.CollectionItem{}
	for page := 0; ; page++ {
		if page == 100 {
			return nil, failure("collection_page_limit")
		}
		payload, _ := proto.Marshal(&collection.PageRequest{Username: b.username, Set: "collection", PaginationToken: token, Limit: 500})
		response, err := b.sp.Request(ctx, "POST", "/collection/v2/paging", nil, http.Header{"Content-Type": {"application/vnd.collection-v2.spotify.proto"}, "Accept": {"application/vnd.collection-v2.spotify.proto"}}, payload)
		if err != nil {
			return nil, failure("collection_unavailable")
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, 16<<20))
		response.Body.Close()
		if response.StatusCode != 200 {
			return nil, failure(fmt.Sprintf("spotify_status_%d", response.StatusCode))
		}
		current := new(collection.PageResponse)
		if readErr != nil || proto.Unmarshal(data, current) != nil {
			return nil, failure("invalid_collection_response")
		}
		for _, item := range current.GetItems() {
			if !strings.HasPrefix(item.GetUri(), "spotify:track:") {
				continue
			}
			old := latest[item.Uri]
			if old != nil && (old.AddedAt != item.AddedAt || old.IsRemoved != item.IsRemoved) {
				return nil, failure("collection_changed")
			}
			if old == nil {
				latest[item.Uri] = item
			}
		}
		token = current.GetNextPageToken()
		if token == "" {
			break
		}
		if seen[token] {
			return nil, failure("collection_pagination_loop")
		}
		seen[token] = true
	}
	rows := []*collection.CollectionItem{}
	for _, item := range latest {
		if !item.IsRemoved {
			rows = append(rows, item)
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].AddedAt == rows[j].AddedAt {
			return rows[i].Uri < rows[j].Uri
		}
		return rows[i].AddedAt > rows[j].AddedAt
	})
	start := min(offset, len(rows))
	end := min(start+limit, len(rows))
	items := []*pb.Item{}
	for _, row := range rows[start:end] {
		items = append(items, &pb.Item{Uri: proto.String(row.Uri)})
	}
	tracks, err := b.tracks(ctx, items)
	if err != nil {
		return nil, err
	}
	for i, track := range tracks {
		track["added_at"] = nil
		if rows[start+i].AddedAt > 0 {
			track["added_at"] = time.Unix(rows[start+i].AddedAt, 0).UTC().Format(time.RFC3339)
		}
	}
	return tracks, nil
}

func (b *backend) severalTracks(ctx context.Context, ids []string) ([]map[string]any, error) {
	if len(ids) > 50 {
		return nil, failure("too_many_tracks")
	}
	items := []*pb.Item{}
	for _, raw := range ids {
		uri := raw
		if !strings.HasPrefix(uri, "spotify:track:") {
			uri = "spotify:track:" + uri
		}
		if _, err := trackURIs([]string{uri}, false); err != nil {
			return nil, err
		}
		items = append(items, &pb.Item{Uri: proto.String(uri)})
	}
	return b.tracks(ctx, items)
}

func (b *backend) resolve(ctx context.Context, items []json.RawMessage) (map[string]any, error) {
	if len(items) > 100 {
		return nil, failure("too_many_tracks")
	}
	results := make([]map[string]any, len(items))
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	jobs := make(chan int)
	errors := make(chan error, 1)
	var workers sync.WaitGroup
	for worker := 0; worker < min(6, len(items)); worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for index := range jobs {
				row, err := b.resolveOne(ctx, items[index])
				if err != nil {
					select {
					case errors <- err:
					default:
					}
					cancel()
					return
				}
				results[index] = row
			}
		}()
	}
queue:
	for i := range items {
		select {
		case jobs <- i:
		case <-ctx.Done():
			break queue
		}
	}
	close(jobs)
	workers.Wait()
	select {
	case err := <-errors:
		return nil, err
	default:
	}
	if ctx.Err() != nil {
		return nil, failure("resolution_cancelled")
	}
	uris := []string{}
	seen := map[string]bool{}
	for _, row := range results {
		if uri, ok := row["uri"].(string); ok && !seen[uri] {
			uris = append(uris, uri)
			seen[uri] = true
		}
	}
	return map[string]any{"results": results, "uris": uris, "resolved_count": len(uris), "total": len(items)}, nil
}

func (b *backend) resolveOne(ctx context.Context, raw json.RawMessage) (map[string]any, error) {
	var text string
	var item struct {
		Artist string `json:"artist"`
		Title  string `json:"title"`
		URI    string `json:"uri"`
	}
	if json.Unmarshal(raw, &text) == nil {
		text = strings.TrimSpace(text)
		if strings.HasPrefix(text, "spotify:track:") {
			item.URI = strings.TrimSpace(text)
		} else if parts := strings.SplitN(text, " - ", 2); len(parts) == 2 {
			item.Artist = strings.TrimSpace(parts[0])
			item.Title = strings.TrimSpace(parts[1])
		} else {
			item.Title = strings.TrimSpace(text)
		}
	} else if json.Unmarshal(raw, &item) != nil {
		return nil, failure("invalid_track_item")
	}
	row := map[string]any{"artist": item.Artist, "title": item.Title, "uri": nil, "matched": false}
	if item.URI != "" {
		if _, err := trackURIs([]string{item.URI}, false); err != nil {
			return nil, err
		}
		row["uri"] = item.URI
		row["matched"] = true
		row["source"] = "uri"
	} else if q := strings.TrimSpace(item.Artist + " " + item.Title); q != "" {
		found, err := b.search(ctx, arguments{Q: q, Limit: 3, Types: "track"})
		if err != nil {
			return nil, err
		}
		tracks := found["tracks"].([]map[string]any)
		if len(tracks) > 0 {
			row["uri"] = tracks[0]["uri"]
			row["matched"] = true
			row["matched_title"] = tracks[0]["name"]
			row["source"] = "headless_pathfinder"
		}
	}
	return row, nil
}
