ARG RUNTIME_BASE=debian:bookworm-slim
FROM ${RUNTIME_BASE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 q && useradd --uid 10001 --gid q --no-create-home --shell /usr/sbin/nologin q
COPY --chmod=0555 artifact/xiaoq-backend /usr/local/bin/xiaoq-backend
USER 10001:10001
WORKDIR /tmp
EXPOSE 8787
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/xiaoq-backend"]
