FROM node:22-slim

WORKDIR /app

# Install deps in a separate layer for better caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy all source files
COPY . .

# DATA_DIR default — Railway should mount a volume here
ENV DATA_DIR=/data \
    NODE_ENV=production

CMD ["node", "scripts/server.js"]
