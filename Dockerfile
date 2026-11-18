FROM node:22-alpine AS frontend-dependencies
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --ignore-scripts --registry=https://registry.npmjs.org
COPY scripts/vendor.mjs scripts/vendor.mjs
RUN node scripts/vendor.mjs

FROM nginx:stable-alpine

ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
# Master-process startup messages use the main context, not the server block.
RUN sed -i '/^[[:space:]]*error_log[[:space:]]/c\error_log /dev/stderr error;' /etc/nginx/nginx.conf

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html login.html workflow.html styles.css /usr/share/nginx/html/
COPY src/ /usr/share/nginx/html/src/
COPY assets/ /usr/share/nginx/html/assets/
COPY --from=frontend-dependencies /app/vendor/ /usr/share/nginx/html/vendor/
COPY output/evaluation/membership-background-v1.png output/evaluation/promotion-background-v1.png /usr/share/nginx/html/output/evaluation/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
