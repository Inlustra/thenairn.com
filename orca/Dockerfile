# Orca headless runtime server (orca serve) for Tower/Unraid.
# Electron app run headless under Xvfb; see entrypoint.sh.
FROM node:22

ENV DEBIAN_FRONTEND=noninteractive
ENV ELECTRON_DISABLE_SANDBOX=1

ARG ORCA_VERSION=1.4.60
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xauth ca-certificates curl gnupg zsh \
      libnss3 libnspr4 libgtk-3-0 libgbm1 libasound2 libdrm2 \
      libxshmfence1 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 \
      libxkbcommon0 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libpango-1.0-0 libcairo2 \
 && curl -fsSL -o /tmp/orca.deb \
      "https://github.com/stablyai/orca/releases/download/v${ORCA_VERSION}/orca-ide_${ORCA_VERSION}_amd64.deb" \
 && apt-get install -y --no-install-recommends /tmp/orca.deb \
 && rm -rf /var/lib/apt/lists/* /tmp/orca.deb

# GitHub CLI — Orca shells out to `gh` for PRs, issues, and checks.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI + compose plugin — so agents can manage the host's Docker stack
# (the daemon is reached via the mounted /var/run/docker.sock).
RUN install -m0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# Modern interactive CLI tooling for the terminals Orca exposes (prompt, fuzzy
# finder, smart cd, better grep/cat/ls/find). Installed in the image for
# reproducibility; per-user zsh config lives in the persisted HOME (/home/orca).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ripgrep bat fd-find \
 && rm -rf /var/lib/apt/lists/* \
 && ln -sf /usr/bin/batcat /usr/local/bin/bat \
 && ln -sf /usr/bin/fdfind /usr/local/bin/fd
# starship — cross-shell prompt
RUN curl -fsSL https://starship.rs/install.sh | sh -s -- -y -b /usr/local/bin
# zoxide — smarter cd (frecency)
RUN curl -fsSL https://raw.githubusercontent.com/ajeetdsouza/zoxide/main/install.sh \
      | sh -s -- --bin-dir /usr/local/bin
# fzf — fuzzy finder (release binary; shell integration via `fzf --zsh`)
RUN FZF_VERSION=0.73.1 \
 && curl -fsSL "https://github.com/junegunn/fzf/releases/download/v${FZF_VERSION}/fzf-${FZF_VERSION}-linux_amd64.tar.gz" -o /tmp/fzf.tgz \
 && tar -xzf /tmp/fzf.tgz -C /usr/local/bin \
 && rm /tmp/fzf.tgz
# eza — modern ls (official gierens apt repo)
RUN install -d /etc/apt/keyrings \
 && curl -fsSL https://raw.githubusercontent.com/eza-community/eza/main/deb.asc \
      | gpg --dearmor -o /etc/apt/keyrings/gierens.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/gierens.gpg] http://deb.gierens.de stable main" \
      > /etc/apt/sources.list.d/gierens.list \
 && apt-get update && apt-get install -y --no-install-recommends eza \
 && rm -rf /var/lib/apt/lists/*

# Persisted-tool PATH for login-shell terminals Orca spawns (the entrypoint sets
# the same for the runtime + inherited agent processes).
COPY orca-tools.sh /etc/profile.d/orca-tools.sh

COPY entrypoint.sh /usr/local/bin/orca-entrypoint
RUN chmod +x /usr/local/bin/orca-entrypoint /etc/profile.d/orca-tools.sh

ENTRYPOINT ["/usr/local/bin/orca-entrypoint"]
