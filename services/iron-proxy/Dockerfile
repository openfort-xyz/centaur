# syntax=docker/dockerfile:1.7

# The published v0.56.0 binary is built against go-jose 4.1.4, x/net 0.58.0 and
# grpc 1.83.0, which carry HIGH CVEs. Rebuild the same tagged source with patched
# modules, the way upstream's goreleaser does (CGO off, version ldflag). Drop this
# stage once a release ships the fixes.
FROM --platform=$BUILDPLATFORM golang:1.27.3-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS iron-proxy-build
ARG TARGETOS
ARG TARGETARCH
ARG IRON_PROXY_VERSION=0.56.0
ARG IRON_PROXY_COMMIT=3d96ce8dd2ca093051b75ccb0c9e5e1db52d1c04
RUN apk add --no-cache git
WORKDIR /src
RUN git init . \
    && git remote add origin https://github.com/paradigmxyz/iron-proxy.git \
    && git fetch --depth 1 origin "${IRON_PROXY_COMMIT}" \
    && git checkout --detach FETCH_HEAD \
    && go get github.com/go-jose/go-jose/v4@v4.1.6 golang.org/x/net@v0.60.0 google.golang.org/grpc@v1.83.2 \
    && go mod tidy \
    && CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" go build -trimpath \
      -ldflags "-s -w -X github.com/ironsh/iron-proxy/internal/version.Version=${IRON_PROXY_VERSION}" \
      -o /out/iron-proxy ./cmd/iron-proxy

FROM ironsh/iron-proxy:0.56.0@sha256:727da0cc35a6d73ed2913a38d56c4b9b4476c075149492e4fbf75552e83361ff

USER root
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --update-cache --cache-dir /var/cache/apk curl jq

COPY --from=iron-proxy-build /out/iron-proxy /usr/local/bin/iron-proxy
COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
