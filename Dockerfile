# file-bridge: one TypeScript file, run by Node directly (type stripping), and the web
# page it serves to people (the ui/ folder). There is no build step, and the server has
# no dependencies; the page brings two libraries with it in ui/vendor/.
#
# GitHub Actions builds this on every push to main (.github/workflows/image.yaml).
#
# Try it by hand:
#   docker build -t file-bridge:scratch .
#   docker run --rm -p 127.0.0.1:8080:8080 file-bridge:scratch
#   curl http://127.0.0.1:8080/list

FROM node:26-alpine
# A fixed non-root user. On the cluster the volume is mounted at /srv/files and
# must be writable by this user (fsGroup 65532 in the pod).
RUN addgroup -S -g 65532 bridge && \
    adduser -S -D -u 65532 -G bridge bridge && \
    mkdir -p /srv/files && \
    chown 65532:65532 /srv/files
COPY server.ts /app/server.ts
COPY ui/ /app/ui/
USER 65532:65532
ENV BRIDGE_ROOT=/srv/files \
    PORT=8080
EXPOSE 8080
ENTRYPOINT ["node", "/app/server.ts"]
