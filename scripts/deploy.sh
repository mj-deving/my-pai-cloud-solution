#!/bin/bash
# deploy.sh — Full deployment of Isidore Cloud to VPS
# Run from local machine after setup-vps.sh and deploy-key.sh
# Usage: bash scripts/deploy.sh

set -euo pipefail

VPS_HOST="isidore_cloud"  # Uses isidore_cloud SSH alias
PROJECT_DIR="/home/isidore_cloud/projects/my-pai-cloud-solution"

echo "=== Deploying Isidore Cloud to VPS ==="

# 1. Sync project code
echo "Syncing project code..."
rsync -avz --exclude='node_modules/' --exclude='.git/' --exclude='*.env' --exclude='CLAUDE.local.md' \
    /home/mj/projects/my-pai-cloud-solution/ \
    "$VPS_HOST:$PROJECT_DIR/"

# 2. Ensure VPS project has a git repo (rsync excludes .git/)
echo "Ensuring git repo on VPS..."
ssh "$VPS_HOST" "cd $PROJECT_DIR && \
    if [ ! -d .git ]; then \
        git init -b main && \
        git remote add origin https://github.com/mj-deving/my-pai-cloud-solution.git && \
        git fetch origin && \
        git reset origin/main && \
        git branch --set-upstream-to=origin/main main && \
        echo 'Git repo initialized with tracking'; \
    elif ! git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then \
        git branch --set-upstream-to=origin/main main 2>/dev/null && \
        echo 'Upstream tracking set'; \
    else \
        echo 'Git repo OK'; \
    fi"

# 3. Sync VPS git history to match remote (rsync copies files but not .git)
echo "Syncing VPS git history..."
ssh "$VPS_HOST" "cd $PROJECT_DIR && git fetch origin && git reset --hard origin/main"

# 4. Install dependencies on VPS
echo "Installing dependencies on VPS..."
ssh "$VPS_HOST" "cd $PROJECT_DIR && ~/.bun/bin/bun install"

# 5. Deploy PAI installation (skills, config, memory structure)
# Exit 23 = partial transfer (some files vanish or have permission issues) — tolerable
echo "Deploying PAI installation..."
rsync -avz \
    --exclude='debug/' \
    --exclude='cache/' \
    --exclude='projects/' \
    --exclude='PAI-Install/' \
    --exclude='MEMORY/WORK/' \
    --exclude='MEMORY/VOICE/' \
    --exclude='MEMORY/STATE/' \
    --exclude='settings.json' \
    --exclude='history.jsonl' \
    --exclude='.credentials.json' \
    --exclude='*.jsonl' \
    ~/.claude/ "$VPS_HOST:~/.claude/" || {
    rc=$?
    if [ "$rc" -eq 23 ]; then
        echo "PAI rsync: partial transfer (exit 23) — non-critical, continuing"
    else
        echo "PAI rsync failed with exit $rc"
        exit "$rc"
    fi
}

# 6. Create config directory and copy env template
echo "Setting up config..."
ssh "$VPS_HOST" "mkdir -p ~/.config/isidore_cloud"

# Check if bridge.env exists, if not copy template
ssh "$VPS_HOST" "test -f ~/.config/isidore_cloud/bridge.env || \
    cp $PROJECT_DIR/bridge.env.example ~/.config/isidore_cloud/bridge.env"

# 7. Install systemd services
echo "Installing systemd services..."
ssh "$VPS_HOST" "sudo cp $PROJECT_DIR/systemd/isidore-cloud-bridge.service /etc/systemd/system/ && \
    sudo cp $PROJECT_DIR/systemd/isidore-cloud-tmux.service /etc/systemd/system/ && \
    sudo systemctl daemon-reload"

# 8. Make scripts executable
ssh "$VPS_HOST" "chmod +x $PROJECT_DIR/scripts/*.sh"

# 9. Set up cron for auth health check
echo "Setting up auth health check cron..."
ssh "$VPS_HOST" '(crontab -l 2>/dev/null | grep -v auth-health-check; echo "0 */4 * * * /home/isidore_cloud/projects/my-pai-cloud-solution/scripts/auth-health-check.sh") | crontab -'

# 10. Install isidore-cloud-session as a global command
echo "Installing isidore-cloud-session CLI..."
ssh "$VPS_HOST" "mkdir -p ~/bin && \
    cat > ~/bin/isidore-cloud-session << 'SCRIPT'
#!/bin/bash
exec ~/.bun/bin/bun run /home/isidore_cloud/projects/my-pai-cloud-solution/src/isidore-cloud-session.ts \"\$@\"
SCRIPT
chmod +x ~/bin/isidore-cloud-session && \
    grep -q 'PATH.*\$HOME/bin' ~/.bashrc || echo 'export PATH=\"\$HOME/bin:\$PATH\"' >> ~/.bashrc"

echo ""
echo "=== Deployment complete ==="
echo ""
echo "Next steps:"
echo "  1. Edit bridge.env: ssh isidore_cloud 'nano ~/.config/isidore_cloud/bridge.env'"
echo "     - Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID"
echo "  2. Enable and start services:"
echo "     ssh isidore_cloud 'sudo systemctl enable --now isidore-cloud-tmux isidore-cloud-bridge'"
echo "  3. Verify: ssh isidore_cloud 'sudo systemctl status isidore-cloud-bridge'"
echo "  4. Test Telegram: send a message to your bot"
