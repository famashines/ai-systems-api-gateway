FROM node:26.13.0@sha256:6d2c7d5d074bf72f81ddc252b4fbb5d625bc028eeda49cb4b8c2ff8eda1ee617 AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

FROM node:26.13.0-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
ARG RELEASE=local
ENV RELEASE=$RELEASE
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "src/main.ts"]
