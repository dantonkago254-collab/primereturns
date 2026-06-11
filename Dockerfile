# Dockerfile
# PrimeReturns — Node + Vite single-service deploy for Railway
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
# Install all dependencies because Vite and TypeScript live in devDependencies
# and are required during the build step.
RUN npm ci --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Fail fast if the frontend cannot build; Railway should not deploy a broken app.
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package*.json ./
COPY server.cjs ./
EXPOSE 3000
CMD ["node", "server.cjs"]
