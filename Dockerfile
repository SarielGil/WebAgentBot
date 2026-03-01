# WebAgentBot Orchestrator Dockerfile
FROM node:22-slim

# Install system dependencies
# - curl: To download the Docker CLI
# - sqlite3: For manual DB inspection if needed
# - git: Required for skills-engine operations and tests
RUN apt-get update && apt-get install -y \
    curl \
    sqlite3 \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install modern Docker CLI
RUN curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz | tar -xzC /usr/local/bin --strip-components=1 docker/docker

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
