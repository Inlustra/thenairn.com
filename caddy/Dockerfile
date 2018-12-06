FROM https://github.com/abiosoft/caddy-docker.git

COPY Caddyfile /etc/Caddyfile

ENTRYPOINT ["/bin/parent", "caddy"]
CMD ["--conf", "/etc/Caddyfile", "--log", "stdout", "--agree=$ACME_AGREE"]