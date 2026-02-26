#!/bin/bash
# setup-vps.sh — Phase 1 foundation setup for Isidore Cloud on VPS
# Run as openclaw user (who has sudo) AFTER isidore_cloud user exists
# Usage: ssh vps 'bash -s' < scripts/setup-vps.sh

set -euo pipefail

echo "=== Phase 1: Isidore Cloud VPS Setup ==="

# 1. Verify isidore_cloud user exists
if ! id isidore_cloud &>/dev/null; then
    echo "Creating isidore_cloud user..."
    sudo useradd -m -s /bin/bash isidore_cloud
    sudo usermod -aG sudo isidore_cloud
    echo "isidore_cloud ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/isidore_cloud
    sudo chmod 440 /etc/sudoers.d/isidore_cloud
    echo "User created."
else
    echo "User isidore_cloud already exists."
fi

# 2. Update AllowUsers in sshd_config to include isidore_cloud
if grep -q "^AllowUsers" /etc/ssh/sshd_config; then
    if ! grep -q "isidore_cloud" /etc/ssh/sshd_config; then
        echo "Adding isidore_cloud to AllowUsers..."
        sudo sed -i 's/^AllowUsers.*/& isidore_cloud/' /etc/ssh/sshd_config
        sudo systemctl restart ssh
        echo "ssh restarted with isidore_cloud in AllowUsers."
    else
        echo "isidore_cloud already in AllowUsers."
    fi
else
    echo "No AllowUsers directive found — skipping."
fi

# 3. Set up SSH authorized_keys for isidore_cloud (key must be passed separately)
sudo mkdir -p /home/isidore_cloud/.ssh
sudo chown isidore_cloud:isidore_cloud /home/isidore_cloud/.ssh
sudo chmod 700 /home/isidore_cloud/.ssh

# 4. Install Bun if not present for isidore_cloud
if ! sudo -u isidore_cloud bash -c 'command -v bun' &>/dev/null; then
    echo "Installing Bun for isidore_cloud..."
    sudo -u isidore_cloud bash -c 'curl -fsSL https://bun.sh/install | bash'
    echo "Bun installed."
else
    echo "Bun already installed for isidore_cloud."
fi

# 5. Install Node.js if not present (Claude Code needs it)
if ! command -v node &>/dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
    sudo apt-get install -y nodejs
    echo "Node.js installed."
else
    echo "Node.js already installed: $(node --version)"
fi

# 6. Install Claude Code CLI for isidore_cloud
if ! sudo -u isidore_cloud bash -c 'command -v claude' &>/dev/null; then
    echo "Installing Claude Code CLI..."
    sudo -u isidore_cloud bash -c 'npm install -g @anthropic-ai/claude-code'
    echo "Claude Code installed."
else
    echo "Claude Code already installed."
fi

# 7. Install tmux if not present
if ! command -v tmux &>/dev/null; then
    echo "Installing tmux..."
    sudo apt-get install -y tmux
    echo "tmux installed."
else
    echo "tmux already installed."
fi

# 8. Verify Gregor is still running
echo ""
echo "=== Coexistence Check ==="
if systemctl is-active --quiet openclaw; then
    echo "Gregor (openclaw): RUNNING"
else
    echo "WARNING: Gregor (openclaw) is NOT running!"
fi

echo ""
echo "=== Resource Usage ==="
free -h | head -2
echo ""
df -h / | tail -1
echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Copy isidore_cloud SSH public key to /home/isidore_cloud/.ssh/authorized_keys"
echo "  2. Test: ssh isidore_cloud 'whoami && sudo whoami'"
echo "  3. Authenticate Claude: ssh -L 7160:localhost:7160 isidore_cloud && claude /login"
echo "  4. Deploy PAI: rsync ~/.claude/ isidore_cloud:~/.claude/"
