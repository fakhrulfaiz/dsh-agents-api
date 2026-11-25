# Agentry API: DeepSeek Harness at the pinned tag (dsh.pin) with this plugin, in one image.
# Build: docker build --build-arg DSH_TAG=$(cat dsh.pin) -t agentry-api .
# Run:   see docker/README.md (Postgres, keys, the data volume).
# No configuration is baked in: keys, the database URL and the model credentials come from the
# environment when the container starts.

ARG DSH_TAG=dsh-v0.2.2-rc.1
ARG SANDBOX_REF=main

FROM node:24.19.0-bookworm AS build
ARG DSH_TAG
ARG SANDBOX_REF
RUN npm install -g pnpm@11.28.5
WORKDIR /opt

# DeepSeek Harness, built once (about 5 minutes; cached while the tag stays the same).
RUN git clone --depth 1 --branch "$DSH_TAG" https://github.com/deepseek-ai/deepseek-harness.git dsh
RUN cd dsh && pnpm install --frozen-lockfile && pnpm run build:artifacts
# The Office runtime (pinned Python, Node and pnpm with python-docx, openpyxl, ...) and the Office
# skills, for `skill-office` and `workspace-dependencies` (AGENTRY_OFFICE_RUNTIME below).
RUN cd dsh && pnpm run prepare:primary-runtime --target linux-x64 --output /opt/office-runtime --cache /tmp/runtime-cache \
 && rm -rf /tmp/runtime-cache

# The Agentry Sandbox client, a sibling the plugin links (`link:../agentry-sandbox`) and bundles.
RUN git clone https://github.com/fakhrulfaiz/agentry-sandbox.git agentry-sandbox \
 && cd agentry-sandbox && git checkout "$SANDBOX_REF" && pnpm install --frozen-lockfile

# This plugin.
COPY . /opt/dsh-agents-api
RUN cd dsh-agents-api && pnpm install --frozen-lockfile && DSH_ROOT=/opt/dsh pnpm build

FROM node:24.19.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git tini procps \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /opt/dsh /opt/dsh
COPY --from=build --chown=node:node /opt/dsh-agents-api /opt/dsh-agents-api
COPY --from=build --chown=node:node /opt/office-runtime /opt/office-runtime
COPY --chown=node:node docker/profile /opt/agentry/profile
COPY --chown=node:node docker/entrypoint.sh /opt/agentry/entrypoint.sh
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOME=/home/node DSH_HOME=/data/dsh AGENTRY_WORKSPACES=/data/workspaces AGENTRY_UPLOADS_DIR=/data/uploads \
    AGENTRY_OFFICE_RUNTIME=/opt/office-runtime/primary-runtime \
    PORT=3080 DSH_TELEMETRY_DISABLED=1 NODE_ENV=production
VOLUME /data
EXPOSE 3080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://'+require('os').hostname()+':'+(process.env.PORT||3080)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/agentry/entrypoint.sh"]
