# Build the pinned upstream builder first; see MIGRATION.md.
FROM euterpe-headless-lab-go-build:bd3fa74 AS build
COPY sidecar /src/cmd/euterpe-headless
WORKDIR /src
RUN go test -race -v ./cmd/euterpe-headless && go build -o /euterpe-headless ./cmd/euterpe-headless

FROM alpine:3.23
RUN apk --no-cache add ca-certificates libgcc gcompat alsa-lib libogg libvorbis flac mpg123-libs
COPY --from=build /euterpe-headless /usr/bin/euterpe-headless
COPY --from=build /src/LICENSE /usr/share/licenses/go-librespot/LICENSE
# The migrated state was written by the upstream container (root, mode 0600).
# Mount it read-only; compose drops capabilities and makes the rootfs read-only.
ENTRYPOINT ["/usr/bin/euterpe-headless"]
