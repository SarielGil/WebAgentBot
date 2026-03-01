# WebAgentBot Orchestrator Dockerfile
FROM node:22-slim

# Install system dependencies
# - docker.io: To allow orchestrator to spawn sub-agent containers
# - sqlite3: For manual DB inspection if needed
RUN apt-get update && apt-get install -y \
    docker.io \
    sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all source files
COPY . .

# Build the TypeScript project
RUN npm run build

# Create necessary directories
RUN mkdir -p /app/data /app/groups /app/store

# Start the orchestrator
CMD ["npm", "start"]
