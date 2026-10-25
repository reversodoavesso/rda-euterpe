# Standalone build: no desktop installation or prebuilt lab image is required.
FROM golang:1.25-bookworm AS spotify-build
ARG GO_LIBRESPOT_REV=bd3fa7407eb1ab595295446e1be50cb9663e69cb
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates build-essential pkg-config libasound2-dev libogg-dev libvorbis-dev libflac-dev libmpg123-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git init . && git remote add origin https://github.com/devgianlu/go-librespot.git && git fetch --depth 1 origin "$GO_LIBRESPOT_REV" && git checkout --detach FETCH_HEAD && rm -rf .git
COPY headless-lab/sidecar /src/cmd/euterpe-headless
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build go test -race ./cmd/euterpe-headless && go build -o /out/euterpe-headless ./cmd/euterpe-headless

FROM rust:1.99-bookworm AS daemon-build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY core/Cargo.toml core/Cargo.lock /build/core/
COPY core/src /build/core/src
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/build/core/target cd core && cargo build --locked --release && cp target/release/euterpe /euterpe

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates libssl3 libasound2 libogg0 libvorbis0a libvorbisenc2 libvorbisfile3 libflac12 libmpg123-0 && rm -rf /var/lib/apt/lists/*
COPY --from=spotify-build /out/euterpe-headless /usr/local/bin/euterpe-headless
COPY --from=spotify-build /src/LICENSE /usr/share/doc/euterpe-headless/LICENSE
COPY --from=daemon-build /euterpe /usr/local/bin/euterpe
COPY web /opt/euterpe-web
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WEB_DATA_DIR=/data
WORKDIR /opt/euterpe-web
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3)"
CMD ["python3", "server.py"]
