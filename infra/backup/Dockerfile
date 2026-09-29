# Same pinned PostgreSQL 17 image as the database, so pg_dump matches the server.
FROM pgvector/pgvector:0.8.6-pg17@sha256:cf134a767f474095eeba57e0117be8e568e011a63f33fbf252f14c9b760f8e6f
RUN apt-get update \
  && apt-get install -y --no-install-recommends age rclone ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
COPY infra/backup/orbit-archive.sh /usr/local/bin/orbit-backup
USER postgres
ENTRYPOINT ["/usr/local/bin/orbit-backup"]
CMD ["loop"]
