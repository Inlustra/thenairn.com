FROM linuxserver/code-server:v3.12.0-ls103

# Install Expo Globally
RUN npm i -g expo-cli

# Install ZSH
RUN apt-get update && \
    apt-get install -y software-properties-common build-essential zsh gettext-base gnupg2 rsync lsof \ 
    # 3D Printing stuff
    stm32flash libnewlib-arm-none-eabi virtualenv python-dev libffi-dev libusb-dev gcc-arm-none-eabi binutils-arm-none-eabi libusb-1.0 && \
    
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

