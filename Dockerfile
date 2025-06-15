FROM node:22-alpine

# Enable pnpm
RUN corepack enable pnpm

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* pnpm-lock.yaml* ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Clean any existing build artifacts
RUN rm -rf ./dist && \
    echo "=== Cleaned build artifacts ==="

# Build the application
RUN echo "=== Starting build process ===" && \
    npm run build && \
    echo "=== Build completed ==="

# Debug: Verify build output
RUN echo "=== Verifying build output ===" && \
    ls -la dist/ && \
    echo "=== server.js permissions ===" && \
    ls -la dist/server.js && \
    echo "=== Testing executable ===" && \
    node dist/server.js --help

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3333
ENV MCP_TRANSPORT_MODE=streaming
ENV HOSTNAME=localhost

# Expose port
EXPOSE 3333

# Use a shell script to handle conditional startup
RUN echo '#!/bin/sh' > /app/start.sh && \
    echo 'if [ "$MCP_TRANSPORT_MODE" = "stdio" ]; then' >> /app/start.sh && \
    echo '  exec node dist/server.js --port $PORT' >> /app/start.sh && \
    echo 'else' >> /app/start.sh && \
    echo '  exec node dist/server.js --streaming --port $PORT' >> /app/start.sh && \
    echo 'fi' >> /app/start.sh && \
    chmod +x /app/start.sh

# Use the start script
CMD ["/app/start.sh"]