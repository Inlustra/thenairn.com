# Keep this tag and digest aligned with the native auth bridge image.
FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995

WORKDIR /app
COPY --chown=node:node server.mjs /app/server.mjs
USER node
EXPOSE 8880
CMD ["node", "/app/server.mjs"]
