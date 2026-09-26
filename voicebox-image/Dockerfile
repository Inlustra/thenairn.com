# Voicebox pinned to reviewed implementation commit a2800e4.
# pedalboard 0.9.25 crashes with SIGILL on Tower's Ryzen 5 3600;
# 0.9.17 is verified to import successfully on this host.
FROM thenairncom-voicebox:a2800e4-base
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --force-reinstall --no-deps pedalboard==0.9.17
