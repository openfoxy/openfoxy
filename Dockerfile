FROM alpine:latest

RUN apk add --no-cache nodejs npm squid apache2-utils dante-server curl tar iptables iproute2 bash

WORKDIR /app
COPY package.json index.js ./

RUN chmod +x /app/index.js && npm link

ENTRYPOINT ["openfoxy", "docker"]