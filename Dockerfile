FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.11.2 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

ENV AGENT_HOST=0.0.0.0
ENV AGENT_PORT=8787

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["pnpm", "start"]
