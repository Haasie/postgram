#!/bin/bash
set -euo pipefail

# Navigate to the postgram directory
cd /home/haasie/postgram

echo "=== Checking for updates from upstream repository ==="
git fetch origin main

# Tellen hoeveel commits origin/main heeft die wij nog niet hebben.
# NIET de hashes vergelijken op ongelijkheid: deze fork loopt structureel
# VOOR op origin (lokale deploy-aanpassingen), waardoor die test altijd waar
# was. Gevolg tot 2026-09-14: elke nacht "New updates found", een stash/pop-
# cyclus en een volledige herbouw van beide images, zonder dat er iets te
# halen viel.
BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)

# Upstream (ivo-toby) alleen SIGNALEREN, niet automatisch mergen: een
# vreemde repo 's nachts ongezien binnentrekken in een draaiende app is hoe
# je onverwachte stilstand krijgt. Mergen blijft een bewuste handeling.
#
# Het signaal stond tot 2026-11-18 alleen in update.log, dat niemand leest
# (de fork liep zo 108 commits achter). Daarom schrijft dit script bij elke
# run, ook bij een vroege exit, de stand naar DRIFT_FILE. De Homelab
# Supervisor (haasiehomeops) leest die map read-only en meldt een
# achterstand in het wekelijkse overzicht (Telegram + Taskgram Beheer).
DRIFT_DIR=/home/haasie/backups/fork-drift
DRIFT_FILE="$DRIFT_DIR/postgram.json"
UPSTREAM_FETCH_OK=false

write_drift_status() {
    local behind=null ahead=null
    if [ "$UPSTREAM_FETCH_OK" = true ]; then
        behind=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo null)
        ahead=$(git rev-list --count upstream/main..HEAD 2>/dev/null || echo null)
    fi
    mkdir -p "$DRIFT_DIR"
    # Via een tijdelijk bestand en mv: de Supervisor leest nooit een half bestand.
    printf '{"repo":"Haasie/postgram","upstream":"ivo-toby/postgram","behind":%s,"ahead":%s,"fetch_ok":%s,"head":"%s","checked_at":"%s"}\n' \
        "$behind" "$ahead" "$UPSTREAM_FETCH_OK" "$(git rev-parse --short HEAD)" \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$DRIFT_FILE.tmp"
    chmod 644 "$DRIFT_FILE.tmp"
    mv -f "$DRIFT_FILE.tmp" "$DRIFT_FILE"
}
# Bij EXIT, zodat ook de stand na een pull (of een vroege exit 1) telt.
# Een fout hier mag de update zelf niet laten mislukken.
trap 'write_drift_status || echo "WARN: fork-drift-status niet geschreven" >&2' EXIT

if git remote | grep -qx upstream; then
    if git fetch upstream main --quiet 2>/dev/null; then
        UPSTREAM_FETCH_OK=true
    fi
    UPSTREAM_BEHIND=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo 0)
    if [ "$UPSTREAM_BEHIND" -gt 0 ]; then
        echo "Let op: upstream (ivo-toby) heeft $UPSTREAM_BEHIND nieuwe commit(s). Mergen doe je handmatig:"
        echo "  cd /home/haasie/postgram && git merge upstream/main"
    fi
fi

if [ "$BEHIND" -gt 0 ] || [ "${1:-}" = "--force" ]; then
    echo "$BEHIND nieuwe commit(s) op origin. Binnenhalen..."
    # Save our local modifications (like docker-compose.yml configuration)
    STASH_OUTPUT=$(git stash 2>&1)
    echo "$STASH_OUTPUT"
    
    # Pull latest official code
    git pull origin main
    
    # Restore our modifications only if we stashed something
    if [ "$STASH_OUTPUT" != "No local changes to save" ]; then
        if git stash pop; then
            echo "Successfully reapplied local modifications."
        else
            echo "ERROR: Stash pop had conflicts! Resolve them manually before rebuilding." >&2
            exit 1
        fi
    fi
    
    echo "Rebuilding UI image..."
    bash build-ui.sh
    
    echo "Rebuilding MCP Server image..."
    docker build -t postgram-mcp-server:latest .
    
    echo "Restarting containers..."
    docker compose up -d --force-recreate
    
    echo "=== Update complete ==="
else
    echo "Niets te doen: geen nieuwe commits op origin."
fi
