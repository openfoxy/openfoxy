# syntax=docker/dockerfile:1
FROM alpine:3.24 AS mtg
ARG TARGETARCH
ARG MTG_VERSION=2.2.8
RUN apk add --no-cache curl \
  && curl -fsSL "https://github.com/9seconds/mtg/releases/download/v${MTG_VERSION}/mtg-${MTG_VERSION}-linux-${TARGETARCH}.tar.gz" \
  | tar -xz -C /tmp \
  && mv /tmp/mtg-*/mtg /usr/local/bin/mtg

FROM alpine:3.24
RUN apk add --no-cache nodejs squid apache2-utils dante-server iproute2
COPY --from=mtg /usr/local/bin/mtg /usr/local/bin/mtg
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
RUN ln -s /app/bin/openfoxy.js /usr/local/bin/openfoxy
ENTRYPOINT ["openfoxy", "docker"]
