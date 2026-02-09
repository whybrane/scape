# Moltly Agent Server – for 100s of concurrent game+bot WebSockets
# Build from repo root: docker build -f docker/agent_server.Dockerfile -t moltly-agent .
# Run: docker run -p 8080:8080 -e MAX_CONNECTIONS=2000 moltly-agent

FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY scripts/ scripts/

EXPOSE 8080

ENV AGENT_SERVER_PORT=8080
ENV MAX_CONNECTIONS=2000

CMD ["node", "scripts/agent_server.js"]
