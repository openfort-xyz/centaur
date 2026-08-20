# syntax=docker/dockerfile:1.7

FROM golang:1.26.6-alpine@sha256:3889b425f035be855a72fb4755265311293b6d414521f0a519d819df32222d83 AS build

ARG IRON_PROXY_REF=c8724937fbe109b7fbc6ddb21490e15902b187c0
RUN apk add --no-cache git
WORKDIR /src
RUN git init \
    && git remote add origin https://github.com/ironsh/iron-proxy.git \
    && git fetch --depth 1 origin "${IRON_PROXY_REF}" \
    && git checkout --detach FETCH_HEAD \
    && go get golang.org/x/net@v0.56.0 golang.org/x/text@v0.39.0 google.golang.org/grpc@v1.82.1 \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X github.com/ironsh/iron-proxy/internal/version.Version=0.49.0" -o /iron-proxy ./cmd/iron-proxy

FROM ironsh/iron-proxy:0.49.0@sha256:c4628019c24f4cc8d77564a26b7c9cedb00accee6f93d06270e85fb8f9c6a7da

USER root
RUN --mount=type=cache,target=/var/cache/apk,sharing=locked \
    apk add --update-cache --cache-dir /var/cache/apk curl jq

COPY --from=build /iron-proxy /usr/local/bin/iron-proxy
COPY services/iron-proxy/iron-proxy.yaml /usr/local/share/iron-proxy/proxy.yaml.default
COPY --chmod=755 services/iron-proxy/entrypoint.sh /entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
