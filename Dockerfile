FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN corepack enable
RUN corepack prepare pnpm@12.4.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma

RUN pnpm --version
RUN cat pnpm-workspace.yaml
RUN pnpm install --frozen-lockfile

RUN pnpm exec prisma generate

COPY tsconfig.json ./
COPY src ./src

RUN pnpm run build

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

CMD ["node", "dist/server.js"]