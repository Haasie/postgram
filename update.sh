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
if git remote | grep -qx upstream; then
    git fetch upstream main --quiet 2>/dev/null || true
    UPSTREAM_BEHIND=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo 0)
    if [ "$UPSTREAM_BEHIND" -gt 0 ]; then
        echo "Let op: upstream (ivo-toby) heeft $UPSTREAM_BEHIND nieuwe commit(s). Mergen doe je handmatig:"
        echo "  cd /home/haasie/postgram && git merge upstream/main"
    fi
fi

if [ "$BEHIND" -gt 0 ] || [ "${1:-}" = "--force" ]; then
    echo "$BEHIND nieuwe commit(s) op origin. Binnenhalen..."
    # Save our local modifications (like the bugfix and docker-compose.yml configuration)
    git stash
    
    # Pull latest official code
    git pull origin main
    
    # Restore our modifications
    if git stash pop; then
        echo "Successfully reapplied local modifications."
    else
        echo "Warning: Stash pop had conflicts. You may need to resolve them manually in the editor."
    fi
    
    echo "Rebuilding UI image..."
    bash build-ui.sh
    
    echo "Rebuilding MCP Server image..."
    docker build -t postgram-mcp-server:latest .
    
    echo "Restarting containers..."
    docker compose up -d
    
    echo "=== Update complete ==="
else
    echo "Niets te doen: geen nieuwe commits op origin."
fi
