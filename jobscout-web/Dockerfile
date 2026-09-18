# The Next.js app, and the worker that shares its code.
#
# One image, two commands: `node server.js` serves the app, `npm run worker`
# runs the inbox loop. They are built together because the worker imports the
# app's database schema and scout client -- shipping them separately is how
# the two drift into disagreeing about the schema.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Not baked into the image: the build must not capture a real secret, and
# this one only has to be present, not correct, for the build to typecheck.
ENV ENCRYPTION_KEY=build-time-placeholder-value-32-chars
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The standalone bundle is the app; the worker needs source and tsx, so the
# full node_modules comes too. Still smaller than copying the build stage.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY --from=build /app/worker ./worker
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/package.json ./package.json

# Nothing here needs root.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
