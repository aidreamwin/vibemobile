#!/bin/sh
# Substituted by scripts/release.mjs when publishing a release.
role=@ROLE@
archive_url=@ARCHIVE_URL@
archive_sha256=@ARCHIVE_SHA256@
node_version=@NODE_VERSION@

die() {
    printf 'VibeMobile: %s\n' "$*" >&2
    exit 1
}

download() {
    curl -fLsS --retry 3 --connect-timeout 15 -o "$2" "$1"
}

checksum() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        die 'sha256sum or shasum is required'
    fi
}

verify() {
    [ "$(checksum "$1")" = "$2" ] || die "SHA-256 verification failed: $1"
}

node_ready() {
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
        node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' >/dev/null 2>&1
}

ensure_node() {
    if node_ready; then
        return
    fi
    case "$(uname -s)" in
        Linux) platform=linux ;;
        Darwin) platform=darwin ;;
        *) die 'Install Node.js 22 or newer with npm first on this platform.' ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *) die 'Install Node.js 22 or newer with npm first on this architecture.' ;;
    esac

    dist="node-$node_version-$platform-$arch"
    runtime="${XDG_DATA_HOME:-$HOME/.local/share}/vibemobile/runtime"
    if [ ! -x "$runtime/$dist/bin/node" ]; then
        printf 'Installing Node.js %s for the current user...\n' "$node_version"
        node_url="https://nodejs.org/dist/$node_version"
        download "$node_url/SHASUMS256.txt" "$tmp/node-checksums"
        hash=$(awk -v file="$dist.tar.gz" '$2 == file {print $1}' "$tmp/node-checksums")
        [ -n "$hash" ] || die "Node.js distribution is unavailable: $dist"
        download "$node_url/$dist.tar.gz" "$tmp/node.tar.gz"
        verify "$tmp/node.tar.gz" "$hash"
        tar -xzf "$tmp/node.tar.gz" -C "$tmp"
        mkdir -p "$runtime"
        # The versioned runtime is shared by both roles. A concurrent installer
        # may have finished the same download while this one was extracting.
        if [ ! -d "$runtime/$dist" ]; then
            mv "$tmp/$dist" "$runtime/" || [ -x "$runtime/$dist/bin/node" ]
        fi
    fi
    PATH="$runtime/$dist/bin:$PATH"
    export PATH
    node_ready || die 'The downloaded Node.js runtime could not start. Install a compatible Node.js 22+ and npm.'

    mkdir -p "$HOME/.local/bin"
    for command in node npm npx; do
        if [ ! -e "$HOME/.local/bin/$command" ] && [ ! -L "$HOME/.local/bin/$command" ]; then
            ln -s "$runtime/$dist/bin/$command" "$HOME/.local/bin/$command"
        fi
    done
    printf 'For management commands in new terminals, add %s to PATH.\n' "$HOME/.local/bin"
}

main() {
    set -eu
    umask 077
    PATH="$HOME/.local/bin:$PATH"
    export PATH
    if [ "${1:-}" = --help ]; then
        cat <<EOF
VibeMobile $role installer
  --target=<directory>       Installation directory
  --workspace=<directory>    Workspace (default: current directory)
  --yes                      Approve upgrades without prompting
  --pm2-name=<name>          PM2 application name
  --port=<port>              Hub HTTP port (default: 3000)
  --runner-port=<port>       Private runner service port
  --codex-port=<port>        Codex sidecar port
  --opencode-port=<port>     OpenCode sidecar port
  --tls                      Enable native Hub HTTPS
  --no-start                 Prepare the deployment without starting PM2
  --hub-url=<url>             Hub address for a runner
  --runner-id=<id>            Runner ID
  --runner-token-file=<file>  Read runner credentials from a private file
  --hub-ca=<file>             CA certificate for a private Hub CA
  --allow-root               Allow Hub installation as root
EOF
        return
    fi

    tmp=$(mktemp -d "${TMPDIR:-/tmp}/vibemobile-install.XXXXXX")
    trap 'rm -rf -- "$tmp"' 0
    trap 'exit 130' INT
    trap 'exit 143' TERM

    printf 'Downloading VibeMobile %s...\n' "$role"
    download "$archive_url" "$tmp/release.tar.gz"
    verify "$tmp/release.tar.gz" "$archive_sha256"
    mkdir "$tmp/package"
    tar -xzf "$tmp/release.tar.gz" -C "$tmp/package"

    ensure_node
    # In a curl | sh pipeline stdin carries the installer itself. Interactive
    # questions must read the controlling terminal, never the script stream.
    if ( : </dev/tty ) 2>/dev/null; then
        node "$tmp/package/deploy/quick-install.mjs" "$@" </dev/tty
    else
        node "$tmp/package/deploy/quick-install.mjs" "$@" </dev/null
    fi
}

# Execute only after the complete script has arrived.
main "$@"
