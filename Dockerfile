FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app

RUN npm install -g supergateway

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./

EXPOSE 8000

CMD ["supergateway", \
     "--stdio", "node dist/index.js", \
     "--port", "8000", \
     "--healthEndpoint", "/healthz", \
     "--cors"]
