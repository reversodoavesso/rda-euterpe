package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	collection "github.com/devgianlu/go-librespot/proto/spotify/collection/v2"
	ext "github.com/devgianlu/go-librespot/proto/spotify/extendedmetadata"
	metadata "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/anypb"
)

type roundtrip func(*http.Request) (*http.Response, error)

func (f roundtrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestSearchNormalizesCategoriesWithoutNestedContamination(t *testing.T) {
	raw := json.RawMessage(`{"tracksV2":{"items":[{"item":{"data":{"uri":"spotify:track:1","name":"Song","album":{"uri":"spotify:album:wrong","name":"Wrong album"}}}}]},"artists":{"items":[{"data":{"uri":"spotify:artist:2","profile":{"name":"Artist"}}}]},"albumsV2":{"items":[{"data":{"uri":"spotify:album:3","name":"Album"}}]},"playlists":{"items":[{"data":{"uri":"spotify:playlist:4","name":"Playlist"}}]}}`)
	result, err := normalizeSearch(raw, 1)
	if err != nil {
		t.Fatal(err)
	}
	if result["artists"].([]map[string]any)[0]["name"] != "Artist" || result["albums"].([]map[string]any)[0]["id"] != "3" {
		t.Fatal("category contamination")
	}
	if _, err = normalizeSearch(json.RawMessage(`{"changedSchema":{}}`), 5); err == nil {
		t.Fatal("schema drift hidden as empty search")
	}
	empty, err := normalizeSearch(json.RawMessage(`{"tracksV2":{"items":[]}}`), 5)
	if err != nil || len(empty["tracks"].([]map[string]any)) != 0 {
		t.Fatal("empty search rejected")
	}
}

func TestPathfinderRenewsOnlyOnceOn401AndNeverLeaksErrors(t *testing.T) {
	calls, refresh := 0, 0
	p := &pathfinderClient{clientToken: func() string { return "client-secret" }, token: func(_ context.Context, force bool) (string, error) {
		if force {
			refresh++
		}
		return "access-secret", nil
	}}
	p.client = &http.Client{Transport: roundtrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "api-partner.spotify.com" || r.Header.Get("Client-Token") != "client-secret" || r.Header.Get("Authorization") != "Bearer access-secret" {
			t.Fatal("wrong authenticated request")
		}
		body, _ := io.ReadAll(r.Body)
		if !bytes.Contains(body, []byte(searchHash)) {
			t.Fatal("query identifier missing")
		}
		status := 200
		payload := `{"data":{"searchV2":{"tracksV2":{"items":[]}}}}`
		if calls == 1 {
			status = 401
			payload = ""
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(payload))}, nil
	})}
	if _, err := p.search(context.Background(), "test", 3); err != nil || calls != 2 || refresh != 1 {
		t.Fatal("token renewal contract", err)
	}
	p.client.Transport = roundtrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"errors":[{"message":"secret query token = do not expose"}]}`))}, nil
	})
	if _, err := p.search(context.Background(), "private", 3); err == nil || err.Error() != "search_graphql_error" {
		t.Fatal("raw errors exposed")
	}
}

type collectionFake struct {
	*fake
	pages    []*collection.PageResponse
	requests []*collection.PageRequest
	status   int
}

func (f *collectionFake) Request(ctx context.Context, m, p string, q url.Values, h http.Header, data []byte) (*http.Response, error) {
	if p != "/collection/v2/paging" {
		return f.fake.Request(ctx, m, p, q, h, data)
	}
	request := new(collection.PageRequest)
	proto.Unmarshal(data, request)
	f.requests = append(f.requests, request)
	if m != "POST" || h.Get("Content-Type") != "application/vnd.collection-v2.spotify.proto" {
		return nil, failure("bad_collection_request")
	}
	page := f.pages[0]
	if len(f.pages) > 1 {
		f.pages = f.pages[1:]
	}
	status := f.status
	if status == 0 {
		status = 200
	}
	return response(page, status), nil
}
func TestLikedPagingFiltersSortsAndPreservesAddedDate(t *testing.T) {
	f := &collectionFake{fake: &fake{}, pages: []*collection.PageResponse{
		{Items: []*collection.CollectionItem{{Uri: a, AddedAt: 100}, {Uri: "spotify:album:ignored", AddedAt: 300}}, NextPageToken: "next"},
		{Items: []*collection.CollectionItem{{Uri: b, AddedAt: 200}, {Uri: "spotify:track:removed", AddedAt: 250, IsRemoved: true}}},
	}}
	tracks, err := (&backend{sp: f, username: "test"}).savedTracks(context.Background(), 1, 1)
	if err != nil || len(tracks) != 1 || tracks[0]["uri"] != a || tracks[0]["added_at"] != "1970-01-01T00:01:40Z" {
		t.Fatal("liked contract", err)
	}
	if len(f.requests) != 2 || f.requests[1].PaginationToken != "next" || f.requests[0].Username != "test" {
		t.Fatal("collection pagination")
	}
}
func TestLikedPagingLoopFailsWithoutPartialSuccess(t *testing.T) {
	f := &collectionFake{fake: &fake{}, pages: []*collection.PageResponse{{NextPageToken: "repeat", Items: []*collection.CollectionItem{{Uri: a}}}}}
	tracks, err := (&backend{sp: f}).savedTracks(context.Background(), 1, 0)
	if tracks != nil || err == nil || err.Error() != "collection_pagination_loop" {
		t.Fatal("paging loop hidden")
	}
}

func TestLikedConflictingPagesFailAndMissingDatesAreNotInvented(t *testing.T) {
	f := &collectionFake{fake: &fake{}, pages: []*collection.PageResponse{
		{Items: []*collection.CollectionItem{{Uri: a, AddedAt: 100}}, NextPageToken: "next"},
		{Items: []*collection.CollectionItem{{Uri: a, IsRemoved: true}}},
	}}
	if tracks, err := (&backend{sp: f}).savedTracks(context.Background(), 3, 0); err == nil || tracks != nil || err.Error() != "collection_changed" {
		t.Fatal("conflicting pages silently merged")
	}
	f = &collectionFake{fake: &fake{}, pages: []*collection.PageResponse{{Items: []*collection.CollectionItem{{Uri: a}}}}}
	tracks, err := (&backend{sp: f}).savedTracks(context.Background(), 3, 0)
	if err != nil || tracks[0]["added_at"] != nil {
		t.Fatal("missing date invented", err)
	}
}

type metadataFake struct{ *fake }

func (f *metadataFake) ExtendedMetadata(ctx context.Context, request *ext.BatchedEntityRequest) (*ext.BatchedExtensionResponse, error) {
	data, _ := anypb.New(&metadata.Track{Name: proto.String("Track"), Artist: []*metadata.Artist{{Name: proto.String("Artist"), Gid: make([]byte, 16)}}, Duration: proto.Int32(123)})
	return &ext.BatchedExtensionResponse{ExtendedMetadata: []*ext.EntityExtensionDataArray{{ExtensionKind: ext.ExtensionKind_TRACK_V4, ExtensionData: []*ext.EntityExtensionData{{EntityUri: a, Header: &ext.EntityExtensionDataHeader{StatusCode: 200}, ExtensionData: data}}}}}, nil
}
func TestBatchMetadataPreservesDuplicatesAndMissingPositions(t *testing.T) {
	result, err := (&backend{sp: &metadataFake{&fake{}}}).severalTracks(context.Background(), []string{strings.TrimPrefix(a, "spotify:track:"), b, a})
	if err != nil || len(result) != 3 || result[0]["name"] != "Track" || result[1]["metadata_unavailable"] != true || result[2]["uri"] != a {
		t.Fatal("metadata order", err)
	}
	if len(result[0]["artist_ids"].([]string)) != 1 {
		t.Fatal("artist ids lost")
	}
}
func TestResolutionIsBoundedParallelOrderedAndDeduplicated(t *testing.T) {
	var active, peak atomic.Int32
	service := &backend{searcher: func(ctx context.Context, q string, n int) (map[string]any, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for old := peak.Load(); current > old; old = peak.Load() {
			if peak.CompareAndSwap(old, current) {
				break
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(15 * time.Millisecond):
		}
		return map[string]any{"tracks": []map[string]any{{"uri": a, "name": q}}}, nil
	}}
	inputs := rawTracks("first", "second", "third", "fourth", "fifth", "sixth", "seventh", a)
	result, err := service.resolve(context.Background(), inputs)
	if err != nil {
		t.Fatal(err)
	}
	rows := result["results"].([]map[string]any)
	if rows[0]["matched_title"] != "first" || rows[6]["matched_title"] != "seventh" || result["resolved_count"] != 1 || peak.Load() < 2 || peak.Load() > 6 {
		t.Fatal("resolution concurrency/order")
	}
}
func TestUnresolvedCreationNeverWrites(t *testing.T) {
	f := &fake{}
	service := &backend{sp: f, searcher: func(context.Context, string, int) (map[string]any, error) {
		return map[string]any{"tracks": []map[string]any{}}, nil
	}}
	_, err := service.execute(context.Background(), "create_playlist", arguments{Name: proto.String("test"), Tracks: rawTracks("unknown")})
	if err == nil || err.Error() != "unresolved_tracks" || len(f.writes) != 0 {
		t.Fatal("partial playlist created")
	}
}
