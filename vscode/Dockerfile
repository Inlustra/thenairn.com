FROM linuxserver/code-server:v3.6.2-ls56

# Install Expo Globally
RUN npm i -g expo-cli

# Install ZSH
RUN apt-get update && \
    apt-get install -y software-properties-common zsh gettext-base gnupg2 && \
    rm -rf /var/lib/apt/lists/*

ENV SHELL /bin/zsh

# add local files
COPY /root /
