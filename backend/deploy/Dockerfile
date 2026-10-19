ARG RUNTIME_BASE=debian:bookworm-slim
ARG PROBE_BASE=nginx:stable-alpine
FROM ${PROBE_BASE} AS probe
FROM ${RUNTIME_BASE}
# This release targets Linux amd64. Reuse the official gateway image's HTTP probe
# and its musl loader; the Rust executable continues to use Debian's glibc.
COPY --from=probe /bin/busybox /usr/local/bin/busybox
COPY --from=probe /lib/ld-musl-x86_64.so.1 /lib/ld-musl-x86_64.so.1
COPY --from=probe /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=0555 artifact/xiaoq-backend /usr/local/bin/xiaoq-backend
USER 10001:10001
WORKDIR /tmp
EXPOSE 8787
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/xiaoq-backend"]
