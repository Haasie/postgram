#!/bin/bash
set -euo pipefail

# Navigate to the postgram directory
cd /home/haasie/postgram

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "=== Checking for updates (current branch: $CURRENT_BRANCH) ==="

send_telegram() {
    local msg="$1"
    local env_file="${POSTGRAM_GROOM_ENV:-$HOME/.postgram-groom.env}"
    if [ -f "$env_file" ]; then
        local token chat_id
        token=$(grep -E "^TELEGRAM_TOKEN=" "$env_file" | cut -d= -f2- | tr -d '"'\''')
        chat_id=$(grep -E "^TELEGRAM_CHAT_ID=" "$env_file" | cut -d= -f2- | tr -d '"'\''')
        if [ -n "$token" ] && [ -n "$chat_id" ]; then
            curl -s -X POST "https://api.telegram.org/bot${token}/sendMessage" \
                -d chat_id="${chat_id}" \
                -d text="$msg" \
                -d parse_mode="HTML" > /dev/null 2>&1 || true
        fi
    fi
}

# Always fetch upstream if configured
if git remote | grep -qx upstream; then
    git fetch upstream --quiet 2>/dev/null || true

    # Specifieke check voor workspace-session-tracking branch
    if [ "$CURRENT_BRANCH" = "feat/004-workspace-session-tracking" ]; then
        # Check of branch 004 al gemerged is in upstream/main
        if git merge-base --is-ancestor upstream/004-workspace-session-tracking upstream/main 2>/dev/null; then
            echo "🎉 LET OP: Branch 004-workspace-session-tracking is gemerged naar upstream/main!"
            echo "   Je kunt nu veilig terugkeren naar main via:"
            echo "   cd /home/haasie/postgram && git checkout main && git merge upstream/main"
            send_telegram "🚀 <b>Postgram Update</b>: Branch <code>004-workspace-session-tracking</code> is gemerged naar <code>upstream/main</code>! We kunnen nu terug overstappen op main."
        else
            UPSTREAM_004_BEHIND=$(git rev-list --count HEAD..upstream/004-workspace-session-tracking 2>/dev/null || echo 0)
            if [ "$UPSTREAM_004_BEHIND" -gt 0 ]; then
                echo "Let op: upstream/004-workspace-session-tracking heeft $UPSTREAM_004_BEHIND nieuwe commit(s)."
                echo "Binnenhalen kan met:"
                echo "  cd /home/haasie/postgram && git merge upstream/004-workspace-session-tracking"
            else
                echo "Branch 004-workspace-session-tracking is up-to-date met upstream (nog niet gemerged naar upstream/main)."
            fi
        fi
    fi

    UPSTREAM_MAIN_BEHIND=$(git rev-list --count HEAD..upstream/main 2>/dev/null || echo 0)
    if [ "$CURRENT_BRANCH" = "main" ] && [ "$UPSTREAM_MAIN_BEHIND" -gt 0 ]; then
        echo "Let op: upstream (ivo-toby) heeft $UPSTREAM_MAIN_BEHIND nieuwe commit(s) op main. Mergen doe je handmatig:"
        echo "  cd /home/haasie/postgram && git merge upstream/main"
    fi
fi

if [ "$CURRENT_BRANCH" = "main" ]; then
    git fetch origin main --quiet 2>/dev/null || true
    BEHIND=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo 0)

    if [ "$BEHIND" -gt 0 ] || [ "${1:-}" = "--force" ]; then
        echo "$BEHIND nieuwe commit(s) op origin. Binnenhalen..."
        STASH_OUTPUT=$(git stash 2>&1)
        echo "$STASH_OUTPUT"
        
        git pull origin main
        
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
elif [ "${1:-}" = "--force" ]; then
    echo "Force rebuild and restart op branch $CURRENT_BRANCH..."
    echo "Rebuilding UI image..."
    bash build-ui.sh
    echo "Rebuilding MCP Server image..."
    docker build -t postgram-mcp-server:latest .
    echo "Restarting containers..."
    docker compose up -d --force-recreate
    echo "=== Rebuild complete ==="
else
    echo "Actieve branch is $CURRENT_BRANCH (niet main). Automatische pull overgeslagen om lokale tests niet te verstoren."
fi
