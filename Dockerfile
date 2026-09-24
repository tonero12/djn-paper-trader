# Multi-stage Dockerfile for DJN Paper Trader
# Production-grade 24/7 container deployment

FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy compiled assets and data folder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/data ./data

# Expose standard web & webhook port
EXPOSE 3000

# Start server
CMD ["node", "dist/server.js"]
