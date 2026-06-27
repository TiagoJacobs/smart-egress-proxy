# syntax=docker/dockerfile:1

###############################################################################
# Stage 1: build the React/Vite dashboard SPA.
#
# The Node server itself is NOT compiled, it runs straight from TypeScript via
# tsx at runtime, so this stage exists only to produce dashboard/dist and to
# resolve the production node_modules that the runtime stage copies.
###############################################################################
FROM node:22-slim AS build
WORKDIR /app

# --- Root production dependencies (express, tsx, undici, zod) ---------------
# Copied first so this layer is cached unless the manifests change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Dashboard dependencies (vite, react, ... incl. dev tooling) -----------
COPY dashboard/package.json ./dashboard/
RUN npm --prefix dashboard install --include=dev

# --- Application + dashboard source ----------------------------------------
# node_modules / dist are excluded via .dockerignore, so this does not clobber
# the dependencies installed above.
COPY . .

# --- Build the SPA -> /app/dashboard/dist ----------------------------------
RUN npm --prefix dashboard run build

###############################################################################
# Stage 2: lean runtime image.
###############################################################################
FROM node:22-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    STATE_DIR=/data

# Production node_modules (includes tsx, which runs the TypeScript directly).
COPY --from=build /app/node_modules ./node_modules

# Server source, executed as-is by tsx (no emit step).
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/config.json.example ./config.json.example

# Built dashboard SPA served by the Express app (STATIC_DIR=./dashboard/dist).
COPY --from=build /app/dashboard/dist ./dashboard/dist

# Persisted runtime state (the selected mode lives in $STATE_DIR/state.json).
VOLUME ["/data"]

# 3128 = forward proxy, 443 = dashboard + JSON API.
EXPOSE 3128 443

CMD ["npx", "tsx", "src/index.ts"]
