FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      git \
      python3 \
      python3-pip \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
USER node

CMD ["sh"]
