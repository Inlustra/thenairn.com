FROM linuxserver/code-server:4.109.2

# Install ZSH
RUN apt-get update && \
    apt-get install -y software-properties-common build-essential zsh gettext-base gnupg2 rsync lsof \ 
    # 3D Printing stuff
    stm32flash libnewlib-arm-none-eabi virtualenv python-dev libffi-dev libusb-dev gcc-arm-none-eabi binutils-arm-none-eabi libusb-1.0 && \
    rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

ENV SHELL /bin/zsh

