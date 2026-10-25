package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"testing"

	ext "github.com/devgianlu/go-librespot/proto/spotify/extendedmetadata"
	pb "github.com/devgianlu/go-librespot/proto/spotify/playlist4"
	"google.golang.org/protobuf/proto"
)

type fake struct {
	pages   []*pb.SelectedListContent
	offsets []string
	writes  []*pb.ListChanges
	status  int
	lost    bool
	resync  bool
}

func response(value proto.Message, status int) *http.Response {
	data, _ := proto.Marshal(value)
	return &http.Response{StatusCode: status, Body: io.NopCloser(bytes.NewReader(data))}
}
func (f *fake) Request(ctx context.Context, m, p string, q url.Values, h http.Header, b []byte) (*http.Response, error) {
	f.offsets = append(f.offsets, q.Get("from"))
	page := f.pages[0]
	if len(f.pages) > 1 {
		f.pages = f.pages[1:]
	}
	return response(page, 200), nil
}
func (f *fake) RequestOnce(ctx context.Context, m, p string, q url.Values, h http.Header, b []byte) (*http.Response, error) {
	change := new(pb.ListChanges)
	if err := proto.Unmarshal(b, change); err != nil {
		return nil, err
	}
	f.writes = append(f.writes, change)
	if f.lost {
		return nil, errors.New("connection lost")
	}
	status := f.status
	if status == 0 {
		status = 200
	}
	return response(&pb.SelectedListContent{Revision: []byte("next"), ChangesRequireResync: proto.Bool(f.resync)}, status), nil
}
func (f *fake) ExtendedMetadata(context.Context, *ext.BatchedEntityRequest) (*ext.BatchedExtensionResponse, error) {
	return &ext.BatchedExtensionResponse{}, nil
}
func page(revision string, truncated bool, uris ...string) *pb.SelectedListContent {
	items := []*pb.Item{}
	for _, uri := range uris {
		items = append(items, &pb.Item{Uri: proto.String(uri)})
	}
	return &pb.SelectedListContent{Revision: []byte(revision), Contents: &pb.ListItems{Pos: proto.Int32(0), Truncated: proto.Bool(truncated), Items: items}}
}

const pid = "0000000000000000000001"
const a = "spotify:track:0000000000000000000001"
const b = "spotify:track:0000000000000000000002"

func TestReadPagesAndRevisionConflict(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("r", true, a), page("r", false, b)}}
	service := &backend{sp: f}
	list, err := service.read(context.Background(), "/playlist")
	if err != nil || len(list.Contents.Items) != 2 || f.offsets[1] != "1" {
		t.Fatal("pagination incomplete", err)
	}
	f.pages = []*pb.SelectedListContent{page("r", true, a), page("s", false, b)}
	if _, err = service.read(context.Background(), "/playlist"); err == nil || err.Error() != "playlist_conflict" {
		t.Fatal("mixed revisions accepted")
	}
}
func TestRejectTruncatedOrIncompleteRead(t *testing.T) {
	for _, p := range []*pb.SelectedListContent{page("r", true), page("r", false, a)} {
		if !p.Contents.GetTruncated() {
			p.Length = proto.Int32(2)
		}
		f := &fake{pages: []*pb.SelectedListContent{p}}
		if _, err := (&backend{sp: f}).read(context.Background(), "/playlist"); err == nil {
			t.Fatal("incomplete snapshot accepted")
		}
	}
}
func TestReplaceIsOneChangeAndPreservesDuplicates(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("r", false, a, b)}}
	_, err := (&backend{sp: f}).execute(context.Background(), "replace_playlist_tracks", arguments{PlaylistID: pid, URIs: []string{b, a, a}})
	if err != nil || len(f.writes) != 1 {
		t.Fatal("replace not atomic", err)
	}
	ops := f.writes[0].Deltas[0].Ops
	if len(ops) != 2 || ops[0].Rem.GetLength() != 2 || len(ops[1].Add.Items) != 3 || ops[1].Add.Items[2].GetUri() != a {
		t.Fatal("replace lost order/duplicates")
	}
	if !bytes.Equal(f.writes[0].BaseRevision, []byte("r")) {
		t.Fatal("revision not used")
	}
}
func TestRemoveAllOccurrencesByDescendingPosition(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("r", false, a, b, a)}}
	data, err := (&backend{sp: f}).execute(context.Background(), "remove_tracks", arguments{PlaylistID: pid, URIs: []string{a}})
	if err != nil || data.(map[string]any)["removed"] != 2 {
		t.Fatal("remove count", err)
	}
	ops := f.writes[0].Deltas[0].Ops
	if ops[0].Rem.GetFromIndex() != 2 || ops[1].Rem.GetFromIndex() != 0 {
		t.Fatal("wrong removal positions")
	}
}
func TestAppendDeduplicatesInputAndAppends(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("r", false, a)}}
	_, err := (&backend{sp: f}).execute(context.Background(), "add_tracks", arguments{PlaylistID: pid, URIs: []string{b, b, a}})
	if err != nil {
		t.Fatal(err)
	}
	add := f.writes[0].Deltas[0].Ops[0].Add
	if !add.GetAddLast() || len(add.Items) != 2 {
		t.Fatal("append contract")
	}
}
func TestDescriptionCanBeClearedWithoutRenaming(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("r", false)}}
	_, err := (&backend{sp: f}).execute(context.Background(), "set_playlist_details", arguments{PlaylistID: pid, Description: proto.String("")})
	if err != nil {
		t.Fatal(err)
	}
	values := f.writes[0].Deltas[0].Ops[0].UpdateListAttributes.NewAttributes.Values
	if values.Name != nil || values.Description == nil || *values.Description != "" {
		t.Fatal("description patch corrupted")
	}
}
func TestUnknownOutcomeAndConflictNeverRetry(t *testing.T) {
	for _, f := range []*fake{{lost: true}, {status: 409}} {
		service := &backend{sp: f}
		err := service.change(context.Background(), "/playlist", []byte("r"), []*pb.Op{addOp([]string{a})})
		if err == nil || len(f.writes) != 1 {
			t.Fatal("mutation repeated")
		}
		if f.lost && err.Error() != "headless_outcome_unknown" {
			t.Fatal(err)
		}
		if f.status == 409 && err.Error() != "playlist_conflict" {
			t.Fatal(err)
		}
	}
}

func TestCreateAndFollowWithResyncAdvisory(t *testing.T) {
	f := &fake{pages: []*pb.SelectedListContent{page("root", false)}, resync: true}
	data, err := (&backend{sp: f, username: "test"}).execute(context.Background(), "create_playlist", arguments{Name: proto.String("test"), Tracks: rawTracks(a, b, a)})
	if err != nil || len(f.writes) != 2 {
		t.Fatal("successful change treated as failure", err)
	}
	if data.(map[string]any)["added"] != 3 {
		t.Fatal("creation changed the reviewed track count")
	}
	follow := f.writes[1].Deltas[0].Ops[0].Add
	if follow.FromIndex == nil || *follow.FromIndex != 0 || follow.Items[0].Attributes.GetPublic() {
		t.Fatal("rootlist follow contract")
	}
}

func rawTracks(values ...string) []json.RawMessage {
	out := []json.RawMessage{}
	for _, s := range values {
		raw, _ := json.Marshal(s)
		out = append(out, raw)
	}
	return out
}
func TestUnsupportedAndInvalidIDsNeverWrite(t *testing.T) {
	f := &fake{}
	service := &backend{sp: f}
	for _, req := range []struct {
		name string
		args arguments
	}{{"get_recommendations", arguments{}}, {"get_playlist_tracks", arguments{PlaylistID: "../../secret"}}, {"get_playlist_tracks", arguments{PlaylistID: "zzzzzzzzzzzzzzzzzzzzzz"}}} {
		if _, err := service.execute(context.Background(), req.name, req.args); err == nil {
			t.Fatal("invalid request accepted")
		}
	}
	if len(f.writes) > 0 {
		t.Fatal("unsupported request wrote data")
	}
}
func TestUnavailableMetadataRetainsOrderAndDuplicates(t *testing.T) {
	service := &backend{sp: &fake{}}
	tracks, err := service.tracks(context.Background(), page("r", false, a, a, "spotify:local:unavailable").Contents.Items)
	if err != nil || len(tracks) != 3 || tracks[1]["uri"] != a || tracks[2]["uri"] != "spotify:local:unavailable" {
		t.Fatal("snapshot lost items")
	}
}
