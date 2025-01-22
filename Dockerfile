# Use a Node.js image to build and run the server
FROM node:22.12-alpine AS builder

# Set the working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package.json package-lock.json ./

# Install the dependencies
RUN npm install

# Copy the rest of the application source code
COPY . .

# Build the application
RUN npm run build

# Use a lighter Node.js image to run the application
FROM node:22.12-alpine AS release

# Set the working directory
WORKDIR /app

# Copy built application and package files
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package-lock.json /app/

# Install only production dependencies
RUN npm ci --production

# Expose the port the app runs on
EXPOSE 3333

# Set environment variable for production
ENV NODE_ENV=production

# Command to run the application
ENTRYPOINT ["node", "dist/server.js"]