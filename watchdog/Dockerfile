# slim (glibc), not alpine: the shared `op` binary at HQ/tools/op is a
# glibc-linked binary (same one the paperclip container uses via PATH) and
# will not run under musl.
FROM python:3.12-slim

# Stdlib only in breaker.py itself (urllib, json) - no requirements.txt,
# nothing to go stale. `op` comes from the HQ/tools bind mount, not this image.
COPY breaker.py /app/breaker.py
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
