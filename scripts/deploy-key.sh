#!/bin/bash
# deploy-key.sh — Deploy isidore SSH public key to VPS
# Run from local machine after isidore user is created
# Usage: bash scripts/deploy-key.sh

set -euo pipefail

KEY_FILE="$HOME/.ssh/id_ed25519_isidore.pub"
VPS_HOST="vps"  # Uses openclaw SSH alias

if [ ! -f "$KEY_FILE" ]; then
    echo "Error: Key file not found: $KEY_FILE"
    echo "Generate with: ssh-keygen -t ed25519 -C 'mj@isidore-vps' -f ~/.ssh/id_ed25519_isidore"
    exit 1
fi

echo "Deploying isidore SSH public key to VPS..."
PUBLIC_KEY=$(cat "$KEY_FILE")

ssh "$VPS_HOST" "sudo mkdir -p /home/isidore/.ssh && \
    echo '$PUBLIC_KEY' | sudo tee /home/isidore/.ssh/authorized_keys && \
    sudo chown -R isidore:isidore /home/isidore/.ssh && \
    sudo chmod 700 /home/isidore/.ssh && \
    sudo chmod 600 /home/isidore/.ssh/authorized_keys && \
    echo 'Key deployed successfully.'"

echo ""
echo "Testing SSH as isidore..."
ssh -o ConnectTimeout=10 -i "$HOME/.ssh/id_ed25519_isidore" isidore@213.199.32.18 'echo "SSH as isidore: OK" && whoami && sudo whoami'
