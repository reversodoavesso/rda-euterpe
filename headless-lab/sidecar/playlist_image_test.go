package main

import (
	"strings"
	"testing"

	pb "github.com/devgianlu/go-librespot/proto/spotify/playlist4"
	"google.golang.org/protobuf/proto"
)

func TestPlaylistImageFormats(t *testing.T) {
	for _, tc := range []struct {
		attrs *pb.ListAttributes
		want  any
	}{
		{nil, nil},
		{&pb.ListAttributes{Picture: []byte(strings.Repeat("a", 20))}, "https://i.scdn.co/image/" + strings.Repeat("61", 20)},
		{&pb.ListAttributes{Picture: []byte("spotify:image:" + strings.Repeat("b", 40))}, "https://i.scdn.co/image/" + strings.Repeat("b", 40)},
		{&pb.ListAttributes{PictureSize: []*pb.PictureSize{{Url: proto.String("https://mosaic.scdn.co/640/cover")}}}, "https://mosaic.scdn.co/640/cover"},
		{&pb.ListAttributes{PictureSize: []*pb.PictureSize{{Url: proto.String("javascript:alert(1)")}}}, nil},
	} {
		if got := playlistImage(tc.attrs); got != tc.want {
			t.Fatalf("image=%v, want %v", got, tc.want)
		}
	}
}
