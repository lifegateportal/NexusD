FROM docker:27-cli

RUN apk add --no-cache nodejs

WORKDIR /app
COPY package.json server.mjs ./

ENV NODE_ENV=production
ENV PORT=8090
ENV CODING_RUNNER_WORK_ROOT=/var/lib/nexus-runner

RUN mkdir -p /var/lib/nexus-runner

ENTRYPOINT []
CMD ["node", "server.mjs"]
