#!/bin/bash
# deploy-key.sh — Deploy isidore_cloud SSH public key to VPS
# Run from local machine after isidore_cloud user is created
# Usage: bash scripts/deploy-key.sh

set -euo pipefail

KEY_FILE="$HOME/.ssh/id_ed25519_isidore_cloud.pub"
VPS_HOST="vps"  # Uses openclaw SSH alias

if [ ! -f "$KEY_FILE" ]; then
    echo "Error: Key file not found: $KEY_FILE"
    echo "Generate with: ssh-keygen -t ed25519 -C 'mj@isidore-cloud-vps' -f ~/.ssh/id_ed25519_isidore_cloud"
    exit 1
fi

echo "Deploying isidore_cloud SSH public key to VPS..."
PUBLIC_KEY=$(cat "$KEY_FILE")

ssh "$VPS_HOST" "sudo mkdir -p /home/isidore_cloud/.ssh && \
    echo '$PUBLIC_KEY' | sudo tee /home/isidore_cloud/.ssh/authorized_keys && \
    sudo chown -R isidore_cloud:isidore_cloud /home/isidore_cloud/.ssh && \
    sudo chmod 700 /home/isidore_cloud/.ssh && \
    sudo chmod 600 /home/isidore_cloud/.ssh/authorized_keys && \
    echo 'Key deployed successfully.'"

echo ""
echo "Testing SSH as isidore_cloud..."
ssh -o ConnectTimeout=10 -i "$HOME/.ssh/id_ed25519_isidore_cloud" isidore_cloud@213.199.32.18 'echo "SSH as isidore_cloud: OK" && whoami && sudo whoami'
