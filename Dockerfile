# Two stages: the toolchain that compiles TypeScript never reaches the image
# that runs in public.
#
# Debian rather than Alpine, and this is not a preference. `playwright-core`
# publishes no musl build: its platform table has no musl entry and falls back
# to `ubuntu24.04`, so installing a browser on Alpine *succeeds*, downloads a
# glibc build, and dies at launch with a loader error. See
# `docs/adr/0013-playwright-core-and-an-optional-browser.md`.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production

# Outside root's home, so the unprivileged user below can read it. Playwright
# defaults to `~/.cache/ms-playwright`, which the install (as root) would put
# somewhere `node` cannot reach.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json ./
# `--omit=dev` leaves the compiler, the linter and the test runner behind.
RUN npm ci --omit=dev && npm cache clean --force

# `--only-shell` installs the headless shell and not the full browser: 196 MB
# against several hundred more, and `chromium.launch({ headless: true })` uses
# it — verified on a browser directory containing nothing else, not assumed from
# the release notes. `--with-deps` is what pulls the shared libraries Chromium
# links against; without it the binary is present and will not start.
RUN npx playwright-core install --with-deps --only-shell chromium \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

# node:22-slim ships an unprivileged `node` user. Nothing here writes to disk,
# so the process has no reason to own anything it runs on.
USER node

# Cloud Run's default container port. Passed as an argument rather than read
# from the environment: nothing under src/ reads process.env, and a test says so.
EXPOSE 8080
CMD ["node", "dist/http.js", "--port", "8080"]
