# Bouwen vanuit de hoofdmap van de repository:  docker build -f server/Dockerfile .
FROM node:22-alpine
WORKDIR /srv
COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server/app.js server/build.js ./
COPY server/public ./public
COPY index.html uitrol-template.html /tmp/repo/
RUN node build.js /tmp/repo /srv/site && rm -rf /tmp/repo
ENV PUBLIC_DIR=/srv/site PORT=3000
USER node
EXPOSE 3000
CMD ["node", "app.js"]
