package main

import (
	"encoding/hex"
	"net/url"
	"strings"

	pb "github.com/devgianlu/go-librespot/proto/spotify/playlist4"
)

// The decorated rootlist includes custom covers and generated mosaics. Prefer
// its public HTTPS URL; a raw picture is a Spotify image ID, not image bytes.
func playlistImage(attrs *pb.ListAttributes) any {
	for _, picture := range attrs.GetPictureSize() {
		if image := playlistImageURL(picture.GetUrl()); image != "" {
			return image
		}
	}
	picture := attrs.GetPicture()
	if image := playlistImageURL(string(picture)); image != "" {
		return image
	}
	if len(picture) == 20 {
		return "https://i.scdn.co/image/" + hex.EncodeToString(picture)
	}
	return nil
}

func playlistImageURL(raw string) string {
	if strings.HasPrefix(raw, "spotify:image:") {
		id := strings.TrimPrefix(raw, "spotify:image:")
		if decoded, err := hex.DecodeString(id); err == nil && len(decoded) == 20 {
			return "https://i.scdn.co/image/" + id
		}
		return ""
	}
	u, err := url.Parse(raw)
	if err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil {
		return raw
	}
	return ""
}
