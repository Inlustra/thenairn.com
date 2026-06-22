# Orca: steer package-manager installs into the persisted HOME so they survive
# container recreates, and put their bin dirs on PATH.
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-$HOME/.npm-global}"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PIPX_HOME="${PIPX_HOME:-$HOME/.local/pipx}"
export PIPX_BIN_DIR="${PIPX_BIN_DIR:-$HOME/.local/bin}"
export MISE_DATA_DIR="${MISE_DATA_DIR:-$HOME/.local/share/mise}"
export PATH="$HOME/.local/bin:$NPM_CONFIG_PREFIX/bin:$BUN_INSTALL/bin:$PATH"
