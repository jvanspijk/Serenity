FROM alpine:3.23 AS search-dependencies
RUN apk add --no-cache python3 py3-pip
COPY requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/search \
    && /opt/search/bin/pip install --no-cache-dir --only-binary=:all: -r /tmp/requirements.txt \
    && /opt/search/bin/pip uninstall -y pip

FROM node:24-alpine AS node-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM alpine:3.23

WORKDIR /app
ENV HOST=0.0.0.0 PORT=8080 DATA_DIR=/data PLUGIN_DIR=/data/plugins NODE_ENV=production SERENITY_PYTHON=/opt/search/bin/python
RUN apk add --no-cache nodejs python3 poppler-utils font-dejavu ffmpeg \
    && addgroup -S -g 1000 node \
    && adduser -S -D -H -u 1000 -G node node \
    && mkdir -p /data/chats /data/plugins \
    && chown -R node:node /data
COPY --from=search-dependencies /opt/search /opt/search
COPY --from=node-dependencies /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js multipart.js workspace.js audio.js tool-registry.js plugin-sdk.js plugin-runner.mjs mcp.js protocol.js ./
COPY --chown=node:node tools/ ./tools/
COPY --chown=node:node public/ ./public/
COPY --chown=node:node skills/ ./skills/

USER node
EXPOSE 8080
CMD ["node", "server.js"]
