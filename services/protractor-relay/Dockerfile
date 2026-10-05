FROM node:20.19.1-alpine3.21

ENV NODE_ENV=production
WORKDIR /app

RUN mkdir -p /var/lib/protractor-relay && chown -R node:node /var/lib/protractor-relay
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 8080
CMD ["node", "src/server.js"]