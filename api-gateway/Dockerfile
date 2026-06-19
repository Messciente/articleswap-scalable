# SvelteKit dev server with Kafka consumer.
# Dev mode chosen for "1 command" simplicity (no build step).
# For production, switch to adapter-node: npm run build + node build/index.js
FROM node:20-alpine

WORKDIR /app

# Install deps separately for better layer caching
COPY package*.json ./
RUN npm install

# Copy source (will be bind-mounted in dev for HMR)
COPY . .

EXPOSE 5173

# Vite dev server bound to 0.0.0.0 so docker port mapping works
# CHOKIDAR_USEPOLLING avoids filesystem watch issues on some Docker hosts
ENV CHOKIDAR_USEPOLLING=true
ENV HOST=0.0.0.0

# Port + host passed by docker-compose command
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173", "--strictPort", "--force"]
