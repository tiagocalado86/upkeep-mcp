# Two stages: the toolchain that compiles TypeScript never reaches the image
# that runs in public.
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# `--omit=dev` leaves the compiler, the linter and the test runner behind.
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# node:22-alpine ships an unprivileged `node` user. Nothing here writes to disk,
# so the process has no reason to own anything it runs on.
USER node

# Cloud Run's default container port. Passed as an argument rather than read
# from the environment: nothing under src/ reads process.env, and a test says so.
EXPOSE 8080
CMD ["node", "dist/http.js", "--port", "8080"]
