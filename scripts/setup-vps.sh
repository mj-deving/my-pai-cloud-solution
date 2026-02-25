#!/bin/bash
# setup-vps.sh — Phase 1 foundation setup for Isidore on VPS
# Run as openclaw user (who has sudo) AFTER isidore user exists
# Usage: ssh vps 'bash -s' < scripts/setup-vps.sh

set -euo pipefail

echo "=== Phase 1: Isidore VPS Setup ==="

# 1. Verify isidore user exists
if ! id isidore &>/dev/null; then
    echo "Creating isidore user..."
    sudo useradd -m -s /bin/bash isidore
    sudo usermod -aG sudo isidore
    echo "isidore ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/isidore
    sudo chmod 440 /etc/sudoers.d/isidore
    echo "User created."
else
    echo "User isidore already exists."
fi

# 2. Update AllowUsers in sshd_config to include isidore
if grep -q "^AllowUsers" /etc/ssh/sshd_config; then
    if ! grep -q "isidore" /etc/ssh/sshd_config; then
        echo "Adding isidore to AllowUsers..."
        sudo sed -i 's/^AllowUsers.*/& isidore/' /etc/ssh/sshd_config
        sudo systemctl restart sshd
        echo "sshd restarted with isidore in AllowUsers."
    else
        echo "isidore already in AllowUsers."
    fi
else
    echo "No AllowUsers directive found — skipping."
fi

# 3. Set up SSH authorized_keys for isidore (key must be passed separately)
sudo mkdir -p /home/isidore/.ssh
sudo chown isidore:isidore /home/isidore/.ssh
sudo chmod 700 /home/isidore/.ssh

# 4. Install Bun if not present for isidore
if ! sudo -u isidore bash -c 'command -v bun' &>/dev/null; then
    echo "Installing Bun for isidore..."
    sudo -u isidore bash -c 'curl -fsSL https://bun.sh/install | bash'
    echo "Bun installed."
else
    echo "Bun already installed for isidore."
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

# 6. Install Claude Code CLI for isidore
if ! sudo -u isidore bash -c 'command -v claude' &>/dev/null; then
    echo "Installing Claude Code CLI..."
    sudo -u isidore bash -c 'npm install -g @anthropic-ai/claude-code'
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
echo "  1. Copy isidore SSH public key to /home/isidore/.ssh/authorized_keys"
echo "  2. Test: ssh isidore 'whoami && sudo whoami'"
echo "  3. Authenticate Claude: ssh -L 7160:localhost:7160 isidore && claude /login"
echo "  4. Deploy PAI: rsync ~/.claude/ isidore:~/.claude/"
