FROM node:22-alpine
ENV NODE_ENV=production TZ=Africa/Cairo DATA_DIR=/app/data
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY assets ./assets
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--no-warnings", "src/server.js"]
