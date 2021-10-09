FROM linuxserver/code-server:version-v3.11.0

# Install Expo Globally
RUN npm i -g expo-cli

# Install ZSH
RUN apt-get update && \
    apt-get install -y software-properties-common zsh gettext-base gnupg2 rsync lsof && \
    rm -rf /var/lib/apt/lists/*

ENV SHELL /bin/zsh

# add local files
COPY /root /
ENV SERVICE_URL "https://marketplace.visualstudio.com/_apis/public/gallery"
ENV ITEM_URL "https://marketplace.visualstudio.com/items"

ENV VSCODE_GALLERY_SERVICE_URL "https://marketplace.visualstudio.com/_apis/public/gallery"
ENV VSCODE_GALLERY_CACHE_URL "https://vscode.blob.core.windows.net/gallery/index"
ENV VSCODE_GALLERY_ITEM_URL "https://marketplace.visualstudio.com/items"
ENV VSCODE_GALLERY_CONTROL_URL ""
ENV VSCODE_GALLERY_RECOMMENDATIONS_URL ""

